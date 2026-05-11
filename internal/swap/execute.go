package swap

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"claude-monitor/internal/account"
	"claude-monitor/internal/codex"
	"claude-monitor/internal/keychain"
)

// Execute rotates the active credential slot to point at targetDir's
// account. The exact mechanics differ per provider — see executeAnthropic
// and executeOpenAI — but both follow the same park-then-promote shape so
// the dashboard's per-row usage view stays accurate after a swap.
//
// Cross-provider swaps are rejected: a swap target whose Provider
// disagrees with the active row's Provider doesn't make sense (Codex
// can't read Anthropic OAuth tokens and vice versa). The TUI is
// expected to scope its picker to same-provider candidates; this
// check is just a belt-and-braces safety net.
func Execute(rows []account.Row, activeDir, targetDir string) error {
	if activeDir == targetDir {
		return nil
	}
	target := account.FindRow(rows, targetDir)
	if target == nil {
		return fmt.Errorf("target %s not in current snapshot", targetDir)
	}
	active := account.FindRow(rows, activeDir)
	if active != nil && active.Provider != "" && target.Provider != "" && active.Provider != target.Provider {
		return fmt.Errorf("cross-provider swap rejected: active=%s target=%s",
			active.Provider, target.Provider)
	}
	if target.Provider == account.ProviderOpenAI {
		return executeOpenAI(active, target)
	}
	return executeAnthropic(rows, activeDir, targetDir)
}

// executeAnthropic is the original keychain-rewrite path, factored out
// of Execute so the OpenAI branch can stay separate.
func executeAnthropic(rows []account.Row, activeDir, targetDir string) error {
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

	syncHomeOAuthAccount(activeDir, targetDir)

	return nil
}

// executeOpenAI rotates the Codex active slot by rewriting
// $CODEX_HOME/auth.json (= ~/.codex/auth.json by default) with the
// target account's tokens. Mirrors the Anthropic park-then-promote
// shape but using file operations instead of keychain entries:
//
//  1. Park (only when active is the default ~/.codex dir): copy the
//     current ~/.codex/auth.json into ~/.codex/.auth.parked.json so a
//     later swap-back-to-default has a place to restore default's
//     identity. We don't park for non-default actives because their
//     auth.json IS the canonical store for that account.
//
//  2. Promote: load target's auth.json (or the parked file if the
//     target IS default and its current auth.json represents a
//     different account) and write it over ~/.codex/auth.json.
//
// On a swap among non-default OpenAI accounts (e.g. ~/.codex-foo ->
// ~/.codex-bar), step 1 is a no-op. Step 2 reads ~/.codex-bar/auth.json
// and writes it to ~/.codex/auth.json.
//
// Both auth.json reads are full-file (a few hundred bytes); copying
// the parsed AuthJSON preserves any Codex-version-newer Extra fields
// the swap shouldn't strip.
func executeOpenAI(active, target *account.Row) error {
	if target == nil || target.Provider != account.ProviderOpenAI {
		return fmt.Errorf("openai swap: invalid target row")
	}
	codexDefault := codex.DefaultDir()
	if codexDefault == "" {
		return fmt.Errorf("openai swap: no $HOME to resolve ~/.codex")
	}
	activeAuth := filepath.Join(codexDefault, codex.AuthFileName)
	parkedPath := filepath.Join(codexDefault, codexParkedFileName)

	// Park step. We only park when the current contents of
	// ~/.codex/auth.json represent the active account *and* active is
	// the default dir — for non-default actives, their own
	// <activeDir>/auth.json already holds their tokens, so there's no
	// need to stash anything extra. We compare account_id to decide
	// whether ~/.codex/auth.json currently holds default's identity:
	// after a previous swap-away the file already represents some
	// other account, and re-parking would clobber an earlier valid
	// park file.
	if active != nil && active.Provider == account.ProviderOpenAI && active.ConfigDir == codexDefault {
		if _, err := os.Stat(parkedPath); errors.Is(err, os.ErrNotExist) {
			if current, err := codex.LoadFile(activeAuth); err == nil {
				_ = codex.SaveFile(parkedPath, current)
			}
		}
	}

	// Promote step. Three sub-cases:
	//   a) target is default and parked file exists → restore parked.
	//   b) target is default and no parked file    → target's own dir
	//      already IS the active slot; nothing to do.
	//   c) target is non-default → copy target's auth.json.
	var sourcePath string
	switch {
	case target.ConfigDir == codexDefault:
		if _, err := os.Stat(parkedPath); err == nil {
			sourcePath = parkedPath
		} else {
			// Default is already active.
			return nil
		}
	default:
		sourcePath = filepath.Join(target.ConfigDir, codex.AuthFileName)
	}

	auth, err := codex.LoadFile(sourcePath)
	if err != nil {
		return fmt.Errorf("openai swap: read source %s: %w", sourcePath, err)
	}
	if auth.Tokens == nil || auth.Tokens.AccessToken == "" {
		return fmt.Errorf("openai swap: source %s has no tokens", sourcePath)
	}
	if err := codex.SaveFile(activeAuth, auth); err != nil {
		return fmt.Errorf("openai swap: write %s: %w", activeAuth, err)
	}
	// On a successful restore from the parked file, remove it so a
	// future swap-away can re-snapshot default's *current* identity
	// (which may have rotated tokens by then) instead of restoring an
	// outdated copy.
	if sourcePath == parkedPath {
		_ = os.Remove(parkedPath)
	}
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
