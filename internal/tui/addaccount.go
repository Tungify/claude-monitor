package tui

import (
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"claude-monitor/internal/account"
	"claude-monitor/internal/codex"
)

// addField identifies one row in the [a] add-account form.
type addField int

const (
	addFieldProvider addField = iota
	addFieldName
	addFieldEmail
	addFieldCount
)

// addState lives on the model while [a] is open. Provider toggle plus
// two text buffers (name + email), a cursor, and a sticky validation
// error rendered next to the offending field. Mirrors editorState's
// text-buffer pattern so the two forms read alike.
type addState struct {
	cursor   addField
	provider account.Provider
	nameBuf  string
	emailBuf string
	// nameErr is the live validation result for nameBuf — recomputed on
	// every keystroke and rendered next to the name field. Cosmetic
	// feedback so the user sees red text the moment they type a slash;
	// the submit path re-checks via Provision.
	nameErr string
	// submitErr is set after a failed submission attempt (mkdir failed,
	// dir already exists). Cleared on next keystroke.
	submitErr string
}

// handleAddKey is the inner mode active while the [a] overlay is open.
// Returns consumed=true so dashboard hotkeys don't fire under it.
func (m model) handleAddKey(msg tea.KeyMsg) (model, tea.Cmd, bool) {
	switch msg.Type {
	case tea.KeyEsc:
		m.addingAccount = false
		m.addState = addState{}
		return m, nil, true
	case tea.KeyTab, tea.KeyDown:
		m.addState.cursor = (m.addState.cursor + 1) % addFieldCount
		return m, nil, true
	case tea.KeyShiftTab, tea.KeyUp:
		m.addState.cursor = (m.addState.cursor - 1 + addFieldCount) % addFieldCount
		return m, nil, true
	case tea.KeyLeft, tea.KeyRight:
		// Provider toggle: ← / → flip the value when the cursor is on
		// the provider row. No-op on text fields (their cursor doesn't
		// move horizontally — the buffer is append-only at the end).
		if m.addState.cursor == addFieldProvider {
			m.addState.toggleProvider()
			m.addState.recomputeNameErr()
		}
		return m, nil, true
	case tea.KeyEnter:
		// Enter from any field submits — UX matches the editor's
		// thresholds text mode where Enter commits regardless of cursor.
		return m.submitAddAccount()
	case tea.KeyBackspace, tea.KeyCtrlH:
		m.addState.submitErr = ""
		m.addState.eraseAtCursor()
		m.addState.recomputeNameErr()
		return m, nil, true
	case tea.KeyRunes:
		m.addState.submitErr = ""
		// Provider row: a/A picks Anthropic, o/O picks OpenAI. Single
		// keystroke is faster than ← / → for users who know what they
		// want.
		if m.addState.cursor == addFieldProvider {
			switch string(msg.Runes) {
			case "a", "A":
				m.addState.provider = account.ProviderAnthropic
				m.addState.recomputeNameErr()
				return m, nil, true
			case "o", "O":
				m.addState.provider = account.ProviderOpenAI
				m.addState.recomputeNameErr()
				return m, nil, true
			}
		}
		m.addState.appendAtCursor(string(msg.Runes))
		m.addState.recomputeNameErr()
		return m, nil, true
	case tea.KeySpace:
		// Spaces typed into the name field will fail ValidateName, but
		// we still let the rune through so the user sees what they
		// typed and the inline error explains why submission is blocked.
		// On the provider row, space toggles (same as ← / →).
		if m.addState.cursor == addFieldProvider {
			m.addState.toggleProvider()
			m.addState.recomputeNameErr()
			return m, nil, true
		}
		m.addState.submitErr = ""
		m.addState.appendAtCursor(" ")
		m.addState.recomputeNameErr()
		return m, nil, true
	}
	return m, nil, true
}

// submitAddAccount validates the name, mkdirs the config dir, then
// emits the login command. The provider toggle picks the right
// validator + Provision + login binary pair. Email is forwarded to
// claude as --email so the web flow pre-populates the field; codex
// ignores it (its OAuth provider prompts for the account itself).
func (m model) submitAddAccount() (model, tea.Cmd, bool) {
	name := strings.TrimSpace(m.addState.nameBuf)
	provider := m.addState.providerOrDefault()

	switch provider {
	case account.ProviderOpenAI:
		if err := codex.ValidateName(name); err != nil {
			m.addState.nameErr = err.Error()
			m.addState.cursor = addFieldName
			return m, nil, true
		}
		dir, err := codex.Provision(name)
		if err != nil {
			m.addState.submitErr = err.Error()
			return m, nil, true
		}
		m.addingAccount = false
		m.addState = addState{}
		m.loggingIn = true
		m.flash = "logging in: codex " + name + "…"
		m.flashExpiry = time.Now().Add(24 * time.Hour)
		return m, codexLoginCmd(dir, name, true), true
	default:
		if err := account.ValidateName(name); err != nil {
			m.addState.nameErr = err.Error()
			m.addState.cursor = addFieldName
			return m, nil, true
		}
		dir, err := account.Provision(name)
		if err != nil {
			m.addState.submitErr = err.Error()
			return m, nil, true
		}
		email := strings.TrimSpace(m.addState.emailBuf)
		m.addingAccount = false
		m.addState = addState{}
		m.loggingIn = true
		// Long-lived flash because the OAuth dance is interactive —
		// the user might step away. loginDoneMsg replaces it on
		// completion.
		m.flash = "logging in: " + name + "…"
		m.flashExpiry = time.Now().Add(24 * time.Hour)
		return m, loginCmd(dir, email, name, true), true
	}
}

// toggleProvider flips between Anthropic and OpenAI. The default
// (zero value, "") is treated as Anthropic; the first toggle therefore
// switches to OpenAI, matching the form's "press space to switch"
// expectation.
func (s *addState) toggleProvider() {
	if s.providerOrDefault() == account.ProviderOpenAI {
		s.provider = account.ProviderAnthropic
	} else {
		s.provider = account.ProviderOpenAI
	}
}

// providerOrDefault returns the addState's provider, defaulting to
// Anthropic when unset. Used everywhere that needs to read the choice
// — keeps the zero-value semantics aligned with the rest of the
// codebase (Provider="" → anthropic).
func (s *addState) providerOrDefault() account.Provider {
	if s.provider == account.ProviderOpenAI {
		return account.ProviderOpenAI
	}
	return account.ProviderAnthropic
}

func (s *addState) currentBuf() *string {
	if s.cursor == addFieldName {
		return &s.nameBuf
	}
	return &s.emailBuf
}

func (s *addState) appendAtCursor(r string) {
	buf := s.currentBuf()
	*buf += r
}

func (s *addState) eraseAtCursor() {
	buf := s.currentBuf()
	if len(*buf) == 0 {
		return
	}
	r := []rune(*buf)
	*buf = string(r[:len(r)-1])
}

func (s *addState) recomputeNameErr() {
	name := strings.TrimSpace(s.nameBuf)
	if name == "" {
		// Don't nag while the field is still empty — the user just
		// opened the form. The submit path re-checks.
		s.nameErr = ""
		return
	}
	if err := account.ValidateName(name); err != nil {
		s.nameErr = err.Error()
		return
	}
	s.nameErr = ""
}

// addAccountView renders the form panel in place of the help bar while
// [a] is open.
func (m model) addAccountView(st styles) string {
	var b strings.Builder
	b.WriteString(st.title.Render("add account"))
	b.WriteString("\n")

	b.WriteString(m.renderProviderRow(st, m.addState.providerOrDefault()))
	b.WriteString("\n")
	b.WriteString(m.renderAddRow(st, addFieldName, "short name", m.addState.nameBuf, m.addState.nameErr))
	b.WriteString("\n")
	// Codex login doesn't accept --email, so label the field
	// accordingly when OpenAI is selected. We keep the field visible
	// (and tab-stop active) so the cursor cycle stays predictable; the
	// label is the honest documentation that the value will be ignored.
	emailLabel := "email (optional)"
	if m.addState.providerOrDefault() == account.ProviderOpenAI {
		emailLabel = "email (ignored for openai)"
	}
	b.WriteString(m.renderAddRow(st, addFieldEmail, emailLabel, m.addState.emailBuf, ""))
	b.WriteString("\n")

	// Preview the resolved config dir so the user sees where the new
	// account will live before hitting enter. Pattern follows the
	// chosen provider: ~/.claude-<name> vs ~/.codex-<name>.
	name := strings.TrimSpace(m.addState.nameBuf)
	provider := m.addState.providerOrDefault()
	placeholder := "~/.claude-<name>"
	if provider == account.ProviderOpenAI {
		placeholder = "~/.codex-<name>"
	}
	preview := "  " + padRight("config dir", 22)
	switch {
	case name == "" || m.addState.nameErr != "":
		preview += st.dim.Render(placeholder)
	default:
		var (
			dir string
			err error
		)
		if provider == account.ProviderOpenAI {
			dir, err = codex.ConfigDirForName(name)
		} else {
			dir, err = account.ConfigDirForName(name)
		}
		if err == nil {
			preview += st.value.Render(homeAbbrev(dir))
		} else {
			preview += st.dim.Render(placeholder)
		}
	}
	b.WriteString(preview)
	b.WriteString("\n")

	if m.addState.submitErr != "" {
		b.WriteString(st.errText.Render("⚠ " + m.addState.submitErr))
		b.WriteString("\n")
	}

	b.WriteString(st.dim.Render("tab move   ←→/space toggle   enter submit   esc cancel"))
	return st.helpBar.Render(b.String())
}

// renderProviderRow draws the provider toggle in the form. Highlights
// the focused entry like the text-field rows; ← / → / space cycle the
// value, and 'a' / 'o' jump directly when the cursor is on this row.
func (m model) renderProviderRow(st styles, current account.Provider) string {
	pad := "  "
	if m.addState.cursor == addFieldProvider {
		pad = st.key.Render("➤ ")
	}
	anth := "anthropic"
	op := "openai"
	if current == account.ProviderOpenAI {
		anth = st.dim.Render(anth)
		op = st.accent.Render("[" + op + "]")
	} else {
		anth = st.accent.Render("[" + anth + "]")
		op = st.dim.Render(op)
	}
	return pad + padRight("provider", 22) + anth + "  " + op
}

func (m model) renderAddRow(st styles, f addField, label, val, fieldErr string) string {
	pad := "  "
	if m.addState.cursor == f {
		pad = st.key.Render("➤ ")
	}
	var display string
	switch {
	case m.addState.cursor == f:
		display = st.accent.Render(val + "▌")
	case val == "":
		display = st.dim.Render("(empty)")
	default:
		display = st.value.Render(val)
	}
	row := pad + padRight(label, 22) + display
	if fieldErr != "" {
		row += "   " + st.errText.Render("("+fieldErr+")")
	}
	return row
}

// homeAbbrev replaces the user's home prefix with "~" so the preview
// stays readable in the helpBar. Cosmetic — the actual mkdir uses the
// absolute path.
func homeAbbrev(dir string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return dir
	}
	if strings.HasPrefix(dir, home+"/") {
		return "~" + dir[len(home):]
	}
	if dir == home {
		return "~"
	}
	return dir
}
