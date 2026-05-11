// Package codex reads and writes the OpenAI Codex CLI's auth.json
// files. Codex (https://github.com/openai/codex) stores its ChatGPT
// subscription credentials in plaintext at $CODEX_HOME/auth.json
// (default ~/.codex/auth.json) — no OS keychain involvement, which is
// the opposite of how Claude Code stores its Anthropic OAuth tokens.
//
// This package exposes just enough to (a) discover and identify
// per-directory Codex accounts, (b) refresh their tokens against
// auth.openai.com, and (c) rotate the active-slot file when the user
// swaps among multiple ~/.codex* directories. The live quota probe
// lives in internal/api/openai_usage.go (FetchCodexUsage), which calls
// codex's own GET /wham/usage endpoint — the same one codex's /status
// slash command uses — so the monitor can render 5h + weekly bars for
// Codex accounts without burning quota the way a /responses round-trip
// would.
package codex

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// AuthFileName is the basename Codex reads from $CODEX_HOME. Stable
// across versions; lifted from codex-rs/login/src/auth/storage.rs.
const AuthFileName = "auth.json"

// AuthJSON mirrors the on-disk shape of $CODEX_HOME/auth.json that
// Codex itself serializes. Only fields the monitor reads or rewrites
// are modeled — extra keys round-trip via Extra so a write doesn't
// strip fields Codex added in a newer version. (Mirrors the same
// keychain-envelope-drift discipline used on the Anthropic side.)
type AuthJSON struct {
	OpenAIAPIKey string          `json:"OPENAI_API_KEY,omitempty"`
	Tokens       *Tokens         `json:"tokens,omitempty"`
	LastRefresh  string          `json:"last_refresh,omitempty"`
	AuthMode     string          `json:"auth_mode,omitempty"`
	Extra        json.RawMessage `json:"-"`
}

// Tokens is the inner credential bundle. All three JWTs are present
// for ChatGPT-subscription auth; only `OPENAI_API_KEY` is set for the
// API-key auth mode (which the monitor ignores — that's not what the
// "subscription account" workflow needs).
type Tokens struct {
	IDToken      string `json:"id_token,omitempty"`
	AccessToken  string `json:"access_token,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	AccountID    string `json:"account_id,omitempty"`
}

// IDTokenClaims is the subset of an id_token JWT's payload the monitor
// surfaces. The Codex-specific fields live under the
// "https://api.openai.com/auth" namespace in the JWT.
type IDTokenClaims struct {
	Email     string
	Subject   string
	ExpiresAt time.Time

	// Codex-specific claims (under "https://api.openai.com/auth").
	ChatGPTAccountID string
	ChatGPTPlanType  string
	ChatGPTUserID    string
	IsFedRAMP        bool
}

// DefaultDir returns ~/.codex on the current user's home directory —
// Codex's no-CODEX_HOME default location. Empty string when home isn't
// resolvable (matches the Anthropic side's DefaultDir convention).
func DefaultDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex")
}

// LooksLikeCodexDir reports whether a directory looks like a Codex
// config dir. The marker check is intentionally narrower than
// looksLikeClaudeDir's: we only count files Codex writes that Claude
// Code does NOT, otherwise dirs like ~/.claude (which have sessions/
// and history/ subdirs) collide with the Codex shape and get
// misclassified as OpenAI.
//
// auth.json is Codex's plaintext credential store, and config.toml is
// Codex's user-config file — neither has any analog in Claude Code's
// per-account layout. A freshly-created Codex dir won't have either
// yet, but discovery only needs to surface authenticated accounts
// (the [a] add-account flow provisions a new dir via `codex login`
// rather than scanning bare directories), so the narrower check is
// the right trade.
func LooksLikeCodexDir(path string) bool {
	for _, marker := range []string{AuthFileName, "config.toml"} {
		if _, err := os.Stat(filepath.Join(path, marker)); err == nil {
			return true
		}
	}
	return false
}

// Load parses the auth.json inside dir. Returns os.ErrNotExist when
// the file is missing (caller should treat that as "not authenticated").
// Other errors are wrapped with the absolute path so log lines are
// diagnosable without re-deriving the location.
func Load(dir string) (*AuthJSON, error) {
	p := filepath.Join(dir, AuthFileName)
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	return parse(b, p)
}

// LoadFile is the absolute-path variant; used by detection logic that
// needs to peek at $CODEX_HOME/auth.json without knowing which dir owns
// it.
func LoadFile(path string) (*AuthJSON, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parse(b, path)
}

func parse(b []byte, path string) (*AuthJSON, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	a := &AuthJSON{}
	if v, ok := raw["OPENAI_API_KEY"]; ok {
		_ = json.Unmarshal(v, &a.OpenAIAPIKey)
		delete(raw, "OPENAI_API_KEY")
	}
	if v, ok := raw["tokens"]; ok {
		var t Tokens
		if err := json.Unmarshal(v, &t); err != nil {
			return nil, fmt.Errorf("decode tokens in %s: %w", path, err)
		}
		a.Tokens = &t
		delete(raw, "tokens")
	}
	if v, ok := raw["last_refresh"]; ok {
		_ = json.Unmarshal(v, &a.LastRefresh)
		delete(raw, "last_refresh")
	}
	if v, ok := raw["auth_mode"]; ok {
		_ = json.Unmarshal(v, &a.AuthMode)
		delete(raw, "auth_mode")
	}
	if len(raw) > 0 {
		buf, err := json.Marshal(raw)
		if err == nil {
			a.Extra = buf
		}
	}
	return a, nil
}

// Save writes the auth.json atomically (write-temp + rename), matching
// the same 0600 permissions Codex uses. Extra fields captured at Load
// time are merged back so a write doesn't silently drop unknown keys.
func Save(dir string, a *AuthJSON) error {
	return SaveFile(filepath.Join(dir, AuthFileName), a)
}

// SaveFile is the absolute-path variant used by the swap layer to
// rewrite $CODEX_HOME/auth.json directly.
func SaveFile(path string, a *AuthJSON) error {
	out, err := encode(a)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	return writeFileAtomic(path, out, 0o600)
}

func encode(a *AuthJSON) ([]byte, error) {
	merged := map[string]json.RawMessage{}
	if len(a.Extra) > 0 {
		if err := json.Unmarshal(a.Extra, &merged); err != nil {
			return nil, fmt.Errorf("decode extra fields: %w", err)
		}
	}
	if a.OpenAIAPIKey != "" {
		v, _ := json.Marshal(a.OpenAIAPIKey)
		merged["OPENAI_API_KEY"] = v
	} else {
		delete(merged, "OPENAI_API_KEY")
	}
	if a.Tokens != nil {
		v, err := json.Marshal(a.Tokens)
		if err != nil {
			return nil, fmt.Errorf("encode tokens: %w", err)
		}
		merged["tokens"] = v
	} else {
		delete(merged, "tokens")
	}
	if a.LastRefresh != "" {
		v, _ := json.Marshal(a.LastRefresh)
		merged["last_refresh"] = v
	}
	if a.AuthMode != "" {
		v, _ := json.Marshal(a.AuthMode)
		merged["auth_mode"] = v
	}
	return json.MarshalIndent(merged, "", "  ")
}

// ParseIDToken decodes the JWT payload from an id_token string without
// verifying the signature. Codex itself doesn't verify either — the
// token is trusted by virtue of having arrived through the loopback
// OAuth flow, and any tampering would be caught downstream when the
// token gets rejected by auth.openai.com on refresh.
//
// Returns the parsed claims plus the JWT's exp timestamp (used as the
// token's expiry — Codex's refresh response doesn't carry an
// expires_in field, so the JWT exp is the only authoritative source).
func ParseIDToken(idToken string) (*IDTokenClaims, error) {
	if idToken == "" {
		return nil, errors.New("empty id_token")
	}
	parts := strings.Split(idToken, ".")
	if len(parts) < 2 {
		return nil, fmt.Errorf("not a JWT (got %d segments)", len(parts))
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		payload, err = base64.URLEncoding.DecodeString(parts[1])
		if err != nil {
			return nil, fmt.Errorf("decode JWT payload: %w", err)
		}
	}
	var raw struct {
		Email   string `json:"email"`
		Sub     string `json:"sub"`
		Exp     int64  `json:"exp"`
		AuthNS  json.RawMessage `json:"https://api.openai.com/auth"`
	}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, fmt.Errorf("decode JWT claims: %w", err)
	}
	c := &IDTokenClaims{
		Email:   raw.Email,
		Subject: raw.Sub,
	}
	if raw.Exp > 0 {
		c.ExpiresAt = time.Unix(raw.Exp, 0)
	}
	if len(raw.AuthNS) > 0 {
		var ns struct {
			ChatGPTAccountID  string `json:"chatgpt_account_id"`
			ChatGPTPlanType   string `json:"chatgpt_plan_type"`
			ChatGPTUserID     string `json:"chatgpt_user_id"`
			ChatGPTIsFedRAMP  bool   `json:"chatgpt_account_is_fedramp"`
		}
		if err := json.Unmarshal(raw.AuthNS, &ns); err == nil {
			c.ChatGPTAccountID = ns.ChatGPTAccountID
			c.ChatGPTPlanType = ns.ChatGPTPlanType
			c.ChatGPTUserID = ns.ChatGPTUserID
			c.IsFedRAMP = ns.ChatGPTIsFedRAMP
		}
	}
	return c, nil
}

// Expiry returns the access/id token's expiry derived from the id_token
// JWT's exp claim, or the zero time when the JWT is missing/malformed.
// Callers compare against time.Now() (with a skew) to decide whether
// to refresh.
func (a *AuthJSON) Expiry() time.Time {
	if a == nil || a.Tokens == nil || a.Tokens.IDToken == "" {
		return time.Time{}
	}
	c, err := ParseIDToken(a.Tokens.IDToken)
	if err != nil {
		return time.Time{}
	}
	return c.ExpiresAt
}

// NeedsRefresh reports whether the token will expire within skew of
// now. skew=0 matches Expired() exactly. Mirrors keychain.OAuthCreds
// semantics so swap code can use either provider uniformly.
//
// A zero expiry (JWT missing or unparseable) returns false: we can't
// know it needs refresh, and the caller will hit OpenAI directly to
// learn whether the token is dead.
func (a *AuthJSON) NeedsRefresh(skew time.Duration) bool {
	exp := a.Expiry()
	if exp.IsZero() {
		return false
	}
	return time.Now().Add(skew).After(exp)
}

// Expired is the skew=0 variant of NeedsRefresh.
func (a *AuthJSON) Expired() bool {
	exp := a.Expiry()
	if exp.IsZero() {
		return false
	}
	return time.Now().After(exp)
}

// writeFileAtomic mirrors account.writeFileAtomic but is duplicated
// here so this leaf package doesn't import internal/account (which
// would create a cycle: account -> codex -> account).
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, filepath.Base(path)+".tmp.*")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tmpName := f.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("write %s: %w", tmpName, err)
	}
	if err := f.Chmod(perm); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("chmod %s: %w", tmpName, err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close %s: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return fmt.Errorf("rename %s -> %s: %w", tmpName, path, err)
	}
	return nil
}
