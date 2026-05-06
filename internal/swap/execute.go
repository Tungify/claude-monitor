package swap

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"claude-monitor/internal/account"
	"claude-monitor/internal/keychain"
)

// Execute rewrites the plain keychain slot to point at targetDir's
// account. Two writes happen, in this order:
//
//  1. Park: if the plain slot currently represents a discovered account
//     other than targetDir, mirror its creds into that account's hashed
//     entry. This is what keeps the dashboard's per-account usage view
//     accurate after a swap — without parking, the next refresh would
//     read the plain slot back through the default-dir candidate list
//     and report the *target* account's usage under the *active*
//     account's row.
//
//     Skipped when the plain slot is already in sync with the source
//     account's hashed entry (RefreshTokens match), so the parking
//     write only happens on the actual rotation event.
//
//  2. Promote: copy targetDir's hashed entry into the plain slot. The
//     next API call from any default-flow `claude` tab picks up the
//     new bearer token without restarting the process.
func Execute(rows []account.Row, activeDir, targetDir string) error {
	if activeDir == targetDir {
		return nil
	}
	target := account.FindRow(rows, targetDir)
	if target == nil {
		return fmt.Errorf("target %s not in current snapshot", targetDir)
	}
	targetCreds, err := keychain.LoadCredentialsByService(keychain.ServiceFor(targetDir))
	if err != nil {
		return fmt.Errorf("read target creds: %w", err)
	}

	if active := account.FindRow(rows, activeDir); active != nil && active.RefreshToken != "" {
		plain, _ := keychain.LoadCredentialsByService(keychain.PlainServiceName)
		if plain != nil && plain.RefreshToken == active.RefreshToken {
			parkSvc := keychain.ServiceFor(activeDir)
			if existing, _ := keychain.LoadCredentialsByService(parkSvc); existing == nil || existing.RefreshToken != plain.RefreshToken {
				if err := keychain.WriteEntry(parkSvc, plain); err != nil {
					return fmt.Errorf("park active creds: %w", err)
				}
			}
		}
	}

	if err := keychain.WriteEntry(keychain.PlainServiceName, targetCreds); err != nil {
		return fmt.Errorf("promote target into plain slot: %w", err)
	}

	// Sync $HOME/.claude.json's `oauthAccount` block so the `claude`
	// CLI (no CLAUDE_CONFIG_DIR) shows the now-active target's email
	// and displayName instead of the previous account's. Best-effort:
	// the keychain rotation above is the load-bearing change, so a
	// failure here (file missing, JSON corrupt, EPERM) only leaves
	// the banner stale — it doesn't break the swap itself.
	syncHomeOAuthAccount(activeDir, targetDir)

	return nil
}

// syncHomeOAuthAccount keeps $HOME/.claude.json's `oauthAccount` field
// pointing at whichever account currently owns the plain keychain
// slot. Without it, `claude` (no CLAUDE_CONFIG_DIR) keeps showing the
// previously logged-in email even after a rotation — tokens flip but
// the displayed identity lags until the next `/login`.
//
// Two writes happen, in order:
//
//  1. Backup. If we're leaving the default ~/.claude account and no
//     ~/.claude/.claude.json exists yet, snapshot the home file's
//     oauthAccount to that in-dir path so a later swap *back* to
//     default has a place to read default's identity from (the home
//     file will have been overwritten by step 2 below). When an
//     in-dir .claude.json already exists, we leave it untouched on
//     the assumption it's Claude Code's own (some setups keep the
//     default config in-dir) and rely on it as the restore source —
//     overwriting it with our minimal one-field JSON would
//     obliterate numStartups/projects/etc.
//
//  2. Patch. Read the target's oauthAccount block from its canonical
//     .claude.json (in-dir for non-default accounts; for the default,
//     the in-dir backup created above, with $HOME/.claude.json as a
//     last-ditch fallback) and write it into $HOME/.claude.json's
//     oauthAccount field. Every other top-level field is preserved.
//
// Best-effort throughout: any failure is swallowed. Surfacing errors
// here would push noisy banner text in front of the user for a purely
// cosmetic concern (the keychain rotation already succeeded).
func syncHomeOAuthAccount(activeDir, targetDir string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	homePath := filepath.Join(home, ".claude.json")
	defaultDir := account.DefaultDir()

	if activeDir == defaultDir && targetDir != defaultDir {
		backup := filepath.Join(defaultDir, ".claude.json")
		// Defensive: if ~/.claude/.claude.json already exists, assume
		// Claude Code authored it with the full default-account
		// config (some setups keep it in-dir rather than at $HOME)
		// and leave it alone. Its oauthAccount is already default's,
		// so account.ReadOAuthBlock(defaultDir) — which prefers
		// in-dir — will recover the right block on a future restore
		// without our backup. Writing our minimal one-field JSON over
		// a real config file would obliterate numStartups/projects/etc.
		if _, err := os.Stat(backup); errors.Is(err, os.ErrNotExist) {
			if block, err := account.ReadOAuthBlockFromFile(homePath); err == nil && block != nil {
				_ = account.WriteMinimalClaudeJSON(backup, block)
			}
		}
	}

	block, err := account.ReadOAuthBlock(targetDir)
	if err != nil || block == nil {
		return
	}
	_ = account.PatchOAuthInFile(homePath, block)
}
