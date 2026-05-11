package codex

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// makeJWT builds a fake unsigned JWT with the given claims. Tests don't
// need a valid signature because ParseIDToken intentionally skips
// verification (it mirrors Codex's own behavior).
func makeJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	payload := base64.RawURLEncoding.EncodeToString(body)
	return header + "." + payload + ".sig"
}

func TestParseIDToken(t *testing.T) {
	exp := time.Now().Add(time.Hour).Unix()
	jwt := makeJWT(t, map[string]any{
		"sub":   "user_abc123",
		"email": "tung@example.com",
		"exp":   exp,
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id":         "acct_xyz",
			"chatgpt_plan_type":          "plus",
			"chatgpt_user_id":            "u_123",
			"chatgpt_account_is_fedramp": false,
		},
	})
	claims, err := ParseIDToken(jwt)
	if err != nil {
		t.Fatalf("ParseIDToken: %v", err)
	}
	if claims.Email != "tung@example.com" {
		t.Errorf("Email = %q, want tung@example.com", claims.Email)
	}
	if claims.Subject != "user_abc123" {
		t.Errorf("Subject = %q, want user_abc123", claims.Subject)
	}
	if claims.ExpiresAt.Unix() != exp {
		t.Errorf("ExpiresAt = %v, want unix=%d", claims.ExpiresAt, exp)
	}
	if claims.ChatGPTAccountID != "acct_xyz" {
		t.Errorf("ChatGPTAccountID = %q, want acct_xyz", claims.ChatGPTAccountID)
	}
	if claims.ChatGPTPlanType != "plus" {
		t.Errorf("ChatGPTPlanType = %q, want plus", claims.ChatGPTPlanType)
	}
	if claims.ChatGPTUserID != "u_123" {
		t.Errorf("ChatGPTUserID = %q, want u_123", claims.ChatGPTUserID)
	}
	if claims.IsFedRAMP {
		t.Errorf("IsFedRAMP = true, want false")
	}
}

func TestParseIDTokenErrors(t *testing.T) {
	cases := []struct {
		name  string
		token string
	}{
		{"empty", ""},
		{"no dots", "abcdef"},
		{"one dot", "abc.def"},
		{"bad payload", "abc.@@.sig"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := ParseIDToken(c.token); err == nil {
				t.Errorf("ParseIDToken(%q) returned no error", c.token)
			}
		})
	}
}

func TestLoadAndSaveRoundTrip(t *testing.T) {
	dir := t.TempDir()
	jwt := makeJWT(t, map[string]any{
		"email": "tung@example.com",
		"exp":   time.Now().Add(time.Hour).Unix(),
	})
	original := &AuthJSON{
		OpenAIAPIKey: "sk-test-abc",
		Tokens: &Tokens{
			IDToken:      jwt,
			AccessToken:  "access-1",
			RefreshToken: "refresh-1",
			AccountID:    "acct_xyz",
		},
		LastRefresh: "2026-05-11T10:00:00Z",
		AuthMode:    "ChatGPT",
		Extra:       json.RawMessage(`{"future_field":"keep me"}`),
	}
	if err := Save(dir, original); err != nil {
		t.Fatalf("Save: %v", err)
	}
	// Verify on-disk file has 0600 perms (matches Codex's own behavior
	// — sensitive plaintext storage).
	info, err := os.Stat(filepath.Join(dir, AuthFileName))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("auth.json perms = %o, want 0600", perm)
	}
	loaded, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.OpenAIAPIKey != original.OpenAIAPIKey {
		t.Errorf("OpenAIAPIKey = %q, want %q", loaded.OpenAIAPIKey, original.OpenAIAPIKey)
	}
	if loaded.Tokens == nil || loaded.Tokens.AccessToken != "access-1" {
		t.Errorf("Tokens.AccessToken = %v, want access-1", loaded.Tokens)
	}
	if loaded.LastRefresh != original.LastRefresh {
		t.Errorf("LastRefresh = %q, want %q", loaded.LastRefresh, original.LastRefresh)
	}
	if loaded.AuthMode != original.AuthMode {
		t.Errorf("AuthMode = %q, want %q", loaded.AuthMode, original.AuthMode)
	}
	// Extra fields must round-trip — a future Codex version writing
	// new keys mustn't have those silently stripped by a swap rewrite.
	if !strings.Contains(string(loaded.Extra), "future_field") {
		t.Errorf("Extra dropped future_field: %s", loaded.Extra)
	}
}

func TestLoadMissingFile(t *testing.T) {
	dir := t.TempDir()
	_, err := Load(dir)
	if err == nil {
		t.Fatalf("Load on missing dir returned nil error")
	}
	if !os.IsNotExist(err) {
		t.Errorf("err = %v, want os.IsNotExist", err)
	}
}

func TestLooksLikeCodexDir(t *testing.T) {
	dir := t.TempDir()
	if LooksLikeCodexDir(dir) {
		t.Errorf("empty dir flagged as codex dir")
	}
	if err := os.WriteFile(filepath.Join(dir, AuthFileName), []byte("{}"), 0o600); err != nil {
		t.Fatalf("write auth.json: %v", err)
	}
	if !LooksLikeCodexDir(dir) {
		t.Errorf("dir with auth.json not flagged as codex dir")
	}
}

func TestExpiryAndNeedsRefresh(t *testing.T) {
	// JWT with exp far in the future → not expired, no refresh needed
	// with any reasonable skew.
	farFuture := makeJWT(t, map[string]any{
		"exp": time.Now().Add(2 * time.Hour).Unix(),
	})
	a := &AuthJSON{Tokens: &Tokens{IDToken: farFuture}}
	if a.Expired() {
		t.Errorf("future-exp token reported Expired")
	}
	if a.NeedsRefresh(time.Minute) {
		t.Errorf("future-exp token (2h) reported NeedsRefresh(1m)")
	}
	if !a.NeedsRefresh(3 * time.Hour) {
		t.Errorf("future-exp token (2h) didn't report NeedsRefresh(3h) — skew should overlap exp")
	}

	// Expired token.
	expired := makeJWT(t, map[string]any{
		"exp": time.Now().Add(-time.Hour).Unix(),
	})
	b := &AuthJSON{Tokens: &Tokens{IDToken: expired}}
	if !b.Expired() {
		t.Errorf("past-exp token didn't report Expired")
	}

	// JWT missing exp → no expiry known → never NeedsRefresh.
	noExp := makeJWT(t, map[string]any{
		"email": "x@y.com",
	})
	c := &AuthJSON{Tokens: &Tokens{IDToken: noExp}}
	if c.NeedsRefresh(0) {
		t.Errorf("no-exp token reported NeedsRefresh — should default to false")
	}
}
