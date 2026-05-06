package tui

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"claude-monitor/internal/config"
)

// editField identifies one row in the config form. Order matches the
// vertical layout drawn by editorView.
type editField int

const (
	fieldAutoKick editField = iota
	fieldAutoSwap
	fieldPickOrder
	fieldRebalance
	fieldThresholds
	fieldCount
)

// editorState lives on the model when [e] is active. It tracks which
// field has the cursor and, when the user is text-editing the
// thresholds value, the typed buffer.
type editorState struct {
	cursor   editField
	textMode bool   // true while typing into the thresholds field
	textBuf  string // working buffer while textMode
	textErr  string // last validation error, cleared on next keypress
}

// handleEditKey routes keypresses while [e] is active. It returns the
// updated model, an optional Cmd, and a bool indicating whether the
// keypress was consumed (callers should *not* fall through to the
// dashboard hotkey handler when consumed=true).
func (m model) handleEditKey(msg tea.KeyMsg) (model, tea.Cmd, bool) {
	if m.editor.textMode {
		return m.handleEditTextKey(msg)
	}
	switch msg.String() {
	case "esc", "e":
		m.editing = false
		m.editor = editorState{}
		return m, nil, true
	case "up", "k":
		m.editor.cursor = (m.editor.cursor - 1 + fieldCount) % fieldCount
		return m, nil, true
	case "down", "j", "tab":
		m.editor.cursor = (m.editor.cursor + 1) % fieldCount
		return m, nil, true
	case "left", "h":
		return m.adjustField(-1)
	case "right", "l", " ":
		return m.adjustField(+1)
	case "enter":
		// Enter is the value-toggle for boolean/cycle rows; for the
		// thresholds row it drops into text-edit mode.
		if m.editor.cursor == fieldThresholds {
			m.editor.textMode = true
			m.editor.textBuf = thresholdsToString(m.cfg.SwapThresholds)
			m.editor.textErr = ""
			return m, nil, true
		}
		return m.adjustField(+1)
	}
	return m, nil, true // swallow other keys so dashboard hotkeys don't fire under the form
}

// handleEditTextKey is the inner mode active while the user types a new
// thresholds value. Enter commits (after validation), Esc reverts.
func (m model) handleEditTextKey(msg tea.KeyMsg) (model, tea.Cmd, bool) {
	switch msg.Type {
	case tea.KeyEsc:
		m.editor.textMode = false
		m.editor.textBuf = ""
		m.editor.textErr = ""
		return m, nil, true
	case tea.KeyEnter:
		parsed, err := parseThresholds(m.editor.textBuf)
		if err != nil {
			m.editor.textErr = err.Error()
			return m, nil, true
		}
		m.cfg.SwapThresholds = parsed
		m.editor.textMode = false
		m.editor.textBuf = ""
		m.editor.textErr = ""
		m.persistAndFlash(fmt.Sprintf("thresholds: %s", thresholdsToString(parsed)))
		return m, flashClearCmd(2 * time.Second), true
	case tea.KeyBackspace, tea.KeyCtrlH:
		if len(m.editor.textBuf) > 0 {
			m.editor.textBuf = m.editor.textBuf[:len(m.editor.textBuf)-1]
		}
		m.editor.textErr = ""
		return m, nil, true
	case tea.KeyRunes:
		m.editor.textBuf += string(msg.Runes)
		m.editor.textErr = ""
		return m, nil, true
	case tea.KeySpace:
		m.editor.textBuf += " "
		m.editor.textErr = ""
		return m, nil, true
	}
	return m, nil, true
}

// adjustField applies a left (-1) or right (+1) step to the field
// under the cursor and persists the change. dir for booleans is "flip"
// regardless of sign, since there are only two values.
func (m model) adjustField(dir int) (model, tea.Cmd, bool) {
	switch m.editor.cursor {
	case fieldAutoKick:
		m.cfg.AutoKick = !m.cfg.AutoKick
		m.persistAndFlash(fmt.Sprintf("auto-kick: %s", onOff(m.cfg.AutoKick)))
	case fieldAutoSwap:
		m.cfg.AutoSwap = !m.cfg.AutoSwap
		m.prevUtil = map[string]float64{}
		m.persistAndFlash(fmt.Sprintf("auto-swap: %s", onOff(m.cfg.AutoSwap)))
	case fieldPickOrder:
		if m.cfg.PickOrder == config.PickOrderLowest {
			m.cfg.PickOrder = config.PickOrderHighest
		} else {
			m.cfg.PickOrder = config.PickOrderLowest
		}
		m.persistAndFlash(fmt.Sprintf("pick order: %s", m.cfg.PickOrder))
	case fieldRebalance:
		m.cfg.RebalanceOnReset = !m.cfg.RebalanceOnReset
		m.persistAndFlash(fmt.Sprintf("rebalance on reset: %s", onOff(m.cfg.RebalanceOnReset)))
	case fieldThresholds:
		// Right-arrow / Enter on this field drops to text mode rather
		// than mutating in place — handled in handleEditKey.
		return m, nil, true
	}
	return m, flashClearCmd(2 * time.Second), true
}

// editorView renders the full-width form panel that replaces the help
// bar while editing. Each field is one line; the cursor row is bold +
// highlighted and shows hint text on the right.
func (m model) editorView(st styles) string {
	var b strings.Builder
	b.WriteString(st.title.Render("settings"))
	b.WriteString("\n")
	for i := editField(0); i < fieldCount; i++ {
		b.WriteString(m.renderEditRow(st, i))
		b.WriteString("\n")
	}
	hint := "↑/↓ move   ←/→ change   enter to edit thresholds   esc/e to close"
	if m.editor.textMode {
		hint = "type comma-separated percents (0-100)   enter to save   esc to cancel"
	}
	b.WriteString(st.dim.Render(hint))
	return st.helpBar.Render(b.String())
}

func (m model) renderEditRow(st styles, f editField) string {
	label, value := m.fieldLabelAndValue(st, f)
	pad := "  "
	if m.editor.cursor == f {
		pad = st.key.Render("➤ ")
	}
	row := pad + padRight(label, 22) + value
	if m.editor.cursor == f && f == fieldThresholds && m.editor.textErr != "" {
		row += "   " + st.errText.Render("("+m.editor.textErr+")")
	}
	return row
}

func (m model) fieldLabelAndValue(st styles, f editField) (string, string) {
	switch f {
	case fieldAutoKick:
		return "auto-kick:", boolBadge(st, m.cfg.AutoKick)
	case fieldAutoSwap:
		return "auto-swap:", boolBadge(st, m.cfg.AutoSwap)
	case fieldPickOrder:
		return "pick order:", st.value.Render(m.cfg.PickOrder)
	case fieldRebalance:
		return "rebalance on reset:", boolBadge(st, m.cfg.RebalanceOnReset)
	case fieldThresholds:
		val := thresholdsToString(m.cfg.SwapThresholds)
		if m.editor.cursor == fieldThresholds && m.editor.textMode {
			val = st.accent.Render(m.editor.textBuf + "▌")
		} else {
			val = st.value.Render(val)
		}
		return "swap thresholds (%):", val
	}
	return "", ""
}

func thresholdsToString(ts []float64) string {
	parts := make([]string, len(ts))
	for i, t := range ts {
		if t == float64(int(t)) {
			parts[i] = strconv.Itoa(int(t))
		} else {
			parts[i] = strconv.FormatFloat(t, 'f', -1, 64)
		}
	}
	return strings.Join(parts, ", ")
}

// parseThresholds turns user-typed text like "80, 95, 100" into the
// sanitized cascade. It rejects empty inputs and any value outside
// [0, 100] so the user gets immediate feedback rather than a silent
// clamp inside Save.
func parseThresholds(s string) ([]float64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("at least one value")
	}
	var out []float64
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		v, err := strconv.ParseFloat(part, 64)
		if err != nil {
			return nil, fmt.Errorf("not a number: %q", part)
		}
		if v < 0 || v > 100 {
			return nil, fmt.Errorf("out of range 0-100: %v", v)
		}
		out = append(out, v)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("at least one value")
	}
	return config.SanitizeThresholds(out), nil
}
