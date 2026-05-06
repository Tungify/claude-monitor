package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"time"
)

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

// keychainServiceFor mirrors keytar's service-name convention used by
// Claude Code: when CLAUDE_CONFIG_DIR is set, the entry name carries an
// 8-char sha256 suffix derived from the absolute config dir path. The
// hash is identical across OSes because we normalize the path string
// the same way Claude Code does (absolute, native separators, no
// trailing separator).
func keychainServiceFor(configDir string) string {
	abs, err := filepath.Abs(configDir)
	if err != nil {
		abs = configDir
	}
	abs = strings.TrimRight(abs, `/\`)
	sum := sha256.Sum256([]byte(abs))
	suffix := hex.EncodeToString(sum[:])[:8]
	return "Claude Code-credentials-" + suffix
}

// keychainCandidates returns the list of service names to try for an
// account's config dir, in priority order. Two cases matter:
//
//   - default location (~/.claude): Claude Code stores the entry without
//     any suffix, as plain "Claude Code-credentials".
//   - explicit CLAUDE_CONFIG_DIR (~/.claude-gem, ~/.claude-account/foo):
//     the entry carries the 8-hex sha256 suffix.
//
// We try the most likely match first so the common case doesn't trigger
// an extra credential-store invocation (which can prompt for biometric
// auth on macOS or unlock the keyring on Linux).
func keychainCandidates(configDir string) []string {
	abs, err := filepath.Abs(configDir)
	if err != nil {
		abs = configDir
	}
	abs = strings.TrimRight(abs, `/\`)
	defaultDir := defaultClaudeDir()

	hashed := keychainServiceFor(configDir)
	const plain = "Claude Code-credentials"

	if abs == defaultDir {
		return []string{plain, hashed}
	}
	return []string{hashed, plain}
}

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
func LoadCredentials(configDir string) (*OAuthCreds, error) {
	return loadCredsFromCandidates(keychainCandidates(configDir))
}

// LoadCredentialsHashedFirst is the variant used by the monitor when
// auto-swap is on: it always reads the per-dir hashed entry first, even
// for the default ~/.claude. After the first swap, the plain entry no
// longer represents the default account (it's been overwritten with
// some other account's creds), so reading hashed-first keeps the
// dashboard row pointing at the original account's parked credentials.
//
// Falls back to plain when the hashed entry doesn't exist (clean install
// pre-park, or AutoSwap was just turned on).
func LoadCredentialsHashedFirst(configDir string) (*OAuthCreds, error) {
	hashed := keychainServiceFor(configDir)
	const plain = "Claude Code-credentials"
	return loadCredsFromCandidates([]string{hashed, plain})
}

// LoadCredentialsByService reads creds for an explicit service name.
// Used by the swap module to read source creds (the target account's
// hashed entry) and to inspect the plain "active slot" without going
// through the configDir → service-name machinery.
func LoadCredentialsByService(svc string) (*OAuthCreds, error) {
	u, err := user.Current()
	if err != nil {
		return nil, fmt.Errorf("user lookup: %w", err)
	}
	return readKeychainEntry(u.Username, svc)
}

func loadCredsFromCandidates(svcs []string) (*OAuthCreds, error) {
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
