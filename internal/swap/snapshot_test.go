package swap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/api"
	"claude-monitor/internal/keychain"
)

// stubPlainKeychain replaces the package-private loadPlainKeychain with
// a fixed return value for the duration of the test. Returning the
// restore function as a t.Cleanup keeps the global swap from leaking
// across cases when tests run in parallel under -race.
func stubPlainKeychain(t *testing.T, creds *keychain.OAuthCreds, err error) {
	t.Helper()
	prev := loadPlainKeychain
	loadPlainKeychain = func() (*keychain.OAuthCreds, error) {
		return creds, err
	}
	t.Cleanup(func() { loadPlainKeychain = prev })
}

// writeHomeClaudeJSON drops a $HOME/.claude.json containing the given
// oauthAccount.accountUuid. Used by every test that exercises the
// uuid-match fast path — that path reads $HOME directly via
// account.ReadActiveAccountUUID.
func writeHomeClaudeJSON(t *testing.T, home, uuid string) {
	t.Helper()
	body := `{"oauthAccount":{"accountUuid":"` + uuid + `"}}`
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(body), 0o600); err != nil {
		t.Fatalf("write home claude.json: %v", err)
	}
}

// TestDetectActiveDirUUIDMatch is the load-bearing case: the home file
// names an accountUuid, exactly one row carries that uuid, and the
// match wins regardless of refresh_token state. This is the path that
// fixes the bug where `claude` independently rotating the plain slot
// drifted the ★ marker onto the default account.
func TestDetectActiveDirUUIDMatch(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	writeHomeClaudeJSON(t, tmp, "uuid-be3")

	// Stub keychain with a refresh_token that matches NO row, to prove
	// the uuid path returns before the refresh_token fallback fires.
	stubPlainKeychain(t, &keychain.OAuthCreds{RefreshToken: "rotated-out-of-sync-token"}, nil)

	rows := []account.Row{
		{Name: "claude", ConfigDir: "/h/.claude", AccountUUID: "uuid-default", RefreshToken: "default-refresh"},
		{Name: "claude-be3", ConfigDir: "/h/.claude-be3", AccountUUID: "uuid-be3", RefreshToken: "be3-refresh"},
	}
	got := detectActiveDir(rows)
	if got != "/h/.claude-be3" {
		t.Errorf("active = %q, want /h/.claude-be3 (uuid match)", got)
	}
}

// TestDetectActiveDirDefaultRowMissingUUIDDoesNotSpuriouslyMatch pins
// the precise bug we set out to fix: when default's in-dir backup is
// absent, its AccountUUID is empty. If detectActiveDir treated empty
// as "matches anything", it would return the default row whenever the
// home json had any uuid — which is exactly the silent-revert
// behavior we're getting rid of. Empty must NOT match.
func TestDetectActiveDirDefaultRowMissingUUIDDoesNotSpuriouslyMatch(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	writeHomeClaudeJSON(t, tmp, "uuid-be3")

	stubPlainKeychain(t, nil, os.ErrNotExist)

	rows := []account.Row{
		// Default-dir row, no in-dir backup → AccountUUID is "".
		{Name: "claude", ConfigDir: "/h/.claude", AccountUUID: "", RefreshToken: ""},
		{Name: "claude-be3", ConfigDir: "/h/.claude-be3", AccountUUID: "uuid-be3", RefreshToken: ""},
	}
	got := detectActiveDir(rows)
	if got != "/h/.claude-be3" {
		t.Errorf("active = %q, want /h/.claude-be3 (default's empty UUID must not spuriously match)", got)
	}
}

// TestDetectActiveDirRefreshTokenFallback covers the bootstrap path:
// fresh install, .claude.json has no oauthAccount yet, but the plain
// keychain slot is in sync with one of the hashed entries (no rotation
// has happened since first login). The refresh_token comparison is the
// only signal available, and it should still pick the right row.
func TestDetectActiveDirRefreshTokenFallback(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	// No $HOME/.claude.json → ReadActiveAccountUUID returns "" → uuid
	// path is skipped, fallback takes over.

	stubPlainKeychain(t, &keychain.OAuthCreds{RefreshToken: "be3-refresh"}, nil)

	rows := []account.Row{
		{Name: "claude", ConfigDir: "/h/.claude", AccountUUID: "", RefreshToken: "default-refresh"},
		{Name: "claude-be3", ConfigDir: "/h/.claude-be3", AccountUUID: "", RefreshToken: "be3-refresh"},
	}
	got := detectActiveDir(rows)
	if got != "/h/.claude-be3" {
		t.Errorf("active = %q, want /h/.claude-be3 (refresh_token fallback)", got)
	}
}

// TestDetectActiveDirFallsBackToDefaultDir covers the worst case: home
// json is missing AND the plain slot's refresh_token matches no row
// (the historical bug scenario). With no signal, we surrender to
// account.DefaultDir() — at least the user sees ★ on a real row,
// even if it's not necessarily the active one.
func TestDetectActiveDirFallsBackToDefaultDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	stubPlainKeychain(t, &keychain.OAuthCreds{RefreshToken: "stranded-token"}, nil)

	rows := []account.Row{
		{Name: "claude", ConfigDir: filepath.Join(tmp, ".claude"), AccountUUID: "", RefreshToken: "x"},
		{Name: "claude-be3", ConfigDir: filepath.Join(tmp, ".claude-be3"), AccountUUID: "", RefreshToken: "y"},
	}
	got := detectActiveDir(rows)
	want := filepath.Join(tmp, ".claude")
	if got != want {
		t.Errorf("active = %q, want %q (DefaultDir fallback)", got, want)
	}
}

// writeCredsFile drops a Claude-Code-shaped .credentials.json into
// configDir so LoadForRefresh's file fallback finds it. The hashed
// keychain service name for a tmpdir path is sha256-derived and won't
// collide with any real entry on the test runner, so the keychain
// primary path misses and we exercise the file backend deterministically.
func writeCredsFile(t *testing.T, configDir string, creds *keychain.OAuthCreds) {
	t.Helper()
	envelope := map[string]any{"claudeAiOauth": creds}
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	if err := os.WriteFile(filepath.Join(configDir, ".credentials.json"), body, 0o600); err != nil {
		t.Fatalf("write .credentials.json: %v", err)
	}
}

// stubRefreshOAuth swaps the package-level refreshOAuth indirection
// for the duration of a test. Returning via t.Cleanup keeps cases
// hermetic when run with -race / -parallel.
func stubRefreshOAuth(t *testing.T, fn func(ctx context.Context, rt string) (*api.RefreshedTokens, error)) {
	t.Helper()
	prev := refreshOAuth
	refreshOAuth = fn
	t.Cleanup(func() { refreshOAuth = prev })
}

// stubLoadForRefresh routes refreshUnderLock's keychain reads through
// a fake whose only source of truth is <configDir>/.credentials.json.
// Without this, the test runner's real macOS keychain "Claude Code-
// credentials" entry leaks through (LoadForRefresh's hashed→plain→file
// fallback chain hits the user's real plain slot when the tmp hashed
// service is absent), shadowing the test's fixture.
func stubLoadForRefreshFromFile(t *testing.T) {
	t.Helper()
	prev := loadForRefresh
	loadForRefresh = func(configDir string, hashedFirst bool) (*keychain.OAuthCreds, keychain.CredSource, error) {
		path := filepath.Join(configDir, ".credentials.json")
		body, err := os.ReadFile(path)
		if err != nil {
			return nil, keychain.CredSource{}, err
		}
		var env struct {
			ClaudeAiOauth keychain.OAuthCreds `json:"claudeAiOauth"`
		}
		if err := json.Unmarshal(body, &env); err != nil {
			return nil, keychain.CredSource{}, err
		}
		c := env.ClaudeAiOauth
		return &c, keychain.CredSource{File: path}, nil
	}
	t.Cleanup(func() { loadForRefresh = prev })
}

// TestRefreshUnderLockHappyPath: the simple case where no race
// happens — refresh succeeds, the rotated pair gets persisted to the
// same slot we read from, and the returned creds carry the new tokens.
func TestRefreshUnderLockHappyPath(t *testing.T) {
	tmp := t.TempDir()
	stubLoadForRefreshFromFile(t)
	old := &keychain.OAuthCreds{
		AccessToken:  "old-at",
		RefreshToken: "old-rt",
		ExpiresAt:    time.Now().Add(time.Minute).UnixMilli(), // within refreshSkew
	}
	writeCredsFile(t, tmp, old)

	stubRefreshOAuth(t, func(ctx context.Context, rt string) (*api.RefreshedTokens, error) {
		if rt != "old-rt" {
			t.Errorf("refresh got rt = %q, want old-rt", rt)
		}
		return &api.RefreshedTokens{
			AccessToken:  "new-at",
			RefreshToken: "new-rt",
			ExpiresAt:    time.Now().Add(time.Hour).UnixMilli(),
		}, nil
	})

	creds, src, err := loadForRefresh(tmp, false)
	if err != nil {
		t.Fatalf("loadForRefresh: %v", err)
	}

	got, err := refreshUnderLock(context.Background(), tmp, "", false,creds, src)
	if err != nil {
		t.Fatalf("refreshUnderLock: %v", err)
	}
	if got.AccessToken != "new-at" || got.RefreshToken != "new-rt" {
		t.Errorf("returned creds = %+v, want new-at/new-rt", got)
	}
	persisted, _, err := loadForRefresh(tmp, false)
	if err != nil {
		t.Fatalf("re-loadForRefresh: %v", err)
	}
	if persisted.AccessToken != "new-at" || persisted.RefreshToken != "new-rt" {
		t.Errorf("persisted creds = %+v, want new-at/new-rt (Persist must hit the same slot we read from)", persisted)
	}
}

// TestRefreshUnderLockRaceResolved simulates a parallel writer
// (another claude tab, or our own previous tick) refreshing the slot
// in the window between fetchOne's load and our lock acquisition.
// We must adopt their tokens via the post-lock re-read and skip the
// redundant POST entirely — refreshOAuth must not be called.
func TestRefreshUnderLockRaceResolved(t *testing.T) {
	tmp := t.TempDir()
	stubLoadForRefreshFromFile(t)
	stale := &keychain.OAuthCreds{
		AccessToken:  "stale-at",
		RefreshToken: "stale-rt",
		ExpiresAt:    time.Now().Add(time.Minute).UnixMilli(),
	}
	// fetchOne loaded `stale` a moment ago. Now simulate a race: by
	// the time we hit refreshUnderLock the on-disk file already has
	// fresh tokens written by another writer.
	fresh := &keychain.OAuthCreds{
		AccessToken:  "fresh-at",
		RefreshToken: "fresh-rt",
		ExpiresAt:    time.Now().Add(time.Hour).UnixMilli(), // past refreshSkew
	}
	writeCredsFile(t, tmp, fresh)

	var refreshCalls int32
	stubRefreshOAuth(t, func(ctx context.Context, rt string) (*api.RefreshedTokens, error) {
		atomic.AddInt32(&refreshCalls, 1)
		t.Errorf("refreshOAuth must NOT be called when race is resolved (rt=%q)", rt)
		return nil, fmt.Errorf("should not be called")
	})

	src := keychain.CredSource{File: filepath.Join(tmp, ".credentials.json")}
	got, err := refreshUnderLock(context.Background(), tmp, "", false,stale, src)
	if err != nil {
		t.Fatalf("refreshUnderLock: %v", err)
	}
	if got.AccessToken != "fresh-at" {
		t.Errorf("returned creds = %+v, want fresh-at (race-resolved)", got)
	}
	if n := atomic.LoadInt32(&refreshCalls); n != 0 {
		t.Errorf("refreshOAuth call count = %d, want 0", n)
	}
}

// TestRefreshUnderLockRaceRecovered: the narrower race window where
// our re-read still saw stale tokens, our POST went out, but the
// server (or a parallel writer) rotated the refresh_token before our
// POST landed — so we hit invalid_grant. The recovery branch re-reads
// once more; if the keychain has rotated since our POST started, treat
// the failure as benign and adopt the racer's pair.
func TestRefreshUnderLockRaceRecovered(t *testing.T) {
	tmp := t.TempDir()
	stubLoadForRefreshFromFile(t)
	stale := &keychain.OAuthCreds{
		AccessToken:  "stale-at",
		RefreshToken: "stale-rt",
		ExpiresAt:    time.Now().Add(time.Minute).UnixMilli(),
	}
	writeCredsFile(t, tmp, stale)

	stubRefreshOAuth(t, func(ctx context.Context, rt string) (*api.RefreshedTokens, error) {
		// Simulate the racer landing their rotation BETWEEN our re-read
		// (which still saw `stale`) and our POST returning. Write the
		// fresh pair to disk before returning invalid_grant.
		racer := &keychain.OAuthCreds{
			AccessToken:  "racer-at",
			RefreshToken: "racer-rt",
			ExpiresAt:    time.Now().Add(time.Hour).UnixMilli(),
		}
		writeCredsFile(t, tmp, racer)
		return nil, fmt.Errorf("refresh HTTP 400: invalid_grant")
	})

	src := keychain.CredSource{File: filepath.Join(tmp, ".credentials.json")}
	got, err := refreshUnderLock(context.Background(), tmp, "", false,stale, src)
	if err != nil {
		t.Fatalf("refreshUnderLock: %v (expected race-recovered, no error)", err)
	}
	if got.AccessToken != "racer-at" {
		t.Errorf("returned creds = %+v, want racer-at (race-recovered)", got)
	}
}

// TestRefreshUnderLockRateLimitFallsThrough: 429 from the OAuth
// endpoint must be returned to the caller as a *RateLimitError so
// fetchOne can decide (based on creds.Expired()) whether to surface
// it or fall through to FetchUsage with the existing access_token.
// Critically, the original creds — not nil — must come back so the
// fall-through path has a token to try.
func TestRefreshUnderLockRateLimitFallsThrough(t *testing.T) {
	tmp := t.TempDir()
	stubLoadForRefreshFromFile(t)
	old := &keychain.OAuthCreds{
		AccessToken:  "still-good-at",
		RefreshToken: "rt",
		ExpiresAt:    time.Now().Add(time.Minute).UnixMilli(),
	}
	writeCredsFile(t, tmp, old)

	stubRefreshOAuth(t, func(ctx context.Context, rt string) (*api.RefreshedTokens, error) {
		return nil, &api.RateLimitError{
			RetryAfter: 30 * time.Second,
			Body:       "rate limited",
			Source:     "refresh",
		}
	})

	src := keychain.CredSource{File: filepath.Join(tmp, ".credentials.json")}
	got, rerr := refreshUnderLock(context.Background(), tmp, "", false,old, src)
	var rl *api.RateLimitError
	if !errors.As(rerr, &rl) {
		t.Fatalf("err = %v, want *RateLimitError", rerr)
	}
	if got == nil || got.AccessToken != "still-good-at" {
		t.Errorf("creds on 429 = %+v, want still-good-at preserved (fetchOne fall-through depends on this)", got)
	}
}

// TestRefreshUnderLockInvalidGrantPropagates: the path where there's
// no race to recover from. POST fails with invalid_grant, re-read finds
// the same token we sent, error must propagate so fetchOne surfaces
// "token expired, refresh failed".
func TestRefreshUnderLockInvalidGrantPropagates(t *testing.T) {
	tmp := t.TempDir()
	stubLoadForRefreshFromFile(t)
	old := &keychain.OAuthCreds{
		AccessToken:  "old-at",
		RefreshToken: "revoked-rt",
		ExpiresAt:    time.Now().Add(time.Minute).UnixMilli(),
	}
	writeCredsFile(t, tmp, old)

	stubRefreshOAuth(t, func(ctx context.Context, rt string) (*api.RefreshedTokens, error) {
		// No racer; just a genuinely revoked refresh_token.
		return nil, fmt.Errorf("refresh HTTP 400: invalid_grant")
	})

	src := keychain.CredSource{File: filepath.Join(tmp, ".credentials.json")}
	_, err := refreshUnderLock(context.Background(), tmp, "", false,old, src)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !contains(err.Error(), "invalid_grant") {
		t.Errorf("err = %v, want invalid_grant propagated", err)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// TestRefreshUnderLockCrossSlotPlainFresher pins the morning fix: a
// `claude` invocation rotated the plain slot overnight, our hashed
// slot has stale tokens whose refresh_token was already invalidated
// by that rotation. Without the cross-slot peek the refresh POST
// would 400 with invalid_grant; with it, we read plain (whose uuid
// matches this account per $HOME/.claude.json) and adopt its tokens
// directly, skipping the doomed POST.
func TestRefreshUnderLockCrossSlotPlainFresher(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	writeHomeClaudeJSON(t, tmp, "uuid-active")
	stubLoadForRefreshFromFile(t)

	// Hashed slot: stale tokens with an old expiresAt and a
	// refresh_token that — for the morning case — has already been
	// rotated out from under us by `claude`'s last refresh of plain.
	hashedDir := filepath.Join(tmp, "configdir")
	if err := os.MkdirAll(hashedDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	stale := &keychain.OAuthCreds{
		AccessToken:  "stale-at",
		RefreshToken: "stale-rt",
		ExpiresAt:    time.Now().Add(time.Minute).UnixMilli(),
	}
	writeCredsFile(t, hashedDir, stale)

	// Plain slot: rotated pair sitting fresh from claude's last refresh.
	plainCreds := &keychain.OAuthCreds{
		AccessToken:  "claude-rotated-at",
		RefreshToken: "claude-rotated-rt",
		ExpiresAt:    time.Now().Add(time.Hour).UnixMilli(), // strictly newer
	}
	stubPlainKeychain(t, plainCreds, nil)

	stubRefreshOAuth(t, func(ctx context.Context, rt string) (*api.RefreshedTokens, error) {
		t.Errorf("refreshOAuth must NOT be called when plain has fresher tokens for the active account (rt=%q)", rt)
		return nil, fmt.Errorf("should not be called")
	})

	src := keychain.CredSource{File: filepath.Join(hashedDir, ".credentials.json")}
	got, err := refreshUnderLock(context.Background(), hashedDir, "uuid-active", true, stale, src)
	if err != nil {
		t.Fatalf("refreshUnderLock: %v", err)
	}
	if got.AccessToken != "claude-rotated-at" {
		t.Errorf("returned creds = %+v, want claude-rotated-at (cross-slot peek)", got)
	}
	// Persist sanity: hashed slot now mirrors plain so future ticks
	// short-circuit without peeking.
	persisted, _, err := loadForRefresh(hashedDir, true)
	if err != nil {
		t.Fatalf("re-load hashed: %v", err)
	}
	if persisted.AccessToken != "claude-rotated-at" {
		t.Errorf("hashed not synced from plain: %+v", persisted)
	}
}

// TestRefreshUnderLockCrossSlotIgnoredForNonActive: plain may be
// fresher, but if this account isn't the one currently identified by
// $HOME/.claude.json's accountUuid then plain represents a DIFFERENT
// account and adopting its tokens would corrupt the row's identity.
// The peek must be uuid-gated.
func TestRefreshUnderLockCrossSlotIgnoredForNonActive(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	writeHomeClaudeJSON(t, tmp, "uuid-someone-else")
	stubLoadForRefreshFromFile(t)

	hashedDir := filepath.Join(tmp, "configdir")
	if err := os.MkdirAll(hashedDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	stale := &keychain.OAuthCreds{
		AccessToken:  "stale-at",
		RefreshToken: "stale-rt",
		ExpiresAt:    time.Now().Add(time.Minute).UnixMilli(),
	}
	writeCredsFile(t, hashedDir, stale)

	// Plain has fresh tokens, but they belong to "uuid-someone-else"
	// (per home file) — NOT this account ("uuid-this").
	plainCreds := &keychain.OAuthCreds{
		AccessToken:  "wrong-account-at",
		RefreshToken: "wrong-account-rt",
		ExpiresAt:    time.Now().Add(time.Hour).UnixMilli(),
	}
	stubPlainKeychain(t, plainCreds, nil)

	var refreshed bool
	stubRefreshOAuth(t, func(ctx context.Context, rt string) (*api.RefreshedTokens, error) {
		refreshed = true
		if rt != "stale-rt" {
			t.Errorf("refresh got rt = %q, want stale-rt (must use this account's, not plain's)", rt)
		}
		return &api.RefreshedTokens{
			AccessToken:  "refreshed-at",
			RefreshToken: "refreshed-rt",
			ExpiresAt:    time.Now().Add(time.Hour).UnixMilli(),
		}, nil
	})

	src := keychain.CredSource{File: filepath.Join(hashedDir, ".credentials.json")}
	got, err := refreshUnderLock(context.Background(), hashedDir, "uuid-this", true, stale, src)
	if err != nil {
		t.Fatalf("refreshUnderLock: %v", err)
	}
	if !refreshed {
		t.Error("refreshOAuth not called — cross-slot peek must NOT pick plain when uuids differ")
	}
	if got.AccessToken == "wrong-account-at" {
		t.Errorf("adopted plain's wrong-account creds: %+v", got)
	}
}

// TestRefreshUnderLockCrossSlotRecoveredAfterInvalidGrant: the second
// half of the morning fix — POST has already gone out (because the
// pre-POST peek returned nothing useful, e.g. plain was older at peek
// time but then claude rotated it during our network round trip).
// Recovery branch must check plain in addition to the hashed slot;
// without that, we'd still surface "token expired".
func TestRefreshUnderLockCrossSlotRecoveredAfterInvalidGrant(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	writeHomeClaudeJSON(t, tmp, "uuid-active")
	stubLoadForRefreshFromFile(t)

	hashedDir := filepath.Join(tmp, "configdir")
	if err := os.MkdirAll(hashedDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	stale := &keychain.OAuthCreds{
		AccessToken:  "stale-at",
		RefreshToken: "revoked-rt",
		ExpiresAt:    time.Now().Add(time.Minute).UnixMilli(),
	}
	writeCredsFile(t, hashedDir, stale)

	// At peek time plain has not-newer ExpiresAt, so peek returns nil
	// and we proceed with the POST. Mid-POST, claude rotates plain;
	// the racer's tokens are visible by the time recovery re-peeks.
	plainAtPeek := &keychain.OAuthCreds{
		AccessToken:  "stale-at",
		RefreshToken: "revoked-rt",
		ExpiresAt:    stale.ExpiresAt, // not newer ⇒ peek skips
	}
	plainAfterRacer := &keychain.OAuthCreds{
		AccessToken:  "racer-at",
		RefreshToken: "racer-rt",
		ExpiresAt:    time.Now().Add(time.Hour).UnixMilli(),
	}
	var plainState atomic.Pointer[keychain.OAuthCreds]
	plainState.Store(plainAtPeek)
	prev := loadPlainKeychain
	loadPlainKeychain = func() (*keychain.OAuthCreds, error) {
		return plainState.Load(), nil
	}
	t.Cleanup(func() { loadPlainKeychain = prev })

	stubRefreshOAuth(t, func(ctx context.Context, rt string) (*api.RefreshedTokens, error) {
		// Racer wins during our POST.
		plainState.Store(plainAfterRacer)
		return nil, fmt.Errorf("refresh HTTP 400: invalid_grant")
	})

	src := keychain.CredSource{File: filepath.Join(hashedDir, ".credentials.json")}
	got, err := refreshUnderLock(context.Background(), hashedDir, "uuid-active", true, stale, src)
	if err != nil {
		t.Fatalf("refreshUnderLock: %v (wanted recovery via cross-slot)", err)
	}
	if got.AccessToken != "racer-at" {
		t.Errorf("returned creds = %+v, want racer-at (recovered from plain)", got)
	}
}

// TestDetectActiveDirEmptyHomeUUIDFallsThroughToRefreshToken pins the
// ordering: when the home file exists but is empty/lacks accountUuid,
// the uuid match returns "" (no hit), and we should still try the
// refresh_token fallback rather than going straight to DefaultDir.
func TestDetectActiveDirEmptyHomeUUIDFallsThroughToRefreshToken(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	if err := os.WriteFile(filepath.Join(tmp, ".claude.json"), []byte(`{"foo":"bar"}`), 0o600); err != nil {
		t.Fatalf("write home: %v", err)
	}

	stubPlainKeychain(t, &keychain.OAuthCreds{RefreshToken: "be3-refresh"}, nil)

	rows := []account.Row{
		{Name: "claude", ConfigDir: "/h/.claude", AccountUUID: "uuid-default", RefreshToken: "default-refresh"},
		{Name: "claude-be3", ConfigDir: "/h/.claude-be3", AccountUUID: "uuid-be3", RefreshToken: "be3-refresh"},
	}
	got := detectActiveDir(rows)
	if got != "/h/.claude-be3" {
		t.Errorf("active = %q, want /h/.claude-be3 (refresh_token fallback after empty uuid)", got)
	}
}
