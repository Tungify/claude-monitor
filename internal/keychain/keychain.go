package keychain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"time"
)

// PlainServiceName is the OAuth slot a `claude` invocation reads when
// no CLAUDE_CONFIG_DIR is set. Auto-swap rewrites this single slot to
// rotate accounts; tabs invoked with an explicit CLAUDE_CONFIG_DIR
// bypass it and are intentionally left alone.
const PlainServiceName = "Claude Code-credentials"

// OAuthCreds is the inner shape Claude Code stores under
// "Claude Code-credentials[-<hash>]" in the OS credential store.
type OAuthCreds struct {
	AccessToken      string   `json:"accessToken"`
	RefreshToken     string   `json:"refreshToken"`
	ExpiresAt        int64    `json:"expiresAt"`
	Scopes           []string `json:"scopes"`
	SubscriptionType string   `json:"subscriptionType"`
}

func (c *OAuthCreds) Expired() bool {
	if c.ExpiresAt == 0 {
		return false
	}
	return time.Now().UnixMilli() >= c.ExpiresAt
}

type credsEnvelope struct {
	ClaudeAiOauth OAuthCreds `json:"claudeAiOauth"`
}

// ServiceFor mirrors keytar's service-name convention used by Claude
// Code: when CLAUDE_CONFIG_DIR is set, the entry name carries an
// 8-char sha256 suffix derived from the absolute config dir path. The
// hash is identical across OSes because we normalize the path string
// the same way Claude Code does (absolute, native separators, no
// trailing separator).
func ServiceFor(configDir string) string {
	abs, err := filepath.Abs(configDir)
	if err != nil {
		abs = configDir
	}
	abs = strings.TrimRight(abs, `/\`)
	sum := sha256.Sum256([]byte(abs))
	suffix := hex.EncodeToString(sum[:])[:8]
	return PlainServiceName + "-" + suffix
}

// candidates returns the list of service names to try for an account's
// config dir, in priority order. Two cases matter:
//
//   - default location (~/.claude): Claude Code stores the entry without
//     any suffix, as plain "Claude Code-credentials".
//   - explicit CLAUDE_CONFIG_DIR (~/.claude-gem, ~/.claude-account/foo):
//     the entry carries the 8-hex sha256 suffix.
//
// We try the most likely match first so the common case doesn't trigger
// an extra credential-store invocation (which can prompt for biometric
// auth on macOS or unlock the keyring on Linux).
func candidates(configDir string) []string {
	abs, err := filepath.Abs(configDir)
	if err != nil {
		abs = configDir
	}
	abs = strings.TrimRight(abs, `/\`)

	hashed := ServiceFor(configDir)
	if abs == defaultClaudeDir() {
		return []string{PlainServiceName, hashed}
	}
	return []string{hashed, PlainServiceName}
}

// defaultClaudeDir is duplicated from internal/account so this package
// stays a leaf — it's a 3-line helper, not worth a shared paths
// package or a cross-package import.
func defaultClaudeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude")
}

// LoadCredentials reads + parses the credential-store entry for the
// given account config dir. Returns an error when no candidate service
// name matched — callers should treat that as "not authenticated".
//
// Falls back to <configDir>/.credentials.json when no keychain entry
// matches. Claude Code uses this plaintext file on Linux setups where
// libsecret/Secret Service isn't reachable (headless boxes, CI, WSL).
func LoadCredentials(configDir string) (*OAuthCreds, error) {
	creds, err := loadFromCandidates(candidates(configDir))
	if err == nil {
		return creds, nil
	}
	if fileCreds, ferr := loadFromFile(configDir); ferr == nil {
		return fileCreds, nil
	}
	return nil, err
}

// LoadCredentialsHashedFirst is the variant used by the monitor when
// auto-swap is on: it always reads the per-dir hashed entry first, even
// for the default ~/.claude. After the first swap, the plain entry no
// longer represents the default account (it's been overwritten with
// some other account's creds), so reading hashed-first keeps the
// dashboard row pointing at the original account's parked credentials.
//
// Falls back to plain when the hashed entry doesn't exist (clean install
// pre-park, or AutoSwap was just turned on), and finally to
// <configDir>/.credentials.json for file-based storage.
func LoadCredentialsHashedFirst(configDir string) (*OAuthCreds, error) {
	hashed := ServiceFor(configDir)
	creds, err := loadFromCandidates([]string{hashed, PlainServiceName})
	if err == nil {
		return creds, nil
	}
	if fileCreds, ferr := loadFromFile(configDir); ferr == nil {
		return fileCreds, nil
	}
	return nil, err
}

// loadFromFile reads <configDir>/.credentials.json — Claude Code's
// plaintext fallback when no Secret Service / Keychain backend is
// available (common on Linux headless boxes, WSL, CI). The shape is the
// same credsEnvelope JSON keytar serializes.
func loadFromFile(configDir string) (*OAuthCreds, error) {
	p := filepath.Join(configDir, ".credentials.json")
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var env credsEnvelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("decode %s: %w", p, err)
	}
	if env.ClaudeAiOauth.AccessToken == "" {
		return nil, fmt.Errorf("no access token in %s", p)
	}
	return &env.ClaudeAiOauth, nil
}

// LoadCredentialsByService reads creds for an explicit service name.
// Used by swap to read source creds (the target account's hashed
// entry) and to inspect the plain "active slot" without going through
// the configDir → service-name machinery.
func LoadCredentialsByService(svc string) (*OAuthCreds, error) {
	u, err := user.Current()
	if err != nil {
		return nil, fmt.Errorf("user lookup: %w", err)
	}
	return readKeychainEntry(u.Username, svc)
}

func loadFromCandidates(svcs []string) (*OAuthCreds, error) {
	u, err := user.Current()
	if err != nil {
		return nil, fmt.Errorf("user lookup: %w", err)
	}
	var lastErr error
	for _, svc := range svcs {
		creds, err := readKeychainEntry(u.Username, svc)
		if err == nil {
			return creds, nil
		}
		lastErr = err
	}
	return nil, lastErr
}
