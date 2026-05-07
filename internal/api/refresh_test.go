package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestRefreshOAuthSuccess validates the full happy path: request shape
// (method, headers, JSON body), response parsing, and ExpiresAt
// conversion from expires_in seconds → unix ms.
func TestRefreshOAuthSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}
		body, _ := io.ReadAll(r.Body)
		var req refreshReq
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("decode req body: %v", err)
		}
		if req.GrantType != "refresh_token" {
			t.Errorf("grant_type = %q, want refresh_token", req.GrantType)
		}
		if req.RefreshToken != "old-rt" {
			t.Errorf("refresh_token = %q, want old-rt", req.RefreshToken)
		}
		if req.ClientID != oauthClientID {
			t.Errorf("client_id = %q, want %s", req.ClientID, oauthClientID)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"access_token": "new-at",
			"refresh_token": "new-rt",
			"expires_in": 3600,
			"scope": "user:profile",
			"token_type": "Bearer"
		}`))
	}))
	t.Cleanup(srv.Close)

	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })
	resetCircuitBreaker(t)

	before := time.Now().UnixMilli()
	got, err := RefreshOAuth(context.Background(), "old-rt")
	if err != nil {
		t.Fatalf("RefreshOAuth: %v", err)
	}
	if got.AccessToken != "new-at" {
		t.Errorf("AccessToken = %q, want new-at", got.AccessToken)
	}
	if got.RefreshToken != "new-rt" {
		t.Errorf("RefreshToken = %q, want new-rt", got.RefreshToken)
	}
	// expires_in=3600 → ExpiresAt should be ~1h from now (in ms).
	want := before + 3600*1000
	if got.ExpiresAt < want-2000 || got.ExpiresAt > want+5000 {
		t.Errorf("ExpiresAt = %d, want ~%d (±5s slack)", got.ExpiresAt, want)
	}
}

// TestRefreshOAuthInvalidGrant covers the path the user hits after a
// reused/rotated refresh_token: HTTP 400 with invalid_grant in body.
// We assert the error preserves enough of the body to diagnose.
func TestRefreshOAuthInvalidGrant(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"Refresh token revoked"}`))
	}))
	t.Cleanup(srv.Close)
	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })
	resetCircuitBreaker(t)

	_, err := RefreshOAuth(context.Background(), "stale-rt")
	if err == nil {
		t.Fatal("expected error from 400 response, got nil")
	}
	if !strings.Contains(err.Error(), "400") || !strings.Contains(err.Error(), "invalid_grant") {
		t.Errorf("error message lost detail: %q", err.Error())
	}
}

// TestRefreshOAuthMalformedJSON guards against the server returning 200
// with a body the decoder can't handle — we should not return a nil
// error in that case.
func TestRefreshOAuthMalformedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html>not json</html>`))
	}))
	t.Cleanup(srv.Close)
	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })
	resetCircuitBreaker(t)

	_, err := RefreshOAuth(context.Background(), "rt")
	if err == nil {
		t.Fatal("expected decode error, got nil")
	}
}

// TestRefreshOAuth429ReturnsRateLimitError covers the most common
// failure mode in this repo's actual use: many accounts expire at the
// same minute (24h-cohort effect), the dashboard fires N parallel
// refreshes from one IP, Anthropic's OAuth endpoint replies 429.
// We must surface a *RateLimitError so the TUI's existing per-account
// backoff arms — otherwise we hammer the limiter every tick.
func TestRefreshOAuth429ReturnsRateLimitError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "45")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"type":"rate_limit_error","message":"Rate limited."}}`))
	}))
	t.Cleanup(srv.Close)
	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })

	resetCircuitBreaker(t)
	_, err := RefreshOAuth(context.Background(), "rt")
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("err = %v, want *RateLimitError", err)
	}
	// Header says 45s; jitter is ±20% (so [36s, 54s]).
	if rl.RetryAfter < 36*time.Second || rl.RetryAfter > 54*time.Second {
		t.Errorf("RetryAfter = %s, want 45s ±20%% jitter", rl.RetryAfter)
	}
	if !strings.Contains(rl.Body, "rate_limit_error") {
		t.Errorf("Body lost detail: %q", rl.Body)
	}
}

// TestRefreshOAuth429NoHeaderUsesDefault covers the realistic case:
// Anthropic's OAuth endpoint replies 429 *without* a Retry-After
// header. We must fall back to a conservative default so the dashboard
// actually pauses long enough to clear the limiter.
func TestRefreshOAuth429NoHeaderUsesDefault(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"type":"rate_limit_error","message":"Rate limited."}}`))
	}))
	t.Cleanup(srv.Close)
	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })

	resetCircuitBreaker(t)
	_, err := RefreshOAuth(context.Background(), "rt")
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("err = %v, want *RateLimitError", err)
	}
	// First 429 with no Retry-After uses refreshBaseBackoff (60s);
	// jitter ±20% gives [48s, 72s].
	low := time.Duration(float64(refreshBaseBackoff) * 0.8)
	high := time.Duration(float64(refreshBaseBackoff) * 1.2)
	if rl.RetryAfter < low || rl.RetryAfter > high {
		t.Errorf("RetryAfter = %s, want base %s ±20%%", rl.RetryAfter, refreshBaseBackoff)
	}
}

// TestRefreshOAuth429ExponentialBackoff covers the escalation behavior:
// each consecutive 429 from the network (not the breaker synthetic)
// doubles the backoff, capped at refreshMaxBackoff. This avoids
// hammering a sticky limiter with the same 60s probes forever.
func TestRefreshOAuth429ExponentialBackoff(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	t.Cleanup(srv.Close)
	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })
	resetCircuitBreaker(t)

	// We can't observe successive *real* 429s without resetting the
	// breaker between calls, since the second call would short-circuit.
	// Reset rateLimitedUntil between calls but leave consecutive429
	// alone so the exp escalation is visible. Also reset
	// lastRefreshNetwork so the inter-call throttle doesn't add a
	// real 1.5s sleep between every iteration of this test.
	bypass := func() {
		refreshMu.Lock()
		rateLimitedUntil = time.Time{}
		lastRefreshNetwork = time.Time{}
		refreshMu.Unlock()
	}

	wantBase := []time.Duration{
		refreshBaseBackoff,     // 1st: 60s
		refreshBaseBackoff * 2, // 2nd: 120s
		refreshBaseBackoff * 4, // 3rd: 240s — already > 3min cap
		refreshMaxBackoff,      // 4th: capped
	}
	for i, want := range wantBase {
		bypass()
		_, err := RefreshOAuth(context.Background(), "rt")
		var rl *RateLimitError
		if !errors.As(err, &rl) {
			t.Fatalf("attempt %d: err = %v, want *RateLimitError", i+1, err)
		}
		expect := min(want, refreshMaxBackoff)
		low := time.Duration(float64(expect) * 0.8)
		high := time.Duration(float64(expect) * 1.2)
		if rl.RetryAfter < low || rl.RetryAfter > high {
			t.Errorf("attempt %d: RetryAfter = %s, want %s ±20%%", i+1, rl.RetryAfter, expect)
		}
	}
}

// TestRefreshOAuth429HonorsServerRetryAfter validates that an explicit
// Retry-After header overrides the exp-backoff schedule. If Anthropic
// ever does send one, we should trust it.
func TestRefreshOAuth429HonorsServerRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	t.Cleanup(srv.Close)
	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })
	resetCircuitBreaker(t)

	_, err := RefreshOAuth(context.Background(), "rt")
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("err = %v, want *RateLimitError", err)
	}
	// 30s ±20% jitter.
	if rl.RetryAfter < 24*time.Second || rl.RetryAfter > 36*time.Second {
		t.Errorf("RetryAfter = %s, want 30s ±20%%", rl.RetryAfter)
	}
}

// resetCircuitBreaker clears process-wide refresh rate-limit state so
// each test starts in a known-good state. Without this, a 429 in one
// test arms rateLimitedUntil and the next test's request would
// short-circuit without hitting its httptest server. Also clears
// lastRefreshNetwork so the throttle doesn't make a fresh test sleep
// for refreshMinInterval before its first call.
func resetCircuitBreaker(t *testing.T) {
	t.Helper()
	refreshMu.Lock()
	rateLimitedUntil = time.Time{}
	consecutive429 = 0
	lastRefreshNetwork = time.Time{}
	refreshMu.Unlock()
	t.Cleanup(func() {
		refreshMu.Lock()
		rateLimitedUntil = time.Time{}
		consecutive429 = 0
		lastRefreshNetwork = time.Time{}
		refreshMu.Unlock()
	})
}

// TestRefreshOAuthCircuitBreaker validates the process-wide breaker:
// once one refresh returns 429, subsequent refreshes during the
// cooldown short-circuit and DON'T hit the network. This is what
// prevents an "8-account expired at midnight" scenario from making 8
// sequential network requests that each re-trip the limiter.
func TestRefreshOAuthCircuitBreaker(t *testing.T) {
	resetCircuitBreaker(t)
	var requests int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"type":"rate_limit_error"}}`))
	}))
	t.Cleanup(srv.Close)
	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })

	// First call: hits the network, gets 429, arms the breaker.
	_, err1 := RefreshOAuth(context.Background(), "rt")
	if _, ok := err1.(*RateLimitError); !ok {
		t.Fatalf("first call: err = %v, want *RateLimitError", err1)
	}
	// Subsequent calls during the cooldown: must NOT hit the network.
	for range 5 {
		_, err := RefreshOAuth(context.Background(), "rt")
		var rl *RateLimitError
		if !errors.As(err, &rl) {
			t.Fatalf("expected *RateLimitError from breaker, got %v", err)
		}
		if !strings.Contains(rl.Body, "circuit-broken") {
			t.Errorf("Body = %q, want circuit-broken marker", rl.Body)
		}
	}
	if got := atomic.LoadInt32(&requests); got != 1 {
		t.Errorf("server saw %d requests, want exactly 1 (others should short-circuit)", got)
	}
}

// TestRefreshOAuthSerialized verifies the package-level mutex actually
// serializes concurrent refresh calls. Without it, a tick where N
// accounts are all expired would fire N parallel POSTs, which is
// exactly what trips the OAuth limiter. We assert the server never
// sees overlapping in-flight requests.
func TestRefreshOAuthSerialized(t *testing.T) {
	resetCircuitBreaker(t)
	// The throttle is orthogonal to serialization: drop it to zero so
	// 6 calls don't take 6 × refreshMinInterval (~9s) when all the
	// test cares about is in-flight peak == 1.
	prevMin := refreshMinInterval
	refreshMinInterval = 0
	t.Cleanup(func() { refreshMinInterval = prevMin })
	var inflight, peak int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		now := atomic.AddInt32(&inflight, 1)
		for {
			p := atomic.LoadInt32(&peak)
			if now <= p || atomic.CompareAndSwapInt32(&peak, p, now) {
				break
			}
		}
		// Hold the request open briefly so any overlap would show up.
		time.Sleep(20 * time.Millisecond)
		atomic.AddInt32(&inflight, -1)
		_, _ = w.Write([]byte(`{"access_token":"a","refresh_token":"r","expires_in":3600}`))
	}))
	t.Cleanup(srv.Close)
	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })

	const N = 6
	done := make(chan struct{}, N)
	for range N {
		go func() {
			_, _ = RefreshOAuth(context.Background(), "rt")
			done <- struct{}{}
		}()
	}
	for range N {
		<-done
	}
	if got := atomic.LoadInt32(&peak); got != 1 {
		t.Errorf("peak in-flight = %d, want 1 (refreshMu should serialize)", got)
	}
}

// TestRefreshOAuth429SourceTagged asserts every 429 path (network
// response AND circuit-breaker synthetic) tags the error with
// Source="refresh". The TUI uses this tag to decide whether to arm
// m.backoff — refresh-source 429s must NOT block FetchUsage on the
// next tick, otherwise the dashboard sits at "rate limited" even
// after Claude Code (or another process) refreshes the token in the
// keychain. Reproducing the bug the user hit on 2026-05-07.
func TestRefreshOAuth429SourceTagged(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"type":"rate_limit_error"}}`))
	}))
	t.Cleanup(srv.Close)
	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })
	resetCircuitBreaker(t)

	// Network 429.
	_, err := RefreshOAuth(context.Background(), "rt")
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("network 429: err = %v, want *RateLimitError", err)
	}
	if rl.Source != "refresh" {
		t.Errorf("network 429: Source = %q, want refresh", rl.Source)
	}
	if !strings.Contains(rl.Error(), "refresh rate limited") {
		t.Errorf("Error() = %q, want 'refresh rate limited' prefix", rl.Error())
	}

	// Synthetic 429 from circuit breaker (no network call).
	_, err = RefreshOAuth(context.Background(), "rt")
	if !errors.As(err, &rl) {
		t.Fatalf("breaker 429: err = %v, want *RateLimitError", err)
	}
	if rl.Source != "refresh" {
		t.Errorf("breaker 429: Source = %q, want refresh", rl.Source)
	}
}

// TestRefreshOAuthThrottlesConsecutiveCalls verifies the inter-call
// throttle: two back-to-back successful refreshes must be spaced by
// at least refreshMinInterval at the *server*, even though the mutex
// would otherwise let the second goroutine fire ~immediately after
// the first releases it. This is the safety net for cold-start
// cohorts where N tokens all expired overnight and the proactive
// 5min skew couldn't help.
func TestRefreshOAuthThrottlesConsecutiveCalls(t *testing.T) {
	resetCircuitBreaker(t)
	// Use a shrunk-but-observable interval so the test stays fast
	// while still proving the throttle fires.
	prevMin := refreshMinInterval
	refreshMinInterval = 200 * time.Millisecond
	t.Cleanup(func() { refreshMinInterval = prevMin })

	var arrivals []time.Time
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		arrivals = append(arrivals, time.Now())
		mu.Unlock()
		_, _ = w.Write([]byte(`{"access_token":"a","refresh_token":"r","expires_in":3600}`))
	}))
	t.Cleanup(srv.Close)
	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })

	// Three calls back-to-back. First has no prior call so it fires
	// immediately; calls 2 and 3 must each be ≥ refreshMinInterval
	// after the previous arrival.
	for range 3 {
		if _, err := RefreshOAuth(context.Background(), "rt"); err != nil {
			t.Fatalf("RefreshOAuth: %v", err)
		}
	}

	if len(arrivals) != 3 {
		t.Fatalf("got %d arrivals, want 3", len(arrivals))
	}
	for i := 1; i < len(arrivals); i++ {
		gap := arrivals[i].Sub(arrivals[i-1])
		// Allow a tiny scheduling slop downward (timer rounding can
		// undershoot by a few ms on busy CI runners) but flag any
		// gap meaningfully shorter than the configured interval.
		if gap < refreshMinInterval-20*time.Millisecond {
			t.Errorf("arrival[%d]-arrival[%d] = %s, want ≥ %s (throttle should space calls out)",
				i, i-1, gap, refreshMinInterval)
		}
	}
}

// TestRefreshOAuthThrottleRespectsContext verifies that a caller can
// cancel out of the throttle's sleep — without this, a Quit during
// the morning rush could hang for refreshMinInterval per pending
// goroutine before the program shuts down.
func TestRefreshOAuthThrottleRespectsContext(t *testing.T) {
	resetCircuitBreaker(t)
	prevMin := refreshMinInterval
	refreshMinInterval = 2 * time.Second
	t.Cleanup(func() { refreshMinInterval = prevMin })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"a","refresh_token":"r","expires_in":3600}`))
	}))
	t.Cleanup(srv.Close)
	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })

	// First call sets lastRefreshNetwork.
	if _, err := RefreshOAuth(context.Background(), "rt"); err != nil {
		t.Fatalf("first RefreshOAuth: %v", err)
	}

	// Second call would normally sleep ~2s; cancel the context after
	// 100ms and verify the call returns promptly with ctx.Err().
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	_, err := RefreshOAuth(ctx, "rt")
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("expected error from cancelled context, got nil")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}
	// Should bail out within ~150ms (the 100ms sleep + small slop),
	// well before the configured 2s wait.
	if elapsed > 500*time.Millisecond {
		t.Errorf("elapsed = %s, want < 500ms (throttle should bail on ctx cancel)", elapsed)
	}
}

// TestRefreshOAuthMissingTokens covers the partial-success case: 200
// but the response is missing either access_token or refresh_token.
// Treating this as success would persist an empty creds blob and
// silently break the next tick — make sure we error out instead.
func TestRefreshOAuthMissingTokens(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// access_token present, refresh_token missing.
		_, _ = w.Write([]byte(`{"access_token":"a","expires_in":3600}`))
	}))
	t.Cleanup(srv.Close)
	prev := tokenEndpoint
	tokenEndpoint = srv.URL
	t.Cleanup(func() { tokenEndpoint = prev })
	resetCircuitBreaker(t)

	_, err := RefreshOAuth(context.Background(), "rt")
	if err == nil {
		t.Fatal("expected error for missing refresh_token, got nil")
	}
}
