package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Constants pulled from the bundled Claude Code binary (v2.1.129).
// They're considered stable enough to hardcode — Claude Code itself
// hasn't changed the OAuth beta header in months.
const (
	usageEndpoint = "https://api.anthropic.com/api/oauth/usage"
	oauthBeta     = "oauth-2025-04-20"
	probeUA       = "claude-code/2.1.129"
)

// Window matches the per-window subobjects in /api/oauth/usage. ResetsAt
// is a pointer because the server returns null for windows that don't
// apply to the current plan.
type Window struct {
	Utilization float64    `json:"utilization"`
	ResetsAt    *time.Time `json:"resets_at"`
}

type ExtraUsage struct {
	IsEnabled    bool     `json:"is_enabled"`
	MonthlyLimit *float64 `json:"monthly_limit"`
	UsedCredits  *float64 `json:"used_credits"`
	Utilization  *float64 `json:"utilization"`
	Currency     *string  `json:"currency"`
}

// Usage is the parsed response from /api/oauth/usage.
// We model only the fields the official `/usage` slash command surfaces;
// other fields (tangelo, iguana_necktie, omelette_promotional, ...) are
// internal A/B-test buckets and intentionally ignored.
type Usage struct {
	FiveHour       *Window     `json:"five_hour"`
	SevenDay       *Window     `json:"seven_day"`
	SevenDaySonnet *Window     `json:"seven_day_sonnet"`
	SevenDayOpus   *Window     `json:"seven_day_opus"`
	ExtraUsage     *ExtraUsage `json:"extra_usage"`
}

// RateLimitError is returned when an Anthropic endpoint responds with
// HTTP 429. RetryAfter is the parsed Retry-After header (or a sane
// default when the header is missing/malformed) so callers can apply
// per-account backoff instead of hammering the API.
//
// Source distinguishes which endpoint hit the limit. This matters
// because the two have independent rate-limit windows and very
// different recovery semantics:
//
//   - "usage"   — /api/oauth/usage. The token is fine, the API itself
//     is throttled; skipping the whole row until cooldown is correct.
//   - "refresh" — /v1/oauth/token. Only the refresh path is throttled;
//     if Claude Code or another process refreshes the token in the
//     meantime, the dashboard should pick up the new token immediately
//     and resume FetchUsage normally — NOT sit at "rate limited" for
//     5 min just because we tried to refresh once.
//
// Empty Source defaults to "usage" semantics for backwards compat.
type RateLimitError struct {
	RetryAfter time.Duration
	Body       string
	Source     string
}

func (e *RateLimitError) Error() string {
	if e.Source != "" && e.Source != "usage" {
		return fmt.Sprintf("%s rate limited (retry in %s)", e.Source, e.RetryAfter.Round(time.Second))
	}
	return fmt.Sprintf("rate limited (retry in %s)", e.RetryAfter.Round(time.Second))
}

// FetchUsage GETs /api/oauth/usage with the given OAuth bearer and
// decodes the response. RateLimitError is surfaced for HTTP 429 so the
// caller can apply per-account backoff; any other non-2xx is wrapped
// with a preview of the response body for diagnosability.
func FetchUsage(ctx context.Context, token string) (*Usage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, usageEndpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", oauthBeta)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", probeUA)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, &RateLimitError{
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), 60*time.Second),
			Body:       string(body),
			Source:     "usage",
		}
	}
	if resp.StatusCode != http.StatusOK {
		// Trim the response so a stray HTML page from a misroute doesn't
		// flood stderr in the table.
		preview := string(body)
		if len(preview) > 200 {
			preview = preview[:200] + "…"
		}
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, preview)
	}

	var u Usage
	if err := json.Unmarshal(body, &u); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return &u, nil
}

// parseRetryAfter handles both numeric (seconds) and HTTP-date forms of
// the Retry-After header. Anthropic generally sends seconds, but spec
// allows either. Falls back to def when the header is missing or
// unparseable.
func parseRetryAfter(h string, def time.Duration) time.Duration {
	if h == "" {
		return def
	}
	if secs, err := strconv.Atoi(h); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(h); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return def
}
