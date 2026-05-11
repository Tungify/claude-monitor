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

// TestNeedsRefresh covers the proactive-refresh boundary used by
// fetchOne to stagger the morning cohort. Skew shifts the "expired"
// window forward by that duration: a token with 4 minutes of life left
// is treated as needing refresh under skew=5min, but not under
// skew=0 (which is just Expired() semantics).
func TestNeedsRefresh(t *testing.T) {
	now := time.Now()
	tests := []struct {
		name string
		c    OAuthCreds
		skew time.Duration
		want bool
	}{
		{"zero ExpiresAt never needs refresh",
			OAuthCreds{}, 5 * time.Minute, false},
		{"fresh token with 1h left, skew 5min",
			OAuthCreds{ExpiresAt: now.Add(time.Hour).UnixMilli()}, 5 * time.Minute, false},
		{"token with 4min left, skew 5min — needs proactive refresh",
			OAuthCreds{ExpiresAt: now.Add(4 * time.Minute).UnixMilli()}, 5 * time.Minute, true},
		{"token with 6min left, skew 5min — still fresh",
			OAuthCreds{ExpiresAt: now.Add(6 * time.Minute).UnixMilli()}, 5 * time.Minute, false},
		{"already expired, skew 0 — same as Expired()",
			OAuthCreds{ExpiresAt: now.Add(-time.Hour).UnixMilli()}, 0, true},
		{"already expired, skew 5min — still true",
			OAuthCreds{ExpiresAt: now.Add(-time.Hour).UnixMilli()}, 5 * time.Minute, true},
		{"skew 0 reproduces Expired() semantics on fresh token",
			OAuthCreds{ExpiresAt: now.Add(time.Hour).UnixMilli()}, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.c.NeedsRefresh(tt.skew); got != tt.want {
				t.Errorf("NeedsRefresh(%s) = %v, want %v (ExpiresAt=%dms from now)",
					tt.skew, got, tt.want, tt.c.ExpiresAt-now.UnixMilli())
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

	// Non-default dir → hashed entry ONLY. Plain is intentionally NOT a
	// fallback: it represents whoever is currently active, and after a
	// swap that's a different account than this row. Falling back to
	// plain would silently render the active account's data in an
	// unrelated row whose hashed entry happens to be missing.
	other := filepath.Join(tmp, ".claude-gem")
	got = candidates(other)
	if len(got) != 1 {
		t.Fatalf("non-default candidates = %v, want 1 (hashed only)", got)
	}
	if got[0] != ServiceFor(other) {
		t.Errorf("non-default = %q, want %q", got[0], ServiceFor(other))
	}
}

// TestHashedFirstCandidatesNoPlainFallback locks in the same invariant
// for the hashed-first read path (used when AutoSwap is on). The default
// dir keeps {hashed, plain} because plain is the legitimate location
// for default's creds on a pristine install. Non-default dirs get the
// hashed entry only.
func TestHashedFirstCandidatesNoPlainFallback(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	defaultDir := filepath.Join(tmp, ".claude")
	other := filepath.Join(tmp, ".claude-gem")

	def := hashedFirstCandidates(defaultDir)
	if len(def) != 2 || def[0] != ServiceFor(defaultDir) || def[1] != PlainServiceName {
		t.Errorf("default hashed-first = %v, want [hashed, plain]", def)
	}

	nonDef := hashedFirstCandidates(other)
	if len(nonDef) != 1 || nonDef[0] != ServiceFor(other) {
		t.Errorf("non-default hashed-first = %v, want [hashed]", nonDef)
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

// TestLoadCredentialsForSwapTargetFileFallback covers the Linux failure
// mode where libsecret doesn't have the target's hashed entry (headless
// box, locked keyring, WSL, account migrated from another host) but
// Claude Code did write <configDir>/.credentials.json. Without the file
// fallback, every swap to that account fails with
// `read target creds: secret-tool lookup ...: exit status 1`.
func TestLoadCredentialsForSwapTargetFileFallback(t *testing.T) {
	tmp := t.TempDir()
	body := `{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1700000000000,"scopes":["x"]}}`
	if err := os.WriteFile(filepath.Join(tmp, ".credentials.json"), []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	// tmp's hashed service name will not exist in the test runner's real
	// keychain — that's the scenario we want to exercise.
	creds, err := LoadCredentialsForSwapTarget(tmp)
	if err != nil {
		t.Fatalf("LoadCredentialsForSwapTarget: %v", err)
	}
	if creds.AccessToken != "a" || creds.RefreshToken != "r" {
		t.Errorf("creds = %+v, want access=a refresh=r", creds)
	}
}

// TestRoundTripPreservesRateLimitTier guards the OAuthCreds JSON tags
// against a regression that previously stripped rateLimitTier on every
// read-write cycle. Claude Code uses that field (and the embedded
// clientId on newer logins) to skip the post-refresh profile-lookup
// request — without it, every refresh fired an extra /api/oauth call,
// which on a machine doing frequent auto-swaps was enough to trip the
// IP rate limiter into 429s.
//
// We pin the round-trip against the actual envelope shape Claude Code
// 2.1.132 writes: {accessToken, refreshToken, expiresAt, scopes,
// subscriptionType, rateLimitTier, clientId}. If a future field gets
// added there, this test will keep passing for the legacy fields and
// the new field needs its own assertion.
func TestRoundTripPreservesRateLimitTier(t *testing.T) {
	src := `{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1700000000000,"scopes":["x"],"subscriptionType":"team","rateLimitTier":"default_claude_max_5x","clientId":"c-123"}}`
	var env credsEnvelope
	if err := json.Unmarshal([]byte(src), &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.ClaudeAiOauth.RateLimitTier != "default_claude_max_5x" {
		t.Errorf("RateLimitTier = %q, want default_claude_max_5x", env.ClaudeAiOauth.RateLimitTier)
	}
	if env.ClaudeAiOauth.ClientID != "c-123" {
		t.Errorf("ClientID = %q, want c-123", env.ClaudeAiOauth.ClientID)
	}
	out, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(out), `"rateLimitTier":"default_claude_max_5x"`) {
		t.Errorf("round-trip dropped rateLimitTier; got %s", out)
	}
	if !strings.Contains(string(out), `"clientId":"c-123"`) {
		t.Errorf("round-trip dropped clientId; got %s", out)
	}
}
