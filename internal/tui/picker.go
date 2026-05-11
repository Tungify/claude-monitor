package tui

import (
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"claude-monitor/internal/account"
)

// handlePickKey is the inner mode active while the picker overlay is
// open. Up/Down move the cursor, Enter executes the action for the
// current pickerMode (swap vs relogin), Esc closes. Returns
// consumed=true so dashboard hotkeys don't fire under the picker.
//
// "m" closes the picker only when it was opened via [m] (swap mode);
// "L" closes it only when opened via [L]. This avoids a confusing
// scenario where the user opened relogin with [L], hits [m] thinking
// "open swap" and instead just dismisses the overlay.
func (m model) handlePickKey(msg tea.KeyMsg) (model, tea.Cmd, bool) {
	switch msg.String() {
	case "esc", "q":
		m.picking = false
		return m, nil, true
	case "m":
		if m.pickerMode == pickerSwap {
			m.picking = false
		}
		return m, nil, true
	case "L":
		if m.pickerMode == pickerRelogin {
			m.picking = false
		}
		return m, nil, true
	case "up", "k":
		if len(m.rows) == 0 {
			return m, nil, true
		}
		m.pickCursor = (m.pickCursor - 1 + len(m.rows)) % len(m.rows)
		return m, nil, true
	case "down", "j", "tab":
		if len(m.rows) == 0 {
			return m, nil, true
		}
		m.pickCursor = (m.pickCursor + 1) % len(m.rows)
		return m, nil, true
	case "home", "g":
		m.pickCursor = 0
		return m, nil, true
	case "end", "G":
		if len(m.rows) > 0 {
			m.pickCursor = len(m.rows) - 1
		}
		return m, nil, true
	case "enter", " ":
		if m.pickCursor < 0 || m.pickCursor >= len(m.rows) {
			return m, nil, true
		}
		target := m.rows[m.pickCursor]
		if m.pickerMode == pickerRelogin {
			m.picking = false
			m.loggingIn = true
			m.flash = "relogin: " + account.Label(target) + "…"
			m.flashExpiry = time.Now().Add(24 * time.Hour)
			// Provider-aware relogin: an OpenAI row reauths via
			// `codex login`, an Anthropic row via `claude auth login`.
			// loginCmd / codexLoginCmd share the loginDoneMsg shape so
			// the post-completion refresh hook fires uniformly.
			if target.Provider == account.ProviderOpenAI {
				return m, codexLoginCmd(target.ConfigDir, account.Label(target), false), true
			}
			return m, loginCmd(target.ConfigDir, target.Email, account.Label(target), false), true
		}
		// Don't gate on row.RefreshToken here — a row may have an
		// empty refreshToken because the API call was skipped (rate-
		// limit backoff) or failed transiently, even though the
		// underlying keychain entry is fine. swap.Execute reads the
		// target's creds fresh from the keychain at swap time and
		// will return a real error if they're genuinely missing.
		//
		// Provider-aware active comparison: an Anthropic row is "the
		// active one" when its dir owns the plain keychain slot; an
		// OpenAI row is active when its dir owns ~/.codex/auth.json.
		activeForTarget := m.activeDir
		if target.Provider == account.ProviderOpenAI {
			activeForTarget = m.codexActiveDir
		}
		if target.ConfigDir == activeForTarget {
			// Picking the row that's already active is a no-op but
			// also the natural "set this as my pin" gesture — record
			// it so rebalance-on-reset is suppressed going forward.
			m.manualPickDir = target.ConfigDir
			m.manualPickUtil = account.EffectiveUtil(target.Usage)
			m.picking = false
			m.flash = "pinned: " + account.Label(target)
			m.flashExpiry = time.Now().Add(2 * time.Second)
			return m, flashClearCmd(2 * time.Second), true
		}
		m.picking = false
		m.manualSwapping = true
		m.flash = "swapping → " + account.Label(target) + "…"
		m.flashExpiry = time.Now().Add(10 * time.Second)
		return m, m.manualSwapCmd(target), true
	}
	// Number keys jump the cursor to that row index (1-based for
	// keyboard ergonomics; row 1 is the first account).
	if s := msg.String(); len(s) == 1 && s[0] >= '1' && s[0] <= '9' {
		idx := int(s[0] - '1')
		if idx < len(m.rows) {
			m.pickCursor = idx
		}
		return m, nil, true
	}
	return m, nil, true
}

func (m *model) clampPickCursor() {
	if len(m.rows) == 0 {
		m.pickCursor = 0
		return
	}
	if m.pickCursor < 0 {
		m.pickCursor = 0
	}
	if m.pickCursor >= len(m.rows) {
		m.pickCursor = len(m.rows) - 1
	}
}

func (m model) indexOfActive() int {
	for i, r := range m.rows {
		if r.ConfigDir == m.activeDir {
			return i
		}
	}
	return 0
}
