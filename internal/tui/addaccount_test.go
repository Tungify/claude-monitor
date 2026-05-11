package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"claude-monitor/internal/account"
)

// runeKey synthesizes a printable-character keystroke. Bubble Tea
// dispatches printable input via msg.Type=KeyRunes + msg.Runes; the
// helper just keeps the call sites readable.
func runeKey(r rune) tea.KeyMsg {
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}}
}

func TestHandleAddKeyTypingPopulatesNameAndPreviewsValidation(t *testing.T) {
	// Cursor explicitly on Name — the [a] hotkey in update.go now
	// opens the form with the cursor on the name field (skipping past
	// the provider toggle, which most users won't change). Tests
	// build the same starting state directly.
	m := model{addingAccount: true, addState: addState{cursor: addFieldName}}
	for _, r := range []rune{'a', '/', 'b'} {
		next, _, consumed := m.handleAddKey(runeKey(r))
		if !consumed {
			t.Fatalf("rune %q should be consumed", r)
		}
		m = next
	}
	if m.addState.nameBuf != "a/b" {
		t.Errorf("nameBuf = %q, want %q", m.addState.nameBuf, "a/b")
	}
	if m.addState.nameErr == "" {
		t.Errorf("expected validation error after typing slash, got empty")
	}
}

func TestHandleAddKeyTabAdvancesToEmail(t *testing.T) {
	m := model{addingAccount: true, addState: addState{cursor: addFieldName}}
	next, _, _ := m.handleAddKey(tea.KeyMsg{Type: tea.KeyTab})
	if next.addState.cursor != addFieldEmail {
		t.Errorf("after tab cursor = %v, want %v", next.addState.cursor, addFieldEmail)
	}
	next, _, _ = next.handleAddKey(runeKey('x'))
	if next.addState.emailBuf != "x" {
		t.Errorf("emailBuf = %q, want %q", next.addState.emailBuf, "x")
	}
	if next.addState.nameBuf != "" {
		t.Errorf("nameBuf leaked: %q", next.addState.nameBuf)
	}
}

func TestHandleAddKeyEscClosesForm(t *testing.T) {
	m := model{addingAccount: true, addState: addState{nameBuf: "foo"}}
	next, _, consumed := m.handleAddKey(tea.KeyMsg{Type: tea.KeyEsc})
	if !consumed {
		t.Fatalf("esc must be consumed")
	}
	if next.addingAccount {
		t.Errorf("addingAccount should be cleared")
	}
	if next.addState.nameBuf != "" {
		t.Errorf("addState should be reset, got nameBuf=%q", next.addState.nameBuf)
	}
}

func TestSubmitInvalidNameSurfacesError(t *testing.T) {
	m := model{addingAccount: true, addState: addState{cursor: addFieldName}}
	m.addState.nameBuf = ""
	next, cmd, _ := m.submitAddAccount()
	if cmd != nil {
		t.Errorf("expected no cmd on invalid submit, got %v", cmd)
	}
	if !next.addingAccount {
		t.Errorf("form should stay open on validation failure")
	}
	if !strings.Contains(next.addState.nameErr, "required") {
		t.Errorf("expected 'required' error, got %q", next.addState.nameErr)
	}
}

func TestHandleKeyAOpensAddFormWhenIdle(t *testing.T) {
	m := model{}
	next, _ := m.handleKey(runeKey('a'))
	mm := next.(model)
	if !mm.addingAccount {
		t.Errorf("[a] should open add form when idle")
	}
}

func TestHandleKeyARefusedDuringOtherOverlays(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*model)
	}{
		{"editing", func(m *model) { m.editing = true }},
		{"picking", func(m *model) { m.picking = true }},
		{"manualSwapping", func(m *model) { m.manualSwapping = true }},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			m := model{}
			tt.mut(&m)
			next, _ := m.handleKey(runeKey('a'))
			mm := next.(model)
			if mm.addingAccount {
				t.Errorf("[a] should be blocked while %s", tt.name)
			}
		})
	}
}

func TestHandleKeyLOpensReloginPicker(t *testing.T) {
	m := model{rows: []account.Row{{Name: "foo", ConfigDir: "/tmp/foo"}}}
	next, _ := m.handleKey(runeKey('L'))
	mm := next.(model)
	if !mm.picking {
		t.Errorf("[L] should open picker")
	}
	if mm.pickerMode != pickerRelogin {
		t.Errorf("[L] should set pickerMode=relogin, got %v", mm.pickerMode)
	}
}

// TestAddFormProviderToggle exercises the two ways to flip provider:
// arrow keys (← / →) and single-letter shortcuts (a / o).
func TestAddFormProviderToggle(t *testing.T) {
	m := model{addingAccount: true, addState: addState{cursor: addFieldProvider}}

	// Right-arrow flips from anthropic (default) → openai.
	next, _, _ := m.handleAddKey(tea.KeyMsg{Type: tea.KeyRight})
	if next.addState.providerOrDefault() != account.ProviderOpenAI {
		t.Errorf("after KeyRight on provider, got %q, want openai", next.addState.providerOrDefault())
	}

	// Left-arrow flips back.
	next, _, _ = next.handleAddKey(tea.KeyMsg{Type: tea.KeyLeft})
	if next.addState.providerOrDefault() != account.ProviderAnthropic {
		t.Errorf("after KeyLeft, got %q, want anthropic", next.addState.providerOrDefault())
	}

	// 'o' on the provider row jumps directly to openai without
	// touching nameBuf (this is the regression the test guards
	// against — if the provider-row branch leaks into the text
	// append, typing 'o' would also write 'o' to nameBuf).
	next, _, _ = next.handleAddKey(runeKey('o'))
	if next.addState.providerOrDefault() != account.ProviderOpenAI {
		t.Errorf("after 'o', got %q, want openai", next.addState.providerOrDefault())
	}
	if next.addState.nameBuf != "" {
		t.Errorf("nameBuf should not capture 'o' from provider row, got %q", next.addState.nameBuf)
	}

	// On the Name row, 'o' is just a character.
	onName := next
	onName.addState.cursor = addFieldName
	onName, _, _ = onName.handleAddKey(runeKey('o'))
	if onName.addState.nameBuf != "o" {
		t.Errorf("on name row, 'o' should append to nameBuf, got %q", onName.addState.nameBuf)
	}
}

func TestHandleKeyMOpensSwapPicker(t *testing.T) {
	m := model{rows: []account.Row{{Name: "foo", ConfigDir: "/tmp/foo"}}}
	next, _ := m.handleKey(runeKey('m'))
	mm := next.(model)
	if !mm.picking {
		t.Errorf("[m] should open picker")
	}
	if mm.pickerMode != pickerSwap {
		t.Errorf("[m] should set pickerMode=swap, got %v", mm.pickerMode)
	}
}
