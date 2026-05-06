//go:build linux

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"os/user"
	"strings"
)

// readKeychainEntry shells out to libsecret's `secret-tool`:
//
//	secret-tool lookup service <svc> account <username>
//
// keytar (which Claude Code uses) writes via the same Secret Service
// API, with the service name and account name surfaced as searchable
// attributes. `secret-tool` is part of the libsecret-tools package on
// Debian/Ubuntu and libsecret on Fedora/Arch.
//
// On a fresh install the user may need to:
//
//	sudo apt install libsecret-tools
//
// and have a running Secret Service daemon (gnome-keyring on most
// desktops; kwallet via the org.freedesktop.secrets bridge on KDE).
func readKeychainEntry(username, svc string) (*OAuthCreds, error) {
	cmd := exec.Command("secret-tool", "lookup", "service", svc, "account", username)
	out, err := cmd.Output()
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, fmt.Errorf("secret-tool not installed (apt install libsecret-tools)")
		}
		return nil, fmt.Errorf("secret-tool lookup %q: %w", svc, err)
	}
	out = []byte(strings.TrimRight(string(out), "\n"))
	if len(out) == 0 {
		return nil, fmt.Errorf("no entry %q in Secret Service", svc)
	}
	var env credsEnvelope
	if err := json.Unmarshal(out, &env); err != nil {
		return nil, fmt.Errorf("decode credentials: %w", err)
	}
	if env.ClaudeAiOauth.AccessToken == "" {
		return nil, fmt.Errorf("no access token in keyring entry %q", svc)
	}
	return &env.ClaudeAiOauth, nil
}

// WriteKeychainEntry stores creds via `secret-tool store`. The label is
// what shows up in keyring UIs (gnome-keyring's seahorse, kwallet
// manager); the service+account attributes are how `secret-tool lookup`
// finds the entry again. We pipe the JSON envelope on stdin to keep it
// out of the process arglist.
func WriteKeychainEntry(svc string, creds *OAuthCreds) error {
	u, err := user.Current()
	if err != nil {
		return fmt.Errorf("user lookup: %w", err)
	}
	payload, err := json.Marshal(credsEnvelope{ClaudeAiOauth: *creds})
	if err != nil {
		return fmt.Errorf("encode credentials: %w", err)
	}
	cmd := exec.Command("secret-tool", "store",
		"--label=Claude Code",
		"service", svc,
		"account", u.Username,
	)
	cmd.Stdin = strings.NewReader(string(payload))
	out, err := cmd.CombinedOutput()
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return fmt.Errorf("secret-tool not installed (apt install libsecret-tools)")
		}
		return fmt.Errorf("secret-tool store %q: %w (%s)", svc, err, strings.TrimSpace(string(out)))
	}
	return nil
}
