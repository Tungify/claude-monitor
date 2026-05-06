//go:build darwin

package main

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

// WriteKeychainEntry creates or updates a generic-password entry holding
// the OAuth creds envelope Claude Code expects. -U makes the call
// idempotent (update existing, create when missing); -A grants access to
// any application without prompting, which mirrors how Claude Code's own
// installer registers its entries — without it, the `claude` binary
// would hit a Touch ID / "allow access" dialog on every read after we
// rewrite the entry.
func WriteKeychainEntry(svc string, creds *OAuthCreds) error {
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
		"-A",
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
