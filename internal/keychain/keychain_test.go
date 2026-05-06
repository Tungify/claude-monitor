package keychain

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServiceForDeterministic(t *testing.T) {
	// Same input → same output across calls (sha256 is deterministic).
	s1 := ServiceFor("/Users/x/.claude-foo")
	s2 := ServiceFor("/Users/x/.claude-foo")
	if s1 != s2 {
		t.Errorf("ServiceFor not deterministic: %q vs %q", s1, s2)
	}
}

func TestServiceForFormat(t *testing.T) {
	got := ServiceFor("/Users/x/.claude-foo")
	if !strings.HasPrefix(got, PlainServiceName+"-") {
		t.Errorf("ServiceFor missing prefix: %q", got)
	}
	suffix := strings.TrimPrefix(got, PlainServiceName+"-")
	if len(suffix) != 8 {
		t.Errorf("hash suffix length = %d, want 8: %q", len(suffix), suffix)
	}
	for _, r := range suffix {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			t.Errorf("non-hex char in suffix: %q", suffix)
			break
		}
	}
}

func TestServiceForTrailingSeparatorNormalized(t *testing.T) {
	a := ServiceFor("/Users/x/.claude-foo")
	b := ServiceFor("/Users/x/.claude-foo/")
	c := ServiceFor("/Users/x/.claude-foo//")
	if a != b || a != c {
		t.Errorf("ServiceFor not normalizing trailing separators: %q / %q / %q", a, b, c)
	}
}

func TestServiceForRelativePathToAbsolute(t *testing.T) {
	// Relative input gets absolutized; same dir from cwd vs absolute should match.
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	rel := "."
	abs := wd
	if ServiceFor(rel) != ServiceFor(abs) {
		t.Errorf("relative vs absolute disagreement: %q vs %q", ServiceFor(rel), ServiceFor(abs))
	}
}

func TestExpired(t *testing.T) {
	tests := []struct {
		name string
		c    OAuthCreds
		want bool
	}{
		{"zero ExpiresAt is not expired", OAuthCreds{}, false},
		{"future ExpiresAt is not expired", OAuthCreds{ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}, false},
		{"past ExpiresAt is expired", OAuthCreds{ExpiresAt: time.Now().Add(-time.Hour).UnixMilli()}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.c.Expired(); got != tt.want {
				t.Errorf("Expired() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestCandidatesPriority(t *testing.T) {
	// Default dir → plain first, hashed second.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	defaultDir := filepath.Join(tmp, ".claude")

	got := candidates(defaultDir)
	if len(got) != 2 {
		t.Fatalf("default dir candidates = %v, want 2", got)
	}
	if got[0] != PlainServiceName {
		t.Errorf("default first = %q, want %q", got[0], PlainServiceName)
	}
	if got[1] != ServiceFor(defaultDir) {
		t.Errorf("default second = %q, want %q", got[1], ServiceFor(defaultDir))
	}

	// Non-default dir → hashed first, plain second.
	other := filepath.Join(tmp, ".claude-gem")
	got = candidates(other)
	if len(got) != 2 {
		t.Fatalf("non-default candidates = %v, want 2", got)
	}
	if got[0] != ServiceFor(other) {
		t.Errorf("non-default first = %q, want %q", got[0], ServiceFor(other))
	}
	if got[1] != PlainServiceName {
		t.Errorf("non-default second = %q, want %q", got[1], PlainServiceName)
	}
}

// TestDefaultClaudeDirMatchesAccountPackage protects the comment in
// keychain.go: defaultClaudeDir() is duplicated from account.DefaultDir.
// If one is changed without the other, this test catches it. We call
// defaultClaudeDir() directly here (same package) and replicate the
// account package's logic.
func TestDefaultClaudeDirMatchesExpected(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	want := filepath.Join(tmp, ".claude")
	if got := defaultClaudeDir(); got != want {
		t.Errorf("defaultClaudeDir() = %q, want %q (must match account.DefaultDir)", got, want)
	}
}

func TestLoadFromFileSuccess(t *testing.T) {
	tmp := t.TempDir()
	envelope := credsEnvelope{ClaudeAiOauth: OAuthCreds{
		AccessToken:  "access",
		RefreshToken: "refresh",
		ExpiresAt:    1234567890,
		Scopes:       []string{"a", "b"},
	}}
	b, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".credentials.json"), b, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	creds, err := loadFromFile(tmp)
	if err != nil {
		t.Fatalf("loadFromFile: %v", err)
	}
	if creds.AccessToken != "access" {
		t.Errorf("AccessToken = %q, want access", creds.AccessToken)
	}
	if creds.RefreshToken != "refresh" {
		t.Errorf("RefreshToken = %q, want refresh", creds.RefreshToken)
	}
	if creds.ExpiresAt != 1234567890 {
		t.Errorf("ExpiresAt = %d, want 1234567890", creds.ExpiresAt)
	}
	if len(creds.Scopes) != 2 {
		t.Errorf("Scopes = %v, want 2 entries", creds.Scopes)
	}
}

func TestLoadFromFileMissing(t *testing.T) {
	tmp := t.TempDir()
	if _, err := loadFromFile(tmp); err == nil {
		t.Error("expected error for missing .credentials.json")
	}
}

func TestLoadFromFileMalformedJSON(t *testing.T) {
	tmp := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmp, ".credentials.json"), []byte("not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := loadFromFile(tmp); err == nil {
		t.Error("expected error for malformed JSON")
	}
}

func TestLoadFromFileNoToken(t *testing.T) {
	tmp := t.TempDir()
	body := `{"claudeAiOauth":{"refreshToken":"r"}}` // no accessToken
	if err := os.WriteFile(filepath.Join(tmp, ".credentials.json"), []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, err := loadFromFile(tmp)
	if err == nil {
		t.Error("expected error when accessToken is empty")
	}
	if !strings.Contains(err.Error(), "no access token") {
		t.Errorf("err = %q, want substring 'no access token'", err)
	}
}

func TestPlainServiceNameConstant(t *testing.T) {
	// Pin the constant so a typo in the rename doesn't silently break
	// every existing user's keychain entry.
	if PlainServiceName != "Claude Code-credentials" {
		t.Errorf("PlainServiceName = %q, want %q", PlainServiceName, "Claude Code-credentials")
	}
}
