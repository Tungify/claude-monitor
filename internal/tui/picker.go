package tui

import (
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"claude-monitor/internal/account"
)

// handlePickKey is the inner mode active while the [m] manual-swap
// picker is open. Up/Down move the cursor, Enter executes the swap
// against the highlighted row, Esc/m close the picker. Returns
// consumed=true so dashboard hotkeys don't fire under the picker.
func (m model) handlePickKey(msg tea.KeyMsg) (model, tea.Cmd, bool) {
	switch msg.String() {
	case "esc", "m", "q":
		m.picking = false
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
		// Don't gate on row.RefreshToken here — a row may have an
		// empty refreshToken because the API call was skipped (rate-
		// limit backoff) or failed transiently, even though the
		// underlying keychain entry is fine. swap.Execute reads the
		// target's creds fresh from the keychain at swap time and
		// will return a real error if they're genuinely missing.
		if target.ConfigDir == m.activeDir {
			// Picking the row that's already active is a no-op but
			// also the natural "set this as my pin" gesture — record
			// it so rebalance-on-reset is suppressed going forward.
			m.manualPickDir = target.ConfigDir
			m.manualPickUtil = account.FiveHourUtil(target.Usage)
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
