//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os/user"

	"github.com/danieljoos/wincred"
)

// readKeychainEntry talks to Windows Credential Manager via the wincred
// library. keytar (used by Claude Code) stores generic credentials with
// TargetName = "<service>/<account>" and the JSON envelope as the blob
// — that's the convention we follow on read and write.
//
// "Generic" credentials live under the user's profile and are unlocked
// when the user logs in; no extra prompt fires on read.
func readKeychainEntry(username, svc string) (*OAuthCreds, error) {
	target := svc + "/" + username
	cred, err := wincred.GetGenericCredential(target)
	if err != nil {
		return nil, fmt.Errorf("wincred read %q: %w", target, err)
	}
	if cred == nil || len(cred.CredentialBlob) == 0 {
		return nil, fmt.Errorf("empty credential blob for %q", target)
	}
	var env credsEnvelope
	if err := json.Unmarshal(cred.CredentialBlob, &env); err != nil {
		return nil, fmt.Errorf("decode credentials: %w", err)
	}
	if env.ClaudeAiOauth.AccessToken == "" {
		return nil, fmt.Errorf("no access token in credential %q", target)
	}
	return &env.ClaudeAiOauth, nil
}

// WriteKeychainEntry creates or replaces a generic credential. We mark
// it PersistLocalMachine so it survives logoff/login (keytar's default
// for Claude Code is the same).
func WriteKeychainEntry(svc string, creds *OAuthCreds) error {
	u, err := user.Current()
	if err != nil {
		return fmt.Errorf("user lookup: %w", err)
	}
	payload, err := json.Marshal(credsEnvelope{ClaudeAiOauth: *creds})
	if err != nil {
		return fmt.Errorf("encode credentials: %w", err)
	}
	target := svc + "/" + u.Username
	c := wincred.NewGenericCredential(target)
	c.UserName = u.Username
	c.CredentialBlob = payload
	c.Persist = wincred.PersistLocalMachine
	if err := c.Write(); err != nil {
		return fmt.Errorf("wincred write %q: %w", target, err)
	}
	// Defensive: surface the same "stored" state both reader and writer
	// can rely on (some older Windows builds returned nil from Write
	// even when ACLs blocked persistence).
	if _, err := wincred.GetGenericCredential(target); err != nil && !errors.Is(err, wincred.ErrElementNotFound) {
		return fmt.Errorf("wincred verify %q: %w", target, err)
	}
	return nil
}
