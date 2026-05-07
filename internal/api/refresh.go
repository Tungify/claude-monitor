package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Constants pulled from the bundled Claude Code binary (v2.1.132).
//
//	TOKEN_URL = `${BASE_API_URL}/v1/oauth/token`     // BASE_API_URL = console.anthropic.com
//	body      = {grant_type:"refresh_token", refresh_token:<rt>, client_id:<id>}
//	client_id = embedded UUID; this is a *public* OAuth client (no secret)
//
// The refresh_token rotates on every successful call: the old one is
// invalidated server-side as soon as a new pair is minted, so the
// caller MUST persist the response or the next refresh fails with
// invalid_grant and the user has to re-login.
// tokenEndpoint is a var (not const) only so refresh_test.go can point
// it at httptest.NewServer for full request/response coverage. The
// production value is fixed.
var tokenEndpoint = "https://console.anthropic.com/v1/oauth/token"

const oauthClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

// RefreshedTokens is the subset of the OAuth refresh response we care
// about, normalized to the same units the keychain envelope uses
// (ExpiresAt is unix ms, not the wire's expires_in seconds).
type RefreshedTokens struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    int64 // unix milliseconds
}

type refreshReq struct {
	GrantType    string `json:"grant_type"`
	RefreshToken string `json:"refresh_token"`
	ClientID     string `json:"client_id"`
}

type refreshResp struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"` // seconds
	Scope        string `json:"scope"`
	TokenType    string `json:"token_type"`
}

// refreshMu serializes calls to /v1/oauth/token globally. Anthropic's
// OAuth endpoint is IP-rate-limited aggressively: when N accounts on
// one machine all expire at the same minute (a 24h-cohort effect when
// the user logged everyone in around the same time), firing N parallel
// POSTs trips the limiter and every refresh fails with 429. Sequential
// calls take ~N × 500ms — negligible at typical N (≤10) and avoids the
// self-DDoS.
var refreshMu sync.Mutex

// rateLimitedUntil is a process-wide circuit breaker for the OAuth
// token endpoint. Once one refresh returns 429, we know the IP-level
// cooldown is in effect — every subsequent refresh from this process
// during the cooldown will *also* 429, and each of those failed
// attempts can extend the cooldown server-side. So we short-circuit:
// for the duration we got back from the 429, don't even make the
// network call — synthesize the same RateLimitError from memory.
//
// consecutive429 counts back-to-back failures from real network calls
// (not synthetics) so the next backoff doubles. Reset to zero on the
// first success.
//
// lastRefreshNetwork records the start time of the most recent network
// call (not synthetic). Used by the inter-call throttle below so a
// cohort of N expirations doesn't burst N requests against
// /v1/oauth/token in tens of milliseconds — even with refreshMu
// serializing them, sub-second back-to-back calls are exactly what
// the IP limiter penalizes.
//
// All three fields are guarded by refreshMu.
var (
	rateLimitedUntil   time.Time
	consecutive429     int
	lastRefreshNetwork time.Time
)

// refreshMinInterval is the minimum elapsed time between consecutive
// network calls to /v1/oauth/token. Enforced inside the mutex region,
// so N cold-start refreshes serialize through this throttle and take
// ~N × interval in the worst case (vs <1s of bursting that would
// otherwise trip the IP limiter and turn into a 60-180s exp-backoff
// cooldown).
//
// 3s — empirically chosen after observing that 1.5s still tripped
// Anthropic's per-IP limiter on cold-start mornings (see refresh.log
// entries showing back-to-back 2-3min backoff cascades). At 1 req per
// 3s = 20 req/min we sit comfortably under the per-minute IP budget
// even when claude tabs are concurrently refreshing their own slots.
// Steady-state cost is negligible because proactive-refresh skew (5min
// in snapshot.go) means we rarely refresh more than one account per
// tick once the cohort is staggered.
//
// Var (not const) so tests can shrink it to keep them fast — production
// callers should never mutate it. Reads/writes happen under refreshMu.
var refreshMinInterval = 3 * time.Second

// refreshBaseBackoff is the *first* backoff we apply when a 429
// arrives without a server-supplied Retry-After. Subsequent
// consecutive 429s double this (see exp logic below) up to
// refreshMaxBackoff.
//
// 60s strikes a balance: long enough that we're well below any
// reasonable per-minute IP rate limit, short enough that the user
// doesn't see a 5-min "retry in" countdown for what was a transient
// burst. If the limit is genuinely sticky, exp backoff escalates.
const (
	refreshBaseBackoff = 60 * time.Second
	refreshMaxBackoff  = 3 * time.Minute
)

// RefreshOAuth swaps a long-lived refresh_token for a fresh access_token
// + rotated refresh_token. Calls are serialized globally via refreshMu.
//
// Errors:
//   - HTTP 429 → *RateLimitError with the parsed Retry-After (or a
//     conservative default). Callers should propagate this so the TUI's
//     existing per-account backoff picks it up.
//   - HTTP 400 invalid_grant → plain error; the refresh_token has been
//     revoked or rotated out and the user must re-login.
//   - Other non-2xx → plain error with body preview.
func RefreshOAuth(ctx context.Context, oldRefresh string) (*RefreshedTokens, error) {
	refreshMu.Lock()
	defer refreshMu.Unlock()

	// Circuit breaker: if the last network call returned 429, don't
	// make another one until the cooldown elapses — synthesize the
	// same error from memory so the caller's TUI backoff still arms,
	// but we don't add to the IP-level rate-limit ledger.
	if remaining := time.Until(rateLimitedUntil); remaining > 0 {
		return nil, &RateLimitError{
			RetryAfter: remaining,
			Body:       "circuit-broken: prior 429 cooldown in effect",
			Source:     "refresh",
		}
	}

	// Inter-call throttle: enforce refreshMinInterval between the
	// start of consecutive network calls. We record at the *start*
	// (not on success) so a 429 still occupies the slot — otherwise
	// the next caller would burst right behind a failed request,
	// which is the exact pattern the limiter is rate-limiting.
	//
	// Done under the mutex on purpose: the mutex itself doesn't
	// guarantee any minimum spacing — a fast network call can release
	// it inside 100ms and the next goroutine fires immediately. The
	// throttle is what turns "serialized" into "rate-limited".
	if !lastRefreshNetwork.IsZero() {
		if since := time.Since(lastRefreshNetwork); since < refreshMinInterval {
			wait := refreshMinInterval - since
			timer := time.NewTimer(wait)
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			}
		}
	}
	lastRefreshNetwork = time.Now()

	body, _ := json.Marshal(refreshReq{
		GrantType:    "refresh_token",
		RefreshToken: oldRefresh,
		ClientID:     oauthClientID,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("anthropic-beta", oauthBeta)
	req.Header.Set("User-Agent", probeUA)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		logRefreshOutcome(fmt.Sprintf("network error: %v", err))
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusTooManyRequests {
		// Trust the server when it sends a Retry-After (rare for
		// /v1/oauth/token but spec-compliant); fall back to exp
		// backoff that escalates on consecutive failures so we don't
		// hammer a sticky limiter.
		serverHint := parseRetryAfter(resp.Header.Get("Retry-After"), 0)
		var base time.Duration
		if serverHint > 0 {
			base = serverHint
			// Server told us how long to wait — reset our exp count
			// so the next 429 (if any) starts fresh from the base.
			consecutive429 = 0
		} else {
			consecutive429++
			// 60s, 120s, 240s, ... capped at refreshMaxBackoff.
			// Cap shift to prevent overflow on pathological repeats.
			shift := min(consecutive429-1, 5)
			base = min(refreshBaseBackoff<<shift, refreshMaxBackoff)
		}
		// Jitter ±20% so per-account backoffs don't all expire on the
		// same tick and resurrect the thundering herd.
		jittered := jitter(base, 0.2)
		// Arm the process-wide circuit breaker so subsequent refresh
		// attempts during the cooldown short-circuit without hitting
		// the network.
		rateLimitedUntil = time.Now().Add(jittered)
		logRefreshOutcome(fmt.Sprintf("429 retry-after=%q backoff=%s body=%s",
			resp.Header.Get("Retry-After"), jittered.Round(time.Second), trimForLog(string(raw))))
		return nil, &RateLimitError{
			RetryAfter: jittered,
			Body:       string(raw),
			Source:     "refresh",
		}
	}
	if resp.StatusCode != http.StatusOK {
		preview := string(raw)
		if len(preview) > 200 {
			preview = preview[:200] + "…"
		}
		logRefreshOutcome(fmt.Sprintf("HTTP %d body=%s", resp.StatusCode, trimForLog(string(raw))))
		return nil, fmt.Errorf("refresh HTTP %d: %s", resp.StatusCode, preview)
	}
	var r refreshResp
	if err := json.Unmarshal(raw, &r); err != nil {
		logRefreshOutcome(fmt.Sprintf("decode error: %v body=%s", err, trimForLog(string(raw))))
		return nil, fmt.Errorf("decode refresh response: %w", err)
	}
	if r.AccessToken == "" || r.RefreshToken == "" {
		logRefreshOutcome(fmt.Sprintf("200 but tokens missing body=%s", trimForLog(string(raw))))
		return nil, fmt.Errorf("refresh response missing tokens")
	}
	// Mirror Claude Code's own conversion: expiresAt = now + expires_in*1000.
	expiresAt := time.Now().Add(time.Duration(r.ExpiresIn) * time.Second).UnixMilli()
	// Successful refresh implies the per-IP cooldown has cleared (or
	// never armed for this account). Reset the circuit breaker so a
	// stale rateLimitedUntil from earlier doesn't keep blocking the
	// remaining accounts in this tick, and reset the exp-backoff
	// counter so the next 429 (whenever it comes) starts at the base
	// again.
	rateLimitedUntil = time.Time{}
	consecutive429 = 0
	logRefreshOutcome(fmt.Sprintf("200 OK expires_in=%ds", r.ExpiresIn))
	return &RefreshedTokens{
		AccessToken:  r.AccessToken,
		RefreshToken: r.RefreshToken,
		ExpiresAt:    expiresAt,
	}, nil
}

// logRefreshOutcome appends one timestamped line per refresh attempt
// to ~/.claude-monitor/refresh.log. Best-effort: any IO failure is
// swallowed (we'd rather not break the refresh path because we
// couldn't write a log line). Never logs the request body — the
// refresh_token is a long-lived secret. Response bodies are logged
// verbatim because the diagnostics they contain (rate-limit reasons,
// invalid_grant details, retry hints) are exactly what we need to
// debug the morning-rush 429s the user kept hitting.
//
// No rotation: one line per attempt is low-volume enough that the
// file can grow unbounded for typical usage. Users delete it manually
// after debugging.
func logRefreshOutcome(line string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	dir := filepath.Join(home, ".claude-monitor")
	_ = os.MkdirAll(dir, 0o755)
	p := filepath.Join(dir, "refresh.log")
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "[%s] %s\n", time.Now().Format(time.RFC3339), line)
}

// trimForLog cleans up a response body for log inclusion: collapse
// newlines (so the log stays one-line-per-event), trim whitespace,
// and cap length so a stray HTML page doesn't blow out the file.
func trimForLog(s string) string {
	const maxLen = 500
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\n' || c == '\r' || c == '\t' {
			c = ' '
		}
		out = append(out, c)
	}
	// trim leading/trailing spaces
	start, end := 0, len(out)
	for start < end && out[start] == ' ' {
		start++
	}
	for end > start && out[end-1] == ' ' {
		end--
	}
	out = out[start:end]
	if len(out) > maxLen {
		return string(out[:maxLen]) + "…"
	}
	return string(out)
}

// jitter returns d ± frac×d, so callers staggering retries don't all
// resume on the same instant. frac=0.2 yields ±20%.
func jitter(d time.Duration, frac float64) time.Duration {
	if d <= 0 || frac <= 0 {
		return d
	}
	delta := float64(d) * frac
	// rand.Float64() ∈ [0,1), shift to [-1,+1).
	offset := (rand.Float64()*2 - 1) * delta
	return d + time.Duration(offset)
}
