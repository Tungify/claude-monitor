package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"
)

// OAuthCreds is the inner shape Claude Code stores under
// "Claude Code-credentials[-<hash>]" in the macOS keychain.
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

// keychainServiceFor mirrors Claude Code's Py("-credentials") helper:
// when CLAUDE_CONFIG_DIR is set, the service name carries an 8-char
// sha256 suffix derived from the absolute config dir path.
func keychainServiceFor(configDir string) string {
	abs, err := filepath.Abs(configDir)
	if err != nil {
		abs = configDir
	}
	abs = strings.TrimRight(abs, "/")
	sum := sha256.Sum256([]byte(abs))
	suffix := hex.EncodeToString(sum[:])[:8]
	return "Claude Code-credentials-" + suffix
}

// keychainCandidates returns the list of service names to try for an
// account's config dir, in priority order. The first that resolves is
// the one we use. Two cases matter:
//
//   - default location (~/.claude): Claude Code stores the entry without
//     any suffix, as plain "Claude Code-credentials".
//   - explicit CLAUDE_CONFIG_DIR (~/.claude-gem, ~/.claude-account/foo):
//     the entry carries the 8-hex sha256 suffix.
//
// We try the most likely match first so the common case doesn't trigger
// an extra `security` invocation (which can prompt for Touch ID).
func keychainCandidates(configDir string) []string {
	abs, err := filepath.Abs(configDir)
	if err != nil {
		abs = configDir
	}
	abs = strings.TrimRight(abs, "/")
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

// LoadCredentials reads + parses the keychain entry for the given
// account config dir. Returns an error when no candidate service name
// matched — callers should treat that as "not authenticated".
func LoadCredentials(configDir string) (*OAuthCreds, error) {
	u, err := user.Current()
	if err != nil {
		return nil, fmt.Errorf("user lookup: %w", err)
	}
	var lastErr error
	for _, svc := range keychainCandidates(configDir) {
		creds, err := readKeychainEntry(u.Username, svc)
		if err == nil {
			return creds, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func readKeychainEntry(username, svc string) (*OAuthCreds, error) {
	cmd := exec.Command("security", "find-generic-password", "-s", svc, "-a", username, "-w")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("keychain read %q: %w", svc, err)
	}
	var env credsEnvelope
	if err := json.Unmarshal(out, &env); err != nil {
		return nil, fmt.Errorf("decode credentials: %w", err)
	}
	if env.ClaudeAiOauth.AccessToken == "" {
		return nil, fmt.Errorf("no access token in keychain entry %q", svc)
	}
	return &env.ClaudeAiOauth, nil
}
