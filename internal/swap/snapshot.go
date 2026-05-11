// Package swap orchestrates the per-tick gather + decide + execute
// loop that keeps the plain keychain slot rotated to a fresh account.
// It composes the leaf packages (account, api, keychain, config) — the
// TUI and the CLI helpers consume what swap returns.
package swap

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/api"
	"claude-monitor/internal/config"
	"claude-monitor/internal/keychain"
)

// refreshSkew is how far ahead of expiry we proactively refresh OAuth
// tokens. The 1h token lifetime + the way users typically log in N
// accounts within a few minutes of each other means every refresh
// cohort is naturally aligned to the same 5-minute window every hour.
// Refreshing 5 minutes early gives a tick (or two) of headroom to
// stagger the cohort across the ~60s polling cadence — by the time a
// token actually expires, it's already been replaced. Cold-start (no
// dashboard running through the night) still hits the synchronous
// path; for that case the per-call throttle inside RefreshOAuth keeps
// us under the IP-level limiter.
const refreshSkew = 5 * time.Minute

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
				Name:        a.Name,
				ConfigDir:   a.ConfigDir,
				Email:       a.Email,
				AccountUUID: a.AccountUUID,
				Err:         fmt.Errorf("rate limited (retry in %s)", time.Until(t).Round(time.Second)),
			}
			// Populate RefreshToken from the per-dir hashed keychain
			// entry even though we're skipping the API call.
			// detectActiveDir's primary path matches by accountUuid
			// (carried on the row from ResolveDirs), so the marker
			// doesn't depend on RefreshToken anymore — but it's still
			// the only fallback when .claude.json hasn't been written
			// yet, and decideSwap.RotateOnRateLimit needs a non-empty
			// token to consider the row a candidate. Without it, a
			// 429-backed-off active row falls out of every code path.
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
				FromUtil: account.RowEffectiveUtil(active),
				ToUtil:   account.EffectiveUtil(target.Usage),
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
	row := account.Row{Name: a.Name, ConfigDir: a.ConfigDir, Email: a.Email, AccountUUID: a.AccountUUID}
	// When auto-swap is on, prefer the per-dir hashed entry so the
	// dashboard still shows each account's real usage even after the
	// plain slot has been rotated to impersonate a different account.
	creds, src, err := loadForRefresh(a.ConfigDir, autoSwap)
	if err != nil {
		row.Err = fmt.Errorf("no token (run `claude` once to login)")
		return row
	}
	// Populate identity tokens UPFRONT — before refresh, before fetch.
	// Every later return (refresh 429, refresh 4xx, persist EPERM,
	// fetch 429, fetch 5xx) keeps row.RefreshToken set, so:
	//
	//   - detectActiveDir's refresh_token fallback can match this row
	//     when no accountUuid has been recorded yet (fresh install
	//     pre-first-/login). The primary uuid match runs off
	//     row.AccountUUID, populated separately at ResolveDirs time.
	//   - decideSwap's "active rate limited → rotate" branch can find
	//     candidates whose tokens are valid but whose /api/oauth/usage
	//     calls just got 429'd.
	//   - the [m] picker's swap.Execute reads creds fresh from the
	//     keychain anyway, but a row stranded without identity makes
	//     other code paths (detectActiveDir in particular) misbehave.
	//
	// On a successful refresh below we re-assign with the rotated pair;
	// the OLD refresh_token in `creds` was invalidated server-side the
	// moment the new one was minted, so leaving the row pointing at
	// the rotated value is what other parts of the system expect.
	row.AccessToken = creds.AccessToken
	row.RefreshToken = creds.RefreshToken
	if creds.NeedsRefresh(refreshSkew) {
		updated, rerr := refreshUnderLock(ctx, a.ConfigDir, a.AccountUUID, autoSwap, creds, src)
		if rerr != nil {
			var rl *api.RateLimitError
			if !errors.As(rerr, &rl) {
				row.Err = fmt.Errorf("token expired, refresh failed: %v (run `claude` to re-login)", rerr)
				return row
			}
			// Refresh got 429'd. If the access_token in the keychain
			// still has life — which it usually does, because we
			// refresh refreshSkew ahead of expiry — fall through to
			// FetchUsage with the existing token rather than freezing
			// the row at "refresh rate limited". The api package's
			// circuit breaker keeps the next tick from hitting the
			// network until the cooldown clears, and the row keeps
			// rendering live usage in the meantime. If the token has
			// genuinely expired, surface the rate-limit so the TUI's
			// refreshBackoff arms a countdown.
			if creds.Expired() {
				row.Err = rerr
				return row
			}
		} else {
			creds = updated
			row.AccessToken = creds.AccessToken
			row.RefreshToken = creds.RefreshToken
		}
	}
	usage, err := api.FetchUsage(ctx, creds.AccessToken)
	if err != nil {
		row.Err = err
		return row
	}
	row.Usage = usage
	return row
}

// refreshUnderLock orchestrates the OAuth refresh sequence Claude Code
// 2.1.132 implements internally, plus an extra cross-slot reconciliation
// step that's specific to our auto-swap design:
//
//  1. Acquire <configDir>/.oauth_refresh.lock (cross-process; matches
//     proper-lockfile's mkdir primitive so a concurrent `claude` tab
//     that's also refreshing this account serializes against us).
//
//  2. Re-read the per-account hashed slot inside the lock. If the
//     access_token differs from what fetchOne loaded a moment ago, a
//     parallel writer (another `claude` invocation with the same
//     CLAUDE_CONFIG_DIR, or our own previous tick) already refreshed —
//     adopt their tokens and skip the redundant POST. This is the path
//     Claude Code labels `tengu_oauth_token_refresh_race_resolved`.
//
//  3. Cross-slot peek. If accountUUID names the *active* account (the
//     one whose identity is mirrored into $HOME/.claude.json), the
//     plain slot is being kept fresh by every `claude` invocation that
//     runs without CLAUDE_CONFIG_DIR. Our hashed slot, by contrast,
//     only updates when WE refresh — so on a morning cold start, plain
//     has the rotated pair from last night's `claude` use and hashed
//     has stale tokens whose refresh_token was invalidated by that
//     same rotation. Read plain; if its expiresAt is later than the
//     hashed value's, adopt plain's tokens and persist them to the
//     hashed slot so subsequent ticks find them locally.
//
//  4. POST /v1/oauth/token. On a non-429 failure (typically
//     invalid_grant when our refresh_token has been rotated out from
//     under us), re-check both slots — same intra- and cross-slot
//     recovery as before. If either has rotated since our POST, treat
//     the failure as benign (`tengu_oauth_token_refresh_race_recovered`).
//
// Lock acquisition errors propagate up to fetchOne's "token expired,
// refresh failed" branch — they're rare enough that surfacing them
// loudly beats silently degrading to a 401 from FetchUsage.
//
// The returned creds is always the live pair: freshly refreshed values,
// racer's values picked up via re-read, plain-slot values picked up via
// cross-slot peek, or — on 429 — the original creds (so callers can
// fall through to FetchUsage with the existing access_token).
func refreshUnderLock(ctx context.Context, configDir, accountUUID string, autoSwap bool, creds *keychain.OAuthCreds, src keychain.CredSource) (*keychain.OAuthCreds, error) {
	release, err := keychain.LockOAuthRefresh(ctx, configDir)
	if err != nil {
		return creds, fmt.Errorf("acquire oauth refresh lock: %w", err)
	}
	defer release()

	// Step 2: intra-slot race-resolution.
	if fresh, _, ferr := loadForRefresh(configDir, autoSwap); ferr == nil {
		if fresh.AccessToken != creds.AccessToken {
			creds = fresh
			if !creds.NeedsRefresh(refreshSkew) {
				return creds, nil
			}
		}
	}

	// Step 3: cross-slot peek. Only meaningful when this account owns
	// the plain slot — for non-active accounts plain represents someone
	// else and is irrelevant.
	if synced := pickFromActivePlain(accountUUID, creds, src); synced != nil {
		creds = synced
		if !creds.NeedsRefresh(refreshSkew) {
			return creds, nil
		}
	}

	refreshed, rerr := refreshOAuth(ctx, creds.RefreshToken)
	if rerr != nil {
		var rl *api.RateLimitError
		if errors.As(rerr, &rl) {
			return creds, rerr
		}
		// Step 4: dual-slot race-recovery. A concurrent writer may have
		// refreshed in the narrow window between our peek and our POST,
		// either on this slot directly or — for the active account — on
		// plain. Whichever surfaces a different access_token wins.
		if fresh, _, ferr := loadForRefresh(configDir, autoSwap); ferr == nil && fresh.AccessToken != creds.AccessToken {
			return fresh, nil
		}
		if synced := pickFromActivePlain(accountUUID, creds, src); synced != nil {
			return synced, nil
		}
		return creds, rerr
	}

	creds.AccessToken = refreshed.AccessToken
	creds.RefreshToken = refreshed.RefreshToken
	creds.ExpiresAt = refreshed.ExpiresAt
	if werr := src.Persist(creds); werr != nil {
		// The refresh succeeded server-side, which means the OLD
		// refresh_token is now invalidated — but we couldn't store
		// the new one. Surface this loudly: next tick will fail
		// with invalid_grant unless persistence works on retry.
		return creds, fmt.Errorf("refreshed but persist failed: %v", werr)
	}
	return creds, nil
}

// pickFromActivePlain returns the plain slot's creds when (a) accountUUID
// is the currently-active account per $HOME/.claude.json's
// oauthAccount.accountUuid, AND (b) plain has a strictly later
// expiresAt than `current`. Persists the picked creds to the caller's
// source slot so later ticks find the rotated pair without having to
// peek plain again.
//
// The active-uuid gate matters: plain may belong to a different account
// after a swap, in which case its tokens are valid but for the wrong
// identity — adopting them would corrupt the row we're rendering. The
// uuid check guarantees we only adopt plain when its identity is ours.
//
// Returns nil when nothing should be adopted (account isn't active,
// plain is missing or older, persist failed). A persist failure is
// swallowed because the caller still has functioning creds in `current`
// — degrading silently is better than hard-failing on a best-effort sync.
func pickFromActivePlain(accountUUID string, current *keychain.OAuthCreds, src keychain.CredSource) *keychain.OAuthCreds {
	if accountUUID == "" {
		return nil
	}
	if account.ReadActiveAccountUUID() != accountUUID {
		return nil
	}
	plain, err := loadPlainKeychain()
	if err != nil || plain == nil {
		return nil
	}
	if plain.ExpiresAt <= current.ExpiresAt {
		return nil
	}
	if err := src.Persist(plain); err != nil {
		return nil
	}
	return plain
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

// loadPlainKeychain is the keychain read detectActiveDir uses for its
// refresh_token fallback. Indirected through a package-private
// variable so tests can substitute a fake without touching the real
// OS credential store. Production callers always use the default
// LoadCredentialsByService binding.
var loadPlainKeychain = func() (*keychain.OAuthCreds, error) {
	return keychain.LoadCredentialsByService(keychain.PlainServiceName)
}

// refreshOAuth is indirected through a package-private variable so
// refreshUnderLock tests can simulate refresh outcomes (success,
// invalid_grant, 429) without standing up an httptest server on every
// case. Production binds to api.RefreshOAuth.
var refreshOAuth = api.RefreshOAuth

// loadForRefresh is indirected so refreshUnderLock tests can write
// their fixture creds to a tmp .credentials.json without interference
// from the test runner's real keychain. The production fallback chain
// (hashed → plain → file) means a tmpdir's hashed service name misses
// but the plain "Claude Code-credentials" slot — if any exists on the
// runner — would leak through and shadow the test's file fixture.
// Production binds to keychain.LoadForRefresh.
var loadForRefresh = keychain.LoadForRefresh

// detectActiveDir figures out which discovered account currently owns
// the plain keychain slot. Two-step strategy:
//
//  1. accountUuid match. $HOME/.claude.json's oauthAccount.accountUuid
//     mirrors whichever account is in the plain slot — both Claude Code
//     (on /login) and our swap.syncHomeOAuthAccount keep it that way.
//     Each row carries its in-dir .claude.json's accountUuid (read once
//     at ResolveDirs time). Match the home value against rows. This is
//     the load-bearing path; it survives Claude Code refreshing the
//     plain slot's tokens between our ticks because uuids don't rotate.
//
//  2. RefreshToken match. Used as a fallback when the home file or any
//     row hasn't populated an accountUuid yet (fresh install pre-first
//     /login, .claude.json wiped, etc.). This matches the plain slot's
//     refresh_token against each row's hashed-slot refresh_token; works
//     only while plain and hashed are in sync (hasn't been rotated by
//     `claude` since the last swap), but it's still useful for
//     bootstrap.
//
// When neither path matches, the assumption is that the user has never
// run a swap — the plain slot still represents the default ~/.claude
// account, so we fall back to account.DefaultDir().
//
// Returns "" only when no fallback is meaningful (no $HOME, etc.); the
// TUI treats "" as "no ★ on any row".
func detectActiveDir(rows []account.Row) string {
	if uuid := account.ReadActiveAccountUUID(); uuid != "" {
		for _, r := range rows {
			if r.AccountUUID != "" && r.AccountUUID == uuid {
				return r.ConfigDir
			}
		}
	}
	plain, err := loadPlainKeychain()
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
