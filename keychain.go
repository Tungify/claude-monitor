package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
// sha256 suffix derived from the absolute config dir path. We always
// include the suffix here because we're targeting non-default
// installations under ~/.claude-account/<name>.
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

// LoadCredentials reads + parses the keychain entry for the given
// account config dir. Returns os/exec.ExitError when the keychain
// item is missing — callers should treat that as "not authenticated".
func LoadCredentials(configDir string) (*OAuthCreds, error) {
	svc := keychainServiceFor(configDir)
	u, err := user.Current()
	if err != nil {
		return nil, fmt.Errorf("user lookup: %w", err)
	}
	cmd := exec.Command("security", "find-generic-password", "-s", svc, "-a", u.Username, "-w")
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
