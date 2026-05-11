package swap

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/api"
	"claude-monitor/internal/codex"
)

// codexParkedFileName is where we stash the default ~/.codex
// account's auth.json before the first swap-away. Mirrors the Anthropic
// side's park-to-hashed-slot trick: the default's dir IS the active
// slot for Codex, so without a separate parking file we'd lose the
// default's identity on first rotation. The dotfile prefix keeps it
// out of normal `ls` and aligns with Codex's own .well-known-style
// internal state files.
const codexParkedFileName = ".auth.parked.json"

// fetchOneOpenAI is the OpenAI counterpart to fetchOne. It reads the
// account's auth.json (no keychain involvement — Codex stores tokens
// in plaintext on purpose), proactively refreshes when the id_token is
// within refreshSkew of expiring, then probes codex's `/wham/usage`
// endpoint for the live 5h + weekly rate-limit windows so the dashboard
// can show codex rows with the same quota bars as Anthropic rows.
//
// The usage probe mirrors what codex itself does for its `/status`
// slash command (see openai/codex codex-rs/backend-client/src/client.rs
// :: get_rate_limits_many). Mapping is direct: primary_window→FiveHour,
// secondary_window→SevenDay. Codex doesn't split weekly by model the
// way Anthropic does, so SevenDaySonnet/SevenDayOpus stay nil.
//
// Returns:
//   - Row with TokenExpiresAt + PlanType + Usage populated on success.
//   - Row with Err on missing file, malformed JSON, missing tokens,
//     refresh failure (non-429), refresh 429 when the existing
//     access_token has already expired, /wham/usage 429 (so backoff
//     machinery armies the retry countdown), or /wham/usage 401/5xx.
func fetchOneOpenAI(ctx context.Context, a account.Account) account.Row {
	row := account.Row{
		Name:        a.Name,
		ConfigDir:   a.ConfigDir,
		Email:       a.Email,
		AccountUUID: a.AccountUUID,
		Provider:    a.Provider,
	}
	auth, err := codex.Load(a.ConfigDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			row.Err = fmt.Errorf("no token (run `codex login` to authenticate)")
		} else {
			row.Err = fmt.Errorf("read auth.json: %w", err)
		}
		return row
	}
	if auth.Tokens == nil || auth.Tokens.RefreshToken == "" {
		row.Err = fmt.Errorf("no refresh_token in auth.json (re-run `codex login`)")
		return row
	}

	row.AccessToken = auth.Tokens.AccessToken
	row.RefreshToken = auth.Tokens.RefreshToken
	row.TokenExpiresAt = auth.Expiry()
	accountID := row.AccountUUID
	if claims, perr := codex.ParseIDToken(auth.Tokens.IDToken); perr == nil {
		if row.Email == "" {
			row.Email = claims.Email
		}
		row.PlanType = claims.ChatGPTPlanType
		if accountID == "" {
			accountID = claims.ChatGPTAccountID
		}
	}

	if auth.NeedsRefresh(refreshSkew) {
		refreshed, rerr := refreshOpenAIUnderLock(ctx, a.ConfigDir, auth)
		if rerr != nil {
			var rl *api.RateLimitError
			if !errors.As(rerr, &rl) {
				row.Err = fmt.Errorf("token expired, refresh failed: %v (run `codex login` to re-auth)", rerr)
				return row
			}
			if auth.Expired() {
				row.Err = rerr
				return row
			}
		} else {
			row.AccessToken = refreshed.Tokens.AccessToken
			row.RefreshToken = refreshed.Tokens.RefreshToken
			row.TokenExpiresAt = refreshed.Expiry()
			if claims, perr := codex.ParseIDToken(refreshed.Tokens.IDToken); perr == nil {
				if claims.Email != "" {
					row.Email = claims.Email
				}
				if claims.ChatGPTPlanType != "" {
					row.PlanType = claims.ChatGPTPlanType
				}
				if claims.ChatGPTAccountID != "" {
					accountID = claims.ChatGPTAccountID
				}
			}
		}
	}

	if row.AccessToken != "" {
		usage, uerr := fetchCodexUsage(ctx, row.AccessToken, accountID)
		if uerr != nil {
			row.Err = uerr
			return row
		}
		row.Usage = usage
	}
	return row
}

// refreshOpenAIUnderLock orchestrates the same intra-slot / on-disk
// race-resolution pattern Anthropic's refreshUnderLock uses, scaled
// down to Codex's file-based storage:
//
//  1. Acquire the per-config-dir refresh lock so a concurrent `codex`
//     invocation (or another claude-monitor instance) doesn't race us
//     into double-refresh territory.
//  2. Re-read auth.json under the lock. If the access_token changed
//     since we initially read it, a racer already refreshed — adopt
//     their tokens and skip the redundant POST.
//  3. POST /oauth/token. On success, persist back to disk. On 429,
//     propagate so the row's existing token can still be used
//     downstream.
//
// Returns the up-to-date AuthJSON (refreshed or race-adopted), or the
// original auth + the refresh error.
func refreshOpenAIUnderLock(ctx context.Context, configDir string, current *codex.AuthJSON) (*codex.AuthJSON, error) {
	release, err := openaiLockOAuthRefresh(ctx, configDir)
	if err != nil {
		return current, fmt.Errorf("acquire openai oauth refresh lock: %w", err)
	}
	defer release()

	if fresh, ferr := codex.Load(configDir); ferr == nil && fresh.Tokens != nil {
		if fresh.Tokens.AccessToken != "" && fresh.Tokens.AccessToken != current.Tokens.AccessToken {
			current = fresh
			if !current.NeedsRefresh(refreshSkew) {
				return current, nil
			}
		}
	}

	refreshed, rerr := refreshOpenAI(ctx, current.Tokens.RefreshToken)
	if rerr != nil {
		var rl *api.RateLimitError
		if errors.As(rerr, &rl) {
			return current, rerr
		}
		// Race recovery: a concurrent writer may have refreshed in the
		// window between our re-read and our POST. Re-load and adopt if
		// the on-disk access_token has moved.
		if fresh, ferr := codex.Load(configDir); ferr == nil && fresh.Tokens != nil &&
			fresh.Tokens.AccessToken != current.Tokens.AccessToken {
			return fresh, nil
		}
		return current, rerr
	}

	current.Tokens.AccessToken = refreshed.AccessToken
	current.Tokens.RefreshToken = refreshed.RefreshToken
	if refreshed.IDToken != "" {
		current.Tokens.IDToken = refreshed.IDToken
	}
	current.LastRefresh = time.Now().UTC().Format(time.RFC3339)
	if err := codex.Save(configDir, current); err != nil {
		return current, fmt.Errorf("refreshed but persist failed: %v", err)
	}
	return current, nil
}

// openaiLockOAuthRefresh wraps a coarse filesystem lock under
// <configDir>/.oauth_refresh.lock. The lock is mkdir-based to match
// Anthropic's keychain.LockOAuthRefresh primitive, so a future change
// that consolidates the two doesn't have to migrate format. Indirected
// through a var so tests can stub it without touching real disk.
var openaiLockOAuthRefresh = func(ctx context.Context, configDir string) (func(), error) {
	lockDir := filepath.Join(configDir, ".oauth_refresh.lock")
	deadline := time.Now().Add(10 * time.Second)
	for {
		if err := os.Mkdir(lockDir, 0o700); err == nil {
			return func() { _ = os.Remove(lockDir) }, nil
		} else if !os.IsExist(err) {
			return nil, err
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("lock contention: %s held >10s", lockDir)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// refreshOpenAI is indirected so tests can simulate refresh outcomes
// without standing up an httptest server. Production binds to
// api.RefreshOpenAI.
var refreshOpenAI = api.RefreshOpenAI

// fetchCodexUsage is the same indirection point for /wham/usage. Tests
// stub it to inject canned RateLimitErrors and synthetic Usage shapes
// without touching the network.
var fetchCodexUsage = api.FetchCodexUsage

// detectActiveCodexDir returns which discovered ~/.codex* account
// currently owns ~/.codex/auth.json. Strategy:
//
//  1. Read ~/.codex/auth.json and decode its id_token's
//     chatgpt_account_id (stable across token rotations, so a `codex`
//     run between refreshes that rotates the access_token doesn't
//     desync detection from the row's AccountUUID).
//
//  2. Match against rows[*].AccountUUID. The row whose AccountUUID
//     equals the active slot's chatgpt_account_id is active.
//
//  3. Fall back to refresh_token equality when account_id is empty
//     (very old Codex versions or a freshly-installed account that
//     hasn't decoded its id_token yet). This is fragile across token
//     rotations but useful for bootstrap.
//
// Returns "" when no row matches and the default ~/.codex dir isn't
// among the rows — the TUI treats "" as "no ★ on any codex row".
//
// When NO codex rows are present at all, returns "" — there's no
// codex active dir to track because the user hasn't authenticated any
// codex accounts yet.
func detectActiveCodexDir(rows []account.Row) string {
	hasCodexRow := false
	for _, r := range rows {
		if r.Provider == account.ProviderOpenAI {
			hasCodexRow = true
			break
		}
	}
	if !hasCodexRow {
		return ""
	}
	codexDefault := codex.DefaultDir()
	if codexDefault == "" {
		return ""
	}
	auth, err := codex.LoadFile(filepath.Join(codexDefault, codex.AuthFileName))
	if err != nil || auth.Tokens == nil {
		// No active auth.json at all → fall back to the default dir
		// when it's among the discovered rows (the typical "single
		// account" install state).
		for _, r := range rows {
			if r.Provider == account.ProviderOpenAI && r.ConfigDir == codexDefault {
				return codexDefault
			}
		}
		return ""
	}
	var activeAccountID string
	if claims, perr := codex.ParseIDToken(auth.Tokens.IDToken); perr == nil {
		activeAccountID = claims.ChatGPTAccountID
	}
	if activeAccountID != "" {
		for _, r := range rows {
			if r.Provider == account.ProviderOpenAI && r.AccountUUID != "" && r.AccountUUID == activeAccountID {
				return r.ConfigDir
			}
		}
	}
	if auth.Tokens.RefreshToken != "" {
		for _, r := range rows {
			if r.Provider == account.ProviderOpenAI && r.RefreshToken != "" && r.RefreshToken == auth.Tokens.RefreshToken {
				return r.ConfigDir
			}
		}
	}
	// Last-ditch: assume default dir owns the active slot (typical
	// single-account install before any swap has happened).
	for _, r := range rows {
		if r.Provider == account.ProviderOpenAI && r.ConfigDir == codexDefault {
			return codexDefault
		}
	}
	return ""
}
