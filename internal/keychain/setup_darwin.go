//go:build darwin

package keychain

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"strings"
)

// setPartitionList registers the macOS `security` CLI in the partition
// list of a keychain entry. On macOS 10.13+ each generic-password entry
// has a partition list that gates which code-signing identities can
// modify it — even when the entry's classic ACL is "allow any
// application". Without this, the security CLI is treated as an
// outsider and every modify pops a keychain-password dialog.
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

// RunSetup is the one-shot bootstrap that registers claude-monitor's
// `security` CLI with each Claude Code keychain entry's partition
// list. Without it, every account swap pops a keychain-password
// dialog because modern macOS gates modifications on the calling
// process's code-signing identity.
//
// configDirs is the list of account config dirs to register; the
// caller (main.go) discovers them via account.ResolveDirs so this
// package stays a leaf. The plain slot is registered unconditionally.
//
// We collect the user's macOS user password once (hidden TTY input,
// not stored anywhere), then call setPartitionList for the plain slot
// plus each per-account hashed entry. Future swaps stay silent until
// the user resets their keychain or adds a new account whose entry
// hasn't been registered yet (in which case the bootstrap can be
// rerun).
//
// Skipped silently when stdin isn't a TTY (CI/automation), no
// configDirs were given, or the user enters a blank password.
func RunSetup(configDirs []string) error {
	if len(configDirs) == 0 {
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
	seen := map[string]struct{}{PlainServiceName: {}}
	svcs := []string{PlainServiceName}
	for _, dir := range configDirs {
		svc := ServiceFor(dir)
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
