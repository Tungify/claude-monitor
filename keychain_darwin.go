//go:build darwin

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
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

// setPartitionList registers the macOS `security` CLI in the partition
// list of a keychain entry. On macOS 10.13+ each generic-password entry
// has a partition list that gates which code-signing identities can
// modify it — even when the entry's classic ACL is "allow any
// application" (the -A flag in WriteKeychainEntry). Without this, the
// security CLI is treated as an outsider and every modify pops a
// keychain-password dialog.
//
// The -k flag passes the user's macOS password directly so the call
// itself doesn't prompt; we use it once during the one-shot setup to
// register all entries silently in a single sweep.
func setPartitionList(svc, username, password string) error {
	cmd := exec.Command("security",
		"set-generic-password-partition-list",
		"-S", "apple-tool:,apple:",
		"-s", svc,
		"-a", username,
		"-k", password,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("set partition list %q: %w (%s)", svc, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// readPasswordTTY reads a password from stdin without echoing it. We
// use stty rather than golang.org/x/term to avoid pulling in a new
// dependency (and the corresponding Go-toolchain bump that comes with
// it). Caller must guarantee stdin is a TTY — non-TTY callers should
// short-circuit before reaching this.
func readPasswordTTY() (string, error) {
	save := exec.Command("stty", "-g")
	save.Stdin = os.Stdin
	state, err := save.Output()
	if err != nil {
		return "", fmt.Errorf("read termios state: %w", err)
	}
	state = bytes.TrimSpace(state)

	off := exec.Command("stty", "-echo")
	off.Stdin = os.Stdin
	if err := off.Run(); err != nil {
		return "", fmt.Errorf("disable echo: %w", err)
	}
	defer func() {
		restore := exec.Command("stty", string(state))
		restore.Stdin = os.Stdin
		_ = restore.Run()
	}()

	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	// Ctrl+D on an empty prompt closes stdin with EOF; that's the
	// user's intent to skip, not a hard error.
	return strings.TrimRight(line, "\r\n"), nil
}

// stdinIsTTY uses stty as the source of truth: if stty -g succeeds,
// stdin is a real terminal. The naive os.Stdin.Stat() ModeCharDevice
// check returns true for /dev/null (which is a character device but
// not a TTY) and would silently fall through into readPasswordTTY,
// emitting a confusing "read termios state: exit status 1" error.
func stdinIsTTY() bool {
	cmd := exec.Command("stty", "-g")
	cmd.Stdin = os.Stdin
	return cmd.Run() == nil
}

// RunKeychainSetup is the one-shot bootstrap that registers
// claude-monitor's `security` CLI with each Claude Code keychain
// entry's partition list. Without it, every account swap pops a
// keychain-password dialog because modern macOS gates modifications
// on the calling process's code-signing identity.
//
// We collect the user's macOS user password once (hidden TTY input,
// not stored anywhere), then call setPartitionList for the plain slot
// plus each per-account hashed entry. Future swaps stay silent until
// the user resets their keychain or adds a new account whose entry
// hasn't been registered yet (in which case `--keychain-setup` can be
// rerun).
//
// Skipped silently when stdin isn't a TTY (CI/automation), no accounts
// have been discovered, or the user enters a blank password.
func RunKeychainSetup(rootSpec string) error {
	accts, err := ResolveAccountDirs(rootSpec)
	if err != nil || len(accts) == 0 {
		return nil
	}
	if !stdinIsTTY() {
		return nil
	}

	fmt.Println()
	fmt.Println("First-time setup — register claude-monitor with macOS keychain")
	fmt.Println("so account swaps stay silent (otherwise every swap prompts for")
	fmt.Println("your password).")
	fmt.Println()
	fmt.Println("Your password is NOT stored — it's only passed to the system")
	fmt.Println("`security` CLI once. Press Enter to skip.")
	fmt.Println()
	fmt.Print("macOS user password: ")
	pwd, err := readPasswordTTY()
	fmt.Println()
	if err != nil {
		return fmt.Errorf("read password: %w", err)
	}
	if pwd == "" {
		fmt.Println("Skipped. Run `claude-monitor --keychain-setup` later to enable silent swaps.")
		fmt.Println()
		return nil
	}

	u, err := user.Current()
	if err != nil {
		return fmt.Errorf("user lookup: %w", err)
	}

	// Collect unique service names: the plain slot plus each account's
	// hashed entry. Dedupe so an account whose configDir hashes to the
	// same suffix as another (extremely unlikely, but cheap to handle)
	// only triggers one set-partition-list call.
	seen := map[string]struct{}{plainKeychainSvc: {}}
	svcs := []string{plainKeychainSvc}
	for _, a := range accts {
		svc := keychainServiceFor(a.configDir)
		if _, dup := seen[svc]; dup {
			continue
		}
		seen[svc] = struct{}{}
		svcs = append(svcs, svc)
	}

	var done, missing int
	var firstErr error
	for _, svc := range svcs {
		if err := setPartitionList(svc, u.Username, pwd); err != nil {
			missing++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		done++
	}
	switch {
	case done == 0 && firstErr != nil:
		fmt.Printf("✗ Setup failed: %v\n", firstErr)
		fmt.Println("  (wrong password? entries might not exist yet for accounts that")
		fmt.Println("  have never been authenticated.)")
	case missing > 0:
		fmt.Printf("✓ Registered %d entries (%d skipped — entries missing or not yet authenticated).\n", done, missing)
	default:
		fmt.Printf("✓ Registered %d keychain entries. Future swaps will be silent.\n", done)
	}
	fmt.Println()
	return nil
}
