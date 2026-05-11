package tui

import (
	"fmt"
	"strings"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/config"
	"claude-monitor/internal/format"
)

func (m model) View() string {
	var b strings.Builder
	st := newStyles(true)

	b.WriteString(m.header(st))
	b.WriteString("\n")
	b.WriteString(m.table(st))
	b.WriteString(m.peakLine(st))
	switch {
	case m.addingAccount:
		b.WriteString("\n")
		b.WriteString(m.addAccountView(st))
	case m.editing:
		b.WriteString("\n")
		b.WriteString(m.editorView(st))
	case m.picking, m.showHelp:
		// Picker mode forces the help bar on so the picker controls
		// are always visible regardless of the [?] toggle.
		b.WriteString("\n")
		b.WriteString(m.helpBar(st))
	}
	return b.String()
}

func (m model) header(st styles) string {
	title := st.title.Render("claude-monitor")
	now := time.Now()

	var status string
	switch {
	case m.refreshing && m.lastRefresh.IsZero():
		status = st.dim.Render("loading…")
	case m.refreshing:
		status = st.accent.Render("refreshing…")
	case m.err != nil:
		status = st.errText.Render("error: " + m.err.Error())
	default:
		ago := now.Sub(m.lastRefresh).Truncate(time.Second)
		next := time.Duration(config.RefreshIntervalSeconds)*time.Second - ago
		if next < 0 {
			next = 0
		}
		status = st.dim.Render(fmt.Sprintf(
			"refreshed %s ago   next in %s   accounts: %d",
			ago, next.Truncate(time.Second), len(m.rows),
		))
	}

	flash := ""
	if m.flash != "" && time.Now().Before(m.flashExpiry) {
		flash = "   " + st.flash.Render(m.flash)
	}

	// Update banner sits between header and flash so it stays visible
	// even when transient flashes come and go.
	upd := ""
	switch {
	case m.upgrading:
		upd = "   " + st.accent.Render("upgrading…")
	case m.updateInfo != nil:
		upd = "   " + st.warn.Render(fmt.Sprintf("⬆ %s available — press [u]", m.updateInfo.LatestTag))
	}

	return st.headerBar.Render(title+"   "+status) + upd + flash
}

func (m model) table(st styles) string {
	if m.err != nil && len(m.rows) == 0 {
		return st.errText.Render("⚠ "+m.err.Error()) + "\n"
	}
	if len(m.rows) == 0 {
		return st.dim.Render("no accounts yet — fetching…\n")
	}

	bw := 25 // bar width
	header := []string{"ACCOUNT", "5H", "RESETS", "WEEKLY", "RESETS", "SONNET WK", "OPUS WK"}
	widths := []int{22, 8 + bw + 1, 10, 8 + bw + 1, 10, 9, 9}

	var b strings.Builder
	b.WriteString(writeCols(header, widths, &st.colHeader))
	b.WriteString(st.divider.Render(strings.Repeat("─", sumWidths(widths)+(len(widths)-1)*2)))
	b.WriteString("\n")

	now := time.Now()
	for i, r := range m.rows {
		// Live-countdown override: even if the row carries an old
		// "rate limited" error string, prefer the deadline from the
		// backoff map so the seconds tick down on screen.
		if until, ok := m.backoff[r.ConfigDir]; ok && now.Before(until) {
			remaining := until.Sub(now).Round(time.Second)
			label := m.decorateLabel(st, i, r, account.Label(r))
			msg := fmt.Sprintf("rate limited (retry in %s)", remaining)
			line := padRight(st.colHeader.Render(label), widths[0]) +
				"  " + st.warn.Render(msg)
			b.WriteString(line)
			b.WriteString("\n")
			continue
		}
		// Same live-countdown trick for refresh-source 429s. Distinct
		// map because refreshBackoff doesn't gate fetchOne — only the
		// rendered countdown.
		if until, ok := m.refreshBackoff[r.ConfigDir]; ok && now.Before(until) {
			remaining := until.Sub(now).Round(time.Second)
			label := m.decorateLabel(st, i, r, account.Label(r))
			msg := fmt.Sprintf("refresh rate limited (retry in %s)", remaining)
			line := padRight(st.colHeader.Render(label), widths[0]) +
				"  " + st.warn.Render(msg)
			b.WriteString(line)
			b.WriteString("\n")
			continue
		}
		if r.Err != nil {
			label := m.decorateLabel(st, i, r, account.Label(r))
			line := padRight(st.colHeader.Render(label), widths[0]) +
				"  " + st.errText.Render(format.Truncate(r.Err.Error(), m.width-widths[0]-4))
			b.WriteString(line)
			b.WriteString("\n")
			continue
		}
		if r.Provider == account.ProviderOpenAI && r.Usage == nil {
			// Fallback path: token is valid but /wham/usage hasn't
			// produced a snapshot yet (fresh login on the previous
			// tick, transient network blip, etc.). Surface plan +
			// token-expiry so the row still answers the secondary
			// question — "which account is this and when does its
			// token refresh?" — even when quota bars aren't available.
			label := m.decorateLabel(st, i, r, account.Label(r))
			plan := r.PlanType
			if plan == "" {
				plan = "chatgpt"
			} else {
				plan = "chatgpt:" + plan
			}
			expStr := "refresh: —"
			if !r.TokenExpiresAt.IsZero() {
				delta := time.Until(r.TokenExpiresAt).Round(time.Minute)
				switch {
				case delta < 0:
					expStr = st.warn.Render("token expired")
				case delta < time.Minute:
					expStr = "refresh soon"
				case delta < time.Hour:
					expStr = fmt.Sprintf("refresh in %dm", int(delta.Minutes()))
				case delta < 24*time.Hour:
					expStr = fmt.Sprintf("refresh in %dh%02dm", int(delta.Hours()), int(delta.Minutes())%60)
				default:
					days := int(delta.Hours()) / 24
					expStr = fmt.Sprintf("refresh in %dd", days)
				}
			}
			line := padRight(st.colHeader.Render(label), widths[0]) +
				"  " + padRight(st.account.Render(plan), 14) +
				"  " + st.dim.Render(expStr)
			b.WriteString(line)
			b.WriteString("\n")
			continue
		}
		u := r.Usage
		cells := []string{
			st.account.Render(m.decorateLabel(st, i, r, account.Label(r))),
			renderBarPct(st, account.FiveHourUtil(u), bw),
			renderResetsAt(st, getResets(u.FiveHour), now),
			renderBarPct(st, getUtil(u.SevenDay), bw),
			renderResetsAt(st, getResets(u.SevenDay), now),
			renderPctOnly(st, u.SevenDaySonnet),
			renderPctOnly(st, u.SevenDayOpus),
		}
		row := writeCols(cells, widths, nil)
		// trim trailing newline from writeCols so we can append the kick suffix
		row = strings.TrimRight(row, "\n")
		if r.Kicked {
			row += "  " + st.kicked.Render("[kicked]")
		} else if r.KickErr != nil {
			row += "  " + st.errText.Render("[kick failed: "+format.Truncate(r.KickErr.Error(), 60)+"]")
		}
		b.WriteString(row)
		b.WriteString("\n")
	}
	b.WriteString(st.divider.Render(strings.Repeat("─", sumWidths(widths)+(len(widths)-1)*2)))
	b.WriteString("\n")
	return b.String()
}

func (m model) peakLine(st styles) string {
	var peak5h, peakWk float64
	have := 0
	for _, r := range m.rows {
		if r.Err != nil || r.Usage == nil {
			continue
		}
		have++
		if u := account.FiveHourUtil(r.Usage); u > peak5h {
			peak5h = u
		}
		if u := getUtil(r.Usage.SevenDay); u > peakWk {
			peakWk = u
		}
	}
	if have == 0 {
		return ""
	}
	return st.peak.Render(fmt.Sprintf(
		"PEAK across %d account(s):  5h %s   weekly %s",
		have, fmtPct(peak5h), fmtPct(peakWk),
	)) + "\n"
}

func (m model) helpBar(st styles) string {
	if m.picking {
		verb := "swap to"
		if m.pickerMode == pickerRelogin {
			verb = "relogin"
		}
		hint := fmt.Sprintf("%s %s   %s confirm   %s cancel",
			st.key.Render("↑/↓"), verb, st.key.Render("[enter]"), st.key.Render("[esc]"))
		if m.pickCursor >= 0 && m.pickCursor < len(m.rows) {
			label := account.Label(m.rows[m.pickCursor])
			hint = st.accent.Render("▶ "+label) + "   " + hint
		}
		return st.helpBar.Render(hint)
	}
	parts := []string{
		fmt.Sprintf("%s auto-kick: %s", st.key.Render("[k]"), boolBadge(st, m.cfg.AutoKick)),
		fmt.Sprintf("%s auto-swap: %s", st.key.Render("[s]"), boolBadge(st, m.cfg.AutoSwap)),
		st.key.Render("[m]") + " switch",
		st.key.Render("[a]") + " add",
		st.key.Render("[L]") + " relogin",
		st.key.Render("[e]") + " edit",
		st.key.Render("[r]") + " refresh",
		st.key.Render("[?]") + " toggle help",
		st.key.Render("[q]") + " quit",
	}
	// [o] only makes sense when the orchestrator URL is known.
	if m.webURL != "" {
		// Insert just before [q] so the most-quitted key stays last.
		parts = append(parts[:len(parts)-1],
			append([]string{st.key.Render("[o]") + " open web"}, parts[len(parts)-1])...)
	}
	// [u] is intentionally hidden when no update is advertised; surface
	// it (prepended so it leads the row) only when update.Check
	// returned a non-nil Info.
	if m.updateInfo != nil && !m.upgrading {
		parts = append([]string{
			fmt.Sprintf("%s upgrade %s", st.key.Render("[u]"), m.updateInfo.LatestTag),
		}, parts...)
	}
	// Pin indicator: when a manual pick is in effect, surface its
	// label so the user remembers why their high-util account isn't
	// being auto-rebalanced away.
	if m.manualPickDir != "" {
		if r := account.FindRow(m.rows, m.manualPickDir); r != nil {
			parts = append(parts, st.accent.Render("📌 pin: "+account.Label(*r)))
		}
	}
	return st.helpBar.Render(strings.Join(parts, "   "))
}

// decorateLabel prefixes a marker to the label of whichever row is
// noteworthy: ▶ for the [m] picker cursor, ★ for the row that owns
// the active credential slot (per provider — Anthropic's plain
// keychain entry, or Codex's ~/.codex/auth.json file). When the
// active row is also a manual pin, ★ is rendered in the accent color
// instead of the kicked color so the user can see at a glance that
// auto-rebalance is suppressed.
func (m model) decorateLabel(st styles, idx int, r account.Row, label string) string {
	if m.picking && idx == m.pickCursor {
		return st.accent.Render("▶ ") + label
	}
	isActive := r.ConfigDir != "" && (r.ConfigDir == m.activeDir || r.ConfigDir == m.codexActiveDir)
	if isActive {
		marker := st.kicked.Render("★ ")
		if r.ConfigDir == m.manualPickDir {
			marker = st.accent.Render("★ ")
		}
		return marker + label
	}
	return "  " + label
}
