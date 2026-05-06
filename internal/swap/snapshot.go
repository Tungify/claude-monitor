// Package swap orchestrates the per-tick gather + decide + execute
// loop that keeps the plain keychain slot rotated to a fresh account.
// It composes the leaf packages (account, api, keychain, config) — the
// TUI and the CLI helpers consume what swap returns.
package swap

import (
	"context"
	"fmt"
	"sync"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/api"
	"claude-monitor/internal/config"
	"claude-monitor/internal/keychain"
)

// Event records a single swap action so the TUI can flash a banner
// and the user can see what just happened. Populated only for the row
// the swap was executed on (target row).
type Event struct {
	FromName string
	ToName   string
	FromUtil float64
	ToUtil   float64
	Reason   string
}

func (e *Event) String() string {
	return fmt.Sprintf("swap %s (%.0f%%) → %s (%.0f%%) — %s",
		e.FromName, e.FromUtil, e.ToName, e.ToUtil, e.Reason)
}

// FetchResult bundles the per-snapshot data the TUI needs from a single
// refresh: the rows, plus auto-swap outcome (which account is currently
// behind the plain `claude` slot, and whether a rotation just happened).
type FetchResult struct {
	Rows      []account.Row
	ActiveDir string
	Swap      *Event
	SwapErr   error
}

// FetchAll resolves accounts according to rootSpec, queries
// /api/oauth/usage for each in parallel, optionally kicks any account
// whose 5h window is at 0%, and (when cfg.AutoSwap is on) rotates the
// plain keychain slot to a fresher account. Returns the snapshot the
// TUI renders.
//
// skipUntil maps a config dir to a "do not call API before" timestamp;
// accounts in the backoff window get a synthetic row reflecting the
// remaining wait, so the UI keeps showing them but no request goes out.
//
// prevUtil carries the previous tick's 5h utilization per config dir,
// used by decideSwap to detect window resets between refreshes. Pass
// nil on the very first refresh.
//
// manualPickDir is the configDir the user most recently pinned via the
// in-TUI [m] picker; while it matches the active account, auto-swap's
// rebalance-on-reset is suppressed and threshold tiers <= the pinned
// account's util at pin time (manualPickUtil) are skipped — so the
// pin sticks until the *next* tier above where the user picked. Pass
// "" / 0 when there is no active manual pick.
func FetchAll(ctx context.Context, rootSpec string, cfg config.Config, skipUntil map[string]time.Time, prevUtil map[string]float64, manualPickDir string, manualPickUtil float64) (*FetchResult, error) {
	accts, err := account.ResolveDirs(rootSpec)
	if err != nil {
		return nil, err
	}
	if len(accts) == 0 {
		if rootSpec == "" {
			return nil, fmt.Errorf("no Claude config dirs found in $HOME (looked for ~/.claude*)")
		}
		return nil, fmt.Errorf("no accounts found under %s", rootSpec)
	}

	now := time.Now()
	rows := make([]account.Row, len(accts))
	var wg sync.WaitGroup
	for i, a := range accts {
		i, a := i, a
		if t, ok := skipUntil[a.ConfigDir]; ok && now.Before(t) {
			row := account.Row{
				Name:      a.Name,
				ConfigDir: a.ConfigDir,
				Email:     a.Email,
				Err:       fmt.Errorf("rate limited (retry in %s)", time.Until(t).Round(time.Second)),
			}
			// Populate RefreshToken from the per-dir hashed keychain
			// entry even though we're skipping the API call. Without
			// this, detectActiveDir can't match the plain slot's
			// RefreshToken against any row when the actually-active
			// account is the one in 429 backoff — and silently
			// reverts the ★ marker to defaultClaudeDir, making a
			// just-completed manual swap look like it "lost"
			// itself the moment Anthropic returns a 429.
			if creds, err := keychain.LoadCredentialsHashedFirst(a.ConfigDir); err == nil {
				row.RefreshToken = creds.RefreshToken
			}
			rows[i] = row
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			rows[i] = fetchOne(ctx, a, cfg.AutoSwap)
		}()
	}
	wg.Wait()

	if cfg.AutoKick {
		runAutoKick(ctx, rows)
	}

	result := &FetchResult{Rows: rows}
	result.ActiveDir = detectActiveDir(rows)
	if cfg.AutoSwap {
		if target, reason := decideSwap(rows, result.ActiveDir, prevUtil, manualPickDir, manualPickUtil, cfg); target != nil {
			active := account.FindRow(rows, result.ActiveDir)
			ev := &Event{
				FromName: account.DisplayName(active),
				ToName:   target.Name,
				FromUtil: account.RowFiveHourUtil(active),
				ToUtil:   account.FiveHourUtil(target.Usage),
				Reason:   reason,
			}
			if err := Execute(rows, result.ActiveDir, target.ConfigDir); err != nil {
				result.SwapErr = err
			} else {
				result.Swap = ev
				result.ActiveDir = target.ConfigDir
			}
		}
	}
	return result, nil
}

// fetchOne loads creds and fetches /api/oauth/usage for a single
// account. Returns a Row with Err populated on any failure path so
// the caller can render it inline.
func fetchOne(ctx context.Context, a account.Account, autoSwap bool) account.Row {
	row := account.Row{Name: a.Name, ConfigDir: a.ConfigDir, Email: a.Email}
	// When auto-swap is on, prefer the per-dir hashed entry so the
	// dashboard still shows each account's real usage even after the
	// plain slot has been rotated to impersonate a different account.
	loader := keychain.LoadCredentials
	if autoSwap {
		loader = keychain.LoadCredentialsHashedFirst
	}
	creds, err := loader(a.ConfigDir)
	if err != nil {
		row.Err = fmt.Errorf("no token (run `claude` once to login)")
		return row
	}
	if creds.Expired() {
		row.Err = fmt.Errorf("token expired (run `claude` once to refresh)")
		return row
	}
	// Populate RefreshToken/AccessToken before the network call so a
	// transient API failure (rate limit, 5xx) doesn't strand the row
	// without identity. detectActiveDir and the manual-swap picker
	// both compare against RefreshToken — leaving it empty made the
	// ★ marker drift and blocked swaps to rate-limited rows even
	// though the underlying creds were perfectly fine.
	row.AccessToken = creds.AccessToken
	row.RefreshToken = creds.RefreshToken
	usage, err := api.FetchUsage(ctx, creds.AccessToken)
	if err != nil {
		row.Err = err
		return row
	}
	row.Usage = usage
	return row
}

// runAutoKick fires a 1-token message at every account whose 5h window
// is currently at 0% utilization, in parallel. We do this after the
// fetch pass so we know the actual util value rather than trusting
// stale state.
func runAutoKick(ctx context.Context, rows []account.Row) {
	var wg sync.WaitGroup
	for i := range rows {
		r := &rows[i]
		if r.Err != nil || r.Usage == nil || r.AccessToken == "" {
			continue
		}
		if account.FiveHourUtil(r.Usage) > 0 {
			continue
		}
		wg.Add(1)
		go func(r *account.Row) {
			defer wg.Done()
			kickCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			if err := api.KickWindow(kickCtx, r.AccessToken); err != nil {
				r.KickErr = err
				return
			}
			r.Kicked = true
		}(r)
	}
	wg.Wait()
}

// detectActiveDir figures out which discovered account currently owns
// the plain keychain slot. We compare RefreshTokens because:
//
//   - access_tokens rotate on every refresh, so the plain slot's access
//     token will diverge from a hashed entry's even when both represent
//     the same account.
//   - refresh_tokens are stable across access-token refreshes, so they
//     act as a reliable account identity.
//
// When the plain slot doesn't match any discovered account's hashed
// entry, the assumption is that the user has never run a swap — the
// plain slot still holds the default ~/.claude creds, so we fall back
// to the discovered account whose ConfigDir == account.DefaultDir().
//
// Returns "" when no plausible match exists (e.g. no plain slot).
func detectActiveDir(rows []account.Row) string {
	plain, err := keychain.LoadCredentialsByService(keychain.PlainServiceName)
	if err != nil || plain == nil || plain.RefreshToken == "" {
		return account.DefaultDir()
	}
	for _, r := range rows {
		if r.RefreshToken != "" && r.RefreshToken == plain.RefreshToken {
			return r.ConfigDir
		}
	}
	return account.DefaultDir()
}

// DetectActiveDir is the exported variant for callers (the TUI's
// initial state and CLI helpers) that need the active marker without
// running a full FetchAll.
func DetectActiveDir(rows []account.Row) string { return detectActiveDir(rows) }
