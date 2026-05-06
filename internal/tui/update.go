package tui

import (
	"fmt"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"claude-monitor/internal/account"
	"claude-monitor/internal/api"
	"claude-monitor/internal/config"
	"claude-monitor/internal/format"
)

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		if m.editing {
			if next, cmd, consumed := m.handleEditKey(msg); consumed {
				return next, cmd
			}
		}
		if m.picking {
			if next, cmd, consumed := m.handlePickKey(msg); consumed {
				return next, cmd
			}
		}
		return m.handleKey(msg)

	case tickMsg:
		// Schedule the next tick + kick a refresh if one isn't already
		// in flight. We always re-arm the tick so the cadence stays
		// steady even when the user has just done a manual refresh.
		cmds := []tea.Cmd{tickCmd(config.RefreshIntervalSeconds)}
		if !m.refreshing {
			m.refreshing = true
			m.inflight++
			cmds = append(cmds, m.refreshCmd(m.inflight))
		}
		return m, tea.Batch(cmds...)

	case refreshMsg:
		// Whichever in-flight goroutine produced this message is now
		// done, so clear the refreshing flag regardless of whether
		// we end up applying the data. Without this, a manual swap
		// that bumps m.inflight (without kicking a new refresh) can
		// strand the flag at true forever — the next tick sees
		// m.refreshing and skips firing, refreshes stop entirely.
		m.refreshing = false
		// Discard results from a refresh that has been superseded by a
		// newer one (e.g. user mashed `r` while a tick was already in
		// flight, or a manual swap invalidated this refresh's view of
		// activeDir).
		if msg.version != m.inflight {
			return m, nil
		}
		m.rows = msg.rows
		m.activeDir = msg.activeDir
		m.err = msg.err
		m.lastRefresh = msg.at
		var swapCmd tea.Cmd
		if msg.swap != nil {
			m.lastSwap = msg.swap
			m.flash = msg.swap.String()
			m.flashExpiry = time.Now().Add(5 * time.Second)
			swapCmd = flashClearCmd(5 * time.Second)
		} else if msg.swapErr != nil {
			m.swapErr = msg.swapErr
			m.flash = "swap failed: " + format.Truncate(msg.swapErr.Error(), 80)
			m.flashExpiry = time.Now().Add(5 * time.Second)
			swapCmd = flashClearCmd(5 * time.Second)
		}
		// Update backoff state from the row results: 429 errors
		// arm/extend the window, while a successful row clears any
		// pre-existing backoff for that account (recovery path).
		// Also refresh prev-util so the next swap pass can detect
		// fresh window resets.
		next := make(map[string]float64, len(msg.rows))
		for _, r := range msg.rows {
			if r.ConfigDir == "" {
				continue
			}
			if rl, ok := r.Err.(*api.RateLimitError); ok {
				m.backoff[r.ConfigDir] = time.Now().Add(rl.RetryAfter)
				continue
			}
			if r.Err == nil && r.Usage != nil {
				delete(m.backoff, r.ConfigDir)
				next[r.ConfigDir] = account.FiveHourUtil(r.Usage)
			}
		}
		m.prevUtil = next
		// Auto-swap took over (or the active dir drifted out from
		// under us for any other reason) — the manual pin no longer
		// applies. Clearing here keeps the next decideSwap call
		// honest about whether rebalance-on-reset should fire.
		if m.manualPickDir != "" && m.activeDir != m.manualPickDir {
			m.manualPickDir = ""
			m.manualPickUtil = 0
		}
		// Keep the picker cursor in range when row count changes.
		if m.picking {
			m.clampPickCursor()
		}
		return m, swapCmd

	case manualSwapDoneMsg:
		m.manualSwapping = false
		if msg.err != nil {
			m.flash = "swap failed: " + format.Truncate(msg.err.Error(), 80)
			m.flashExpiry = time.Now().Add(5 * time.Second)
			return m, flashClearCmd(5 * time.Second)
		}
		m.activeDir = msg.targetDir
		m.manualPickDir = msg.targetDir
		m.manualPickUtil = msg.targetUtil
		// Drop the cached prev-util — the rebalance-on-reset detector
		// would otherwise compare across the swap boundary and emit
		// spurious "window reset" decisions.
		m.prevUtil = map[string]float64{}
		// Bump inflight to invalidate any pre-swap refresh that's
		// still mid-flight (otherwise its stale activeDir overwrites
		// ours, the pin gets auto-cleared, and the swap appears to
		// "revert" within a few seconds). We deliberately do NOT
		// kick a fresh refresh here — firing /api/oauth/usage right
		// after a swap empirically piles onto the just-promoted
		// account's rate-limit budget (it's already the busy one,
		// being actively used by `claude`) and triggers a 429 burst.
		// The next 60s tick refreshes naturally; util numbers can be
		// stale for up to a tick, which is fine.
		m.inflight++
		m.flash = fmt.Sprintf("swapped: %s → %s", msg.fromTag, msg.targetTag)
		m.flashExpiry = time.Now().Add(3 * time.Second)
		return m, flashClearCmd(3 * time.Second)

	case flashClearMsg:
		if time.Now().After(m.flashExpiry) {
			m.flash = ""
		}
		return m, nil

	case secondTickMsg:
		// Re-arm; the tick exists purely to force a re-render so live
		// countdowns advance. View() recomputes everything from state.
		return m, secondTickCmd()

	case updateCheckMsg:
		m.updateInfo = msg.info
		return m, nil

	case upgradeDoneMsg:
		m.upgrading = false
		if msg.err != nil {
			m.flash = "upgrade failed: " + format.Truncate(msg.err.Error(), 80)
			m.flashExpiry = time.Now().Add(5 * time.Second)
			return m, flashClearCmd(5 * time.Second)
		}
		// On Unix main() will syscall.Exec back into the new binary
		// after Quit tears down the alt-screen, so the user lands
		// straight back in the dashboard. The 1.2s flash is just long
		// enough for them to read the success line before the screen
		// flips to the new TUI.
		m.flash = fmt.Sprintf("✓ upgraded to %s — restarting…", msg.tag)
		m.flashExpiry = time.Now().Add(2 * time.Second)
		m.updateInfo = nil
		m.upgradeRestart = true
		return m, tea.Tick(1200*time.Millisecond, func(time.Time) tea.Msg { return upgradeQuitMsg{} })

	case upgradeQuitMsg:
		return m, tea.Quit
	}
	return m, nil
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c", "esc":
		return m, tea.Quit

	case "r":
		// Always trigger a brand-new refresh and bump the inflight
		// counter so any in-flight refresh's result will be discarded
		// when it returns. This makes the keypress feel instant: the
		// screen flips to "refreshing…" on the very next frame, even
		// when a tick-driven refresh was already in progress.
		m.refreshing = true
		m.inflight++
		m.flash = "refresh!"
		m.flashExpiry = time.Now().Add(800 * time.Millisecond)
		return m, tea.Batch(
			m.refreshCmd(m.inflight),
			flashClearCmd(800*time.Millisecond),
		)

	case "k":
		m.cfg.AutoKick = !m.cfg.AutoKick
		m.persistAndFlash(fmt.Sprintf("auto-kick: %s", onOff(m.cfg.AutoKick)))
		return m, flashClearCmd(2 * time.Second)

	case "s":
		m.cfg.AutoSwap = !m.cfg.AutoSwap
		// When toggling swap on/off, drop the cached prev-util so the
		// reset-rebalance trigger doesn't fire spuriously on the next
		// refresh based on stale data from the previous mode. Also
		// drop any manual pin: with AutoSwap off the pin is moot, and
		// turning it back on should start with a clean slate.
		m.prevUtil = map[string]float64{}
		m.manualPickDir = ""
		m.manualPickUtil = 0
		m.persistAndFlash(fmt.Sprintf("auto-swap: %s", onOff(m.cfg.AutoSwap)))
		return m, flashClearCmd(2 * time.Second)

	case "e":
		m.editing = !m.editing
		if !m.editing {
			m.editor = editorState{}
		}
		return m, nil

	case "m":
		// Manual account picker. Disabled while another mid-flight
		// swap is in progress so we don't queue racing keychain
		// writes against each other.
		if m.manualSwapping || len(m.rows) == 0 {
			return m, nil
		}
		m.picking = true
		m.pickCursor = m.indexOfActive()
		m.clampPickCursor()
		return m, nil

	case "u":
		// Visible-only hotkey: ignore unless an update is genuinely
		// available and we're not already mid-upgrade. The help bar
		// only advertises [u] when m.updateInfo != nil.
		if m.updateInfo == nil || m.upgrading {
			return m, nil
		}
		m.upgrading = true
		m.flash = "downloading " + m.updateInfo.LatestTag + "…"
		m.flashExpiry = time.Now().Add(150 * time.Second)
		return m, upgradeCmd(m.updateInfo)

	case "?":
		m.showHelp = !m.showHelp
		return m, nil
	}
	return m, nil
}

func (m *model) persistAndFlash(text string) {
	if err := config.Save(m.cfg); err != nil {
		m.flash = "save failed: " + err.Error()
	} else {
		m.flash = text
	}
	m.flashExpiry = time.Now().Add(2 * time.Second)
}
