package codex

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// nameRE constrains short names to characters safe for a filesystem
// path (no spaces, no separators, no shell glob meta). Same rule the
// Anthropic side enforces in internal/account.ValidateName — keep the
// two in lockstep so users can move between providers without surprises.
var nameRE = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

// ValidateName checks that a user-typed short name will produce a
// sane Codex config dir. Called on every keystroke in the [a] form so
// errors render live; Provision re-checks defensively.
func ValidateName(name string) error {
	if name == "" {
		return fmt.Errorf("name is required")
	}
	if len(name) > 50 {
		return fmt.Errorf("name too long (max 50)")
	}
	if !nameRE.MatchString(name) {
		return fmt.Errorf("only letters, digits, '.', '-', '_'")
	}
	if name == "." || name == ".." {
		return fmt.Errorf("reserved name")
	}
	return nil
}

// ConfigDirForName resolves a short name into the absolute Codex
// config dir the [a] flow will create. Mirrors Codex's $CODEX_HOME
// override convention so the new account shows up on the next
// auto-discovery tick without needing --root tweaking — the dir name
// is ~/.codex-<name>, parallel to Anthropic's ~/.claude-<name>.
func ConfigDirForName(name string) (string, error) {
	if err := ValidateName(name); err != nil {
		return "", err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("home dir: %w", err)
	}
	return filepath.Join(home, ".codex-"+name), nil
}

// Provision prepares a fresh Codex config dir for an upcoming
// `codex login` invocation. Two things happen, in order:
//
//  1. Resolve ~/.codex-<name> and refuse if anything exists there —
//     overwriting an existing dir is destructive and the user should
//     pick a different name (or use [L] to relogin on the existing).
//
//  2. mkdir the dir + an empty config.toml so LooksLikeCodexDir picks
//     it up even before the OAuth dance completes (matches the
//     Anthropic side's "stub projects/ so the row surfaces" trick).
//
// We deliberately do NOT write a placeholder auth.json: a stub file
// would shadow Codex's real OAuth write and the next `codex login`
// would either skip-because-already-authenticated or hard-fail
// depending on Codex version. The empty config.toml is enough.
func Provision(name string) (string, error) {
	dir, err := ConfigDirForName(name)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(dir); err == nil {
		return "", fmt.Errorf("already exists: %s", dir)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("stat %s: %w", dir, err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("mkdir %s: %w", dir, err)
	}
	// Touch an empty config.toml so LooksLikeCodexDir keys on it
	// even if the user cancels the OAuth flow. Codex will overwrite
	// or ignore it as needed on first run.
	cfg := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(cfg, []byte{}, 0o600); err != nil {
		_ = os.RemoveAll(dir)
		return "", fmt.Errorf("write %s: %w", cfg, err)
	}
	return dir, nil
}
