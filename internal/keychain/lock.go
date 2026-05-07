package keychain

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// oauthLockStale matches Claude Code 2.1.132's `stale: 1e4` (10s) for
// `<configDir>/.oauth_refresh.lock`. After a holder has been silent for
// this long, contenders assume it crashed and take over. Keeping the
// threshold identical means our process and concurrent `claude` tabs
// agree on when a stale lock is recoverable, so neither side stomps a
// peer that is still alive.
const oauthLockStale = 10 * time.Second

// oauthLockPoll bounds how often a contender re-tries while waiting
// for the holder to release. 100ms is short enough that a typical
// sub-second refresh is grabbed almost immediately after release, and
// long enough that the spin doesn't pin a CPU.
const oauthLockPoll = 100 * time.Millisecond

// oauthLockTimeout caps total wait time before LockOAuthRefresh
// gives up. Set to 15s so a hung-and-not-yet-stale holder (≤10s) plus
// our own refresh slack (~3s post-throttle) all fit inside the
// per-account refresh budget. Beyond that, the caller should surface
// "lock contention" as the row error rather than block FetchAll.
const oauthLockTimeout = 15 * time.Second

// LockOAuthRefresh acquires an exclusive cross-process lock on
// <configDir>/.oauth_refresh.lock, matching the path Claude Code uses
// internally (via proper-lockfile) around its own OAuth refresh
// sequence. The lock is directory-based — `os.Mkdir` returns EEXIST
// atomically when the directory already exists, which is the same
// primitive proper-lockfile uses under the hood. As a result, our
// refresh and a concurrent `claude` invocation refreshing the same
// account's slot will serialize without either side needing to know
// the other exists.
//
// Stale takeover: if the existing lock dir's mtime is older than
// oauthLockStale we remove it and retry. This bounds wait time when a
// holder crashes mid-refresh; the worst-case false positive is two
// processes briefly racing on the actual /v1/oauth/token call, which
// the api package's circuit breaker absorbs.
//
// Returns a release func that the caller MUST defer; releasing twice
// is harmless (Remove is idempotent on a missing dir). Honors ctx
// cancellation while polling so a TUI Quit during the morning rush
// doesn't strand goroutines waiting on a sibling refresh.
func LockOAuthRefresh(ctx context.Context, configDir string) (release func(), err error) {
	path := filepath.Join(configDir, ".oauth_refresh.lock")
	deadline := time.Now().Add(oauthLockTimeout)
	for {
		if err := os.Mkdir(path, 0o700); err == nil {
			return func() { _ = os.Remove(path) }, nil
		} else if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("mkdir %s: %w", path, err)
		}
		// Lock is held by someone. Either they're alive and we wait,
		// or they crashed and we steal it via stale-takeover.
		if info, statErr := os.Stat(path); statErr == nil {
			if time.Since(info.ModTime()) > oauthLockStale {
				_ = os.Remove(path)
				continue
			}
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("oauth refresh lock timeout at %s (held > %s)", path, oauthLockTimeout)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(oauthLockPoll):
		}
	}
}
