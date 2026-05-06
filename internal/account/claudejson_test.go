package account

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestClaudeJSONPaths(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	defaultDir := filepath.Join(tmp, ".claude")

	// Default dir → 2 paths (in-dir, then $HOME/.claude.json).
	got := ClaudeJSONPaths(defaultDir)
	if len(got) != 2 {
		t.Fatalf("default dir paths = %v, want 2 entries", got)
	}
	if got[0] != filepath.Join(defaultDir, ".claude.json") {
		t.Errorf("first path = %q, want in-dir version", got[0])
	}
	if got[1] != filepath.Join(tmp, ".claude.json") {
		t.Errorf("second path = %q, want $HOME/.claude.json", got[1])
	}

	// Non-default dir → 1 path (in-dir only).
	other := filepath.Join(tmp, ".claude-gem")
	got = ClaudeJSONPaths(other)
	if len(got) != 1 {
		t.Fatalf("non-default paths = %v, want 1 entry", got)
	}
	if got[0] != filepath.Join(other, ".claude.json") {
		t.Errorf("path = %q, want in-dir", got[0])
	}
}

func TestEmailFromClaudeJSON(t *testing.T) {
	tmp := t.TempDir()
	tests := []struct {
		name    string
		content string
		want    string
	}{
		{"with space after colon", `{"oauthAccount":{"emailAddress": "user@example.com"}}`, "user@example.com"},
		{"no space after colon", `{"oauthAccount":{"emailAddress":"user@example.com"}}`, "user@example.com"},
		{"with surrounding whitespace", `{"oauthAccount":{ "emailAddress" : "u@e.com" }}`, "u@e.com"},
		{"missing field", `{"foo":"bar"}`, ""},
		{"empty file", "", ""},
		{"empty value", `{"emailAddress":""}`, ""},
		// Defensive: escaped `\"` inside the value must not be treated as
		// the closing quote. Realistically no email contains a quote, but
		// the parser must not silently truncate if one ever does.
		{"escaped quote inside value", `{"emailAddress":"a\"b@example.com"}`, `a\"b@example.com`},
		{"escaped backslash before quote", `{"emailAddress":"a\\","other":"x"}`, `a\\`},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := filepath.Join(tmp, "f"+string(rune('a'+i)))
			if err := os.WriteFile(p, []byte(tt.content), 0o600); err != nil {
				t.Fatalf("write: %v", err)
			}
			if got := emailFromClaudeJSON(p); got != tt.want {
				t.Errorf("emailFromClaudeJSON(%q) = %q, want %q", tt.content, got, tt.want)
			}
		})
	}

	// Missing file → empty string, no error.
	if got := emailFromClaudeJSON(filepath.Join(tmp, "nonexistent")); got != "" {
		t.Errorf("missing file returned %q, want empty", got)
	}
}

func TestReadEmailPriority(t *testing.T) {
	// The default-dir lookup tries in-dir first, then $HOME fallback.
	// Both present → in-dir wins.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	defaultDir := filepath.Join(tmp, ".claude")
	if err := os.MkdirAll(defaultDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	inDir := `{"oauthAccount":{"emailAddress":"in-dir@example.com"}}`
	homeDir := `{"oauthAccount":{"emailAddress":"home@example.com"}}`
	if err := os.WriteFile(filepath.Join(defaultDir, ".claude.json"), []byte(inDir), 0o600); err != nil {
		t.Fatalf("write in-dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".claude.json"), []byte(homeDir), 0o600); err != nil {
		t.Fatalf("write home: %v", err)
	}
	if got := ReadEmail(defaultDir); got != "in-dir@example.com" {
		t.Errorf("ReadEmail prefers in-dir: got %q, want in-dir@example.com", got)
	}

	// Only $HOME version present → falls back to it.
	if err := os.Remove(filepath.Join(defaultDir, ".claude.json")); err != nil {
		t.Fatalf("remove in-dir: %v", err)
	}
	if got := ReadEmail(defaultDir); got != "home@example.com" {
		t.Errorf("ReadEmail fallback: got %q, want home@example.com", got)
	}
}

func TestReadOAuthBlockFromFile(t *testing.T) {
	tmp := t.TempDir()

	// Field present.
	good := filepath.Join(tmp, "good.json")
	body := `{"oauthAccount":{"emailAddress":"a@b.com","accountUuid":"abc"}}`
	if err := os.WriteFile(good, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	block, err := ReadOAuthBlockFromFile(good)
	if err != nil {
		t.Fatalf("ReadOAuthBlockFromFile: %v", err)
	}
	if block == nil {
		t.Fatal("expected non-nil block")
	}
	// Re-decode and check email.
	var inner map[string]any
	if err := json.Unmarshal(block, &inner); err != nil {
		t.Fatalf("unmarshal block: %v", err)
	}
	if inner["emailAddress"] != "a@b.com" {
		t.Errorf("emailAddress in block = %v, want a@b.com", inner["emailAddress"])
	}

	// Field absent.
	missing := filepath.Join(tmp, "missing.json")
	if err := os.WriteFile(missing, []byte(`{"foo":"bar"}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	block, err = ReadOAuthBlockFromFile(missing)
	if err != nil {
		t.Errorf("expected nil error when oauthAccount missing, got %v", err)
	}
	if block != nil {
		t.Errorf("expected nil block when oauthAccount missing, got %s", string(block))
	}

	// Field is null.
	nullFld := filepath.Join(tmp, "null.json")
	if err := os.WriteFile(nullFld, []byte(`{"oauthAccount":null}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	block, err = ReadOAuthBlockFromFile(nullFld)
	if err != nil {
		t.Errorf("expected nil error on null oauthAccount, got %v", err)
	}
	if block != nil {
		t.Errorf("expected nil block when oauthAccount is null, got %s", string(block))
	}

	// Corrupt JSON.
	bad := filepath.Join(tmp, "bad.json")
	if err := os.WriteFile(bad, []byte(`not json`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := ReadOAuthBlockFromFile(bad); err == nil {
		t.Error("expected error on corrupt JSON")
	}

	// Missing file.
	if _, err := ReadOAuthBlockFromFile(filepath.Join(tmp, "nonexistent")); err == nil {
		t.Error("expected error on missing file")
	}
}

func TestPatchOAuthInFilePreservesOtherFields(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "claude.json")
	original := `{"numStartups": 42, "oauthAccount": {"emailAddress": "old@example.com"}, "projects": ["proj1"]}`
	if err := os.WriteFile(p, []byte(original), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	newBlock := json.RawMessage(`{"emailAddress":"new@example.com","accountUuid":"xyz"}`)
	if err := PatchOAuthInFile(p, newBlock); err != nil {
		t.Fatalf("PatchOAuthInFile: %v", err)
	}

	// Re-read and check.
	out, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var data map[string]any
	if err := json.Unmarshal(out, &data); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if data["numStartups"] != float64(42) {
		t.Errorf("numStartups changed: %v", data["numStartups"])
	}
	if _, ok := data["projects"]; !ok {
		t.Error("projects field lost")
	}
	oauth, ok := data["oauthAccount"].(map[string]any)
	if !ok {
		t.Fatalf("oauthAccount missing or wrong type: %v", data["oauthAccount"])
	}
	if oauth["emailAddress"] != "new@example.com" {
		t.Errorf("oauthAccount.emailAddress = %v, want new@example.com", oauth["emailAddress"])
	}

	// Mode preserved.
	info, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("file mode = %o, want 0600", mode)
	}
}

func TestPatchOAuthInFileNoOpWhenMissing(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "nonexistent.json")
	if err := PatchOAuthInFile(p, json.RawMessage(`{}`)); err != nil {
		t.Errorf("expected nil error on missing file, got %v", err)
	}
	if _, err := os.Stat(p); err == nil {
		t.Error("PatchOAuthInFile created the file (it shouldn't)")
	}
}

func TestWriteMinimalClaudeJSON(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "sub", "claude.json") // sub/ doesn't exist yet
	block := json.RawMessage(`{"emailAddress":"a@b.com"}`)
	if err := WriteMinimalClaudeJSON(p, block); err != nil {
		t.Fatalf("WriteMinimalClaudeJSON: %v", err)
	}

	// File exists, parent created.
	info, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("file mode = %o, want 0600", mode)
	}

	// Content is correct.
	out, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(out, &data); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(data) != 1 {
		t.Errorf("expected 1 top-level field, got %d: %v", len(data), data)
	}
	if _, ok := data["oauthAccount"]; !ok {
		t.Error("oauthAccount field missing")
	}
}

// TestWriteFileAtomic is not directly exported but its consumers
// (PatchOAuthInFile, WriteMinimalClaudeJSON) above already validate
// the rename + mode behavior. This test pins the no-leftover invariant:
// after a write, no .tmp.* files remain in the parent directory.
func TestWriteFileAtomicNoLeftovers(t *testing.T) {
	tmp := t.TempDir()
	p := filepath.Join(tmp, "f.json")
	if err := WriteMinimalClaudeJSON(p, json.RawMessage(`{}`)); err != nil {
		t.Fatalf("WriteMinimalClaudeJSON: %v", err)
	}
	entries, err := os.ReadDir(tmp)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if e.Name() == "f.json" {
			continue
		}
		t.Errorf("leftover file in temp dir: %q", e.Name())
	}
}
