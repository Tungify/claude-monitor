package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Constants pulled from codex-rs/login/src/auth/manager.rs (Codex CLI's
// canonical login source). The client_id is a *public* OAuth client
// embedded in Codex builds — same trust model as Anthropic's:
// loopback PKCE; no secret to leak.
//
//	const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
//	const REFRESH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
//
// openaiTokenEndpoint is a var (not const) only so the test suite can
// point it at httptest.NewServer; production callers never mutate it.
var openaiTokenEndpoint = "https://auth.openai.com/oauth/token"

const openaiClientID = "app_EMoamEEZ73f0CkXaXp7hrann"

// OpenAIRefreshedTokens is the subset of Codex's RefreshResponse we
// persist. Unlike Anthropic's refresh response, OpenAI doesn't return
// an `expires_in` — Codex derives expiry from the id_token JWT's `exp`
// claim, and so do we. The decoded expiry is passed back here so the
// caller can write a single coherent snapshot to disk without
// re-parsing the JWT.
type OpenAIRefreshedTokens struct {
	IDToken      string
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time // zero when the new id_token has no exp claim
}

type openaiRefreshReq struct {
	ClientID     string `json:"client_id"`
	GrantType    string `json:"grant_type"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope,omitempty"`
}

type openaiRefreshResp struct {
	IDToken      string `json:"id_token"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

// RefreshOpenAI swaps a long-lived refresh_token for a fresh access /
// id / refresh token triple against auth.openai.com.
//
// The Anthropic side's process-wide throttle (refreshMu, the inter-call
// interval, and the 429 circuit-breaker) is intentionally REUSED here:
// although the two providers have separate rate-limit windows server-
// side, the throttle's purpose is to keep this PROCESS from bursting a
// thundering herd of refreshes at any one provider when N accounts on
// the same machine expire in the same minute. Serializing across both
// providers costs ~3s per refresh extra at worst and avoids re-deriving
// the same machinery for OpenAI.
//
// Returns:
//   - HTTP 429 → *RateLimitError with Source="refresh"; the same circuit
//     breaker arms so subsequent calls short-circuit during cooldown.
//   - other non-2xx → plain error with body preview.
//   - missing tokens in a 200 → plain error (refresh_token is rotated
//     server-side on success, so callers MUST persist the new pair or
//     the next refresh fails with invalid_grant).
func RefreshOpenAI(ctx context.Context, oldRefresh string) (*OpenAIRefreshedTokens, error) {
	refreshMu.Lock()
	defer refreshMu.Unlock()

	if remaining := time.Until(rateLimitedUntil); remaining > 0 {
		return nil, &RateLimitError{
			RetryAfter: remaining,
			Body:       "circuit-broken: prior 429 cooldown in effect",
			Source:     "refresh",
		}
	}

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

	body, _ := json.Marshal(openaiRefreshReq{
		ClientID:     openaiClientID,
		GrantType:    "refresh_token",
		RefreshToken: oldRefresh,
		Scope:        "openid profile email",
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, openaiTokenEndpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		logRefreshOutcome(fmt.Sprintf("openai network error: %v", err))
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusTooManyRequests {
		serverHint := parseRetryAfter(resp.Header.Get("Retry-After"), 0)
		var base time.Duration
		if serverHint > 0 {
			base = serverHint
			consecutive429 = 0
		} else {
			consecutive429++
			shift := min(consecutive429-1, 5)
			base = min(refreshBaseBackoff<<shift, refreshMaxBackoff)
		}
		jittered := jitter(base, 0.2)
		rateLimitedUntil = time.Now().Add(jittered)
		logRefreshOutcome(fmt.Sprintf("openai 429 retry-after=%q backoff=%s body=%s",
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
		logRefreshOutcome(fmt.Sprintf("openai HTTP %d body=%s", resp.StatusCode, trimForLog(string(raw))))
		return nil, fmt.Errorf("openai refresh HTTP %d: %s", resp.StatusCode, preview)
	}
	var r openaiRefreshResp
	if err := json.Unmarshal(raw, &r); err != nil {
		logRefreshOutcome(fmt.Sprintf("openai decode error: %v body=%s", err, trimForLog(string(raw))))
		return nil, fmt.Errorf("decode openai refresh response: %w", err)
	}
	if r.AccessToken == "" || r.RefreshToken == "" {
		logRefreshOutcome(fmt.Sprintf("openai 200 but tokens missing body=%s", trimForLog(string(raw))))
		return nil, fmt.Errorf("openai refresh response missing tokens")
	}
	rateLimitedUntil = time.Time{}
	consecutive429 = 0
	out := &OpenAIRefreshedTokens{
		IDToken:      r.IDToken,
		AccessToken:  r.AccessToken,
		RefreshToken: r.RefreshToken,
	}
	if exp := decodeJWTExp(r.IDToken); !exp.IsZero() {
		out.ExpiresAt = exp
	}
	logRefreshOutcome(fmt.Sprintf("openai 200 OK expires_at=%s",
		out.ExpiresAt.Format(time.RFC3339)))
	return out, nil
}

// decodeJWTExp pulls the `exp` claim out of a JWT payload without
// verifying the signature. Duplicated here (instead of imported from
// internal/codex) so the api package stays a leaf — the codex package
// depends on api at refresh time, and pulling codex back in would
// create a cycle.
func decodeJWTExp(jwt string) time.Time {
	if jwt == "" {
		return time.Time{}
	}
	parts := splitJWT(jwt)
	if len(parts) < 2 {
		return time.Time{}
	}
	payload, err := base64URLDecode(parts[1])
	if err != nil {
		return time.Time{}
	}
	var raw struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return time.Time{}
	}
	if raw.Exp <= 0 {
		return time.Time{}
	}
	return time.Unix(raw.Exp, 0)
}
