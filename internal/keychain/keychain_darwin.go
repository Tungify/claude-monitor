//go:build darwin

package keychain

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"os/user"
	"strings"
)

// readKeychainEntry shells out to the macOS `security` CLI:
//
//	security find-generic-password -s <service> -a <account> -w
//
// -w prints just the password (the JSON envelope) on stdout. Depending
// on the entry's ACL, the OS may pop a Touch ID / "allow access" prompt
// the first time.
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

// WriteEntry creates or updates a generic-password entry holding the
// OAuth creds envelope Claude Code expects. -U makes the call
// idempotent (update existing, create when missing).
//
// Note on the missing -A flag: macOS Security treats "add-generic-
// password -U -A" as a request to *replace* the entry's ACL with one
// listing the calling tool (the `security` CLI itself) as the sole
// trusted decrypter. That replacement requires the change_acl
// privilege — and when the existing entry's change_acl ACL has an
// empty trusted-apps list (which Claude Code-credentials entries do
// by default), the system pops a "Claude Code-credentials wants
// access" dialog on every write. So we deliberately omit -A: the
// encrypt ACL on these entries is already wide-open (applications:
// <null> = any process), so updating just the password value goes
// through silently. The trade-off is that future *reads* by other
// processes (Claude Code itself) follow the entry's decrypt ACL
// unchanged — exactly what we want, since Claude Code originally
// created these with permissive decrypt ACLs.
func WriteEntry(svc string, creds *OAuthCreds) error {
	u, err := user.Current()
	if err != nil {
		return fmt.Errorf("user lookup: %w", err)
	}
	payload, err := json.Marshal(credsEnvelope{ClaudeAiOauth: *creds})
	if err != nil {
		return fmt.Errorf("encode credentials: %w", err)
	}
	cmd := exec.Command("security", "add-generic-password",
		"-U",
		"-s", svc,
		"-a", u.Username,
		"-w", string(payload),
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("keychain write %q: %w (%s)", svc, err, strings.TrimSpace(string(out)))
	}
	return nil
}
