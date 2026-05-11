package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Mirrors codex's GET /wham/usage. codex itself piggybacks on this same
// endpoint to power its `/status` slash command (see codex-rs/
// codex-api/src/rate_limits.rs + backend-client/src/client.rs in
// openai/codex). The shape matches codex's `RateLimitStatusPayload`
// from codex-backend-openapi-models.
//
// Sticking to the ChatGPT (`/wham`) path-style only — the Codex
// subscription accounts we monitor are all ChatGPT-OAuth-backed, never
// raw OPENAI_API_KEY accounts.
// codexUA mimics codex's `get_codex_user_agent()` originator prefix so
// the backend treats us as a first-party client (the
// `is_first_party_originator` check covers `codex_cli_rs`). Mimicking
// the upstream codex CLI version is a deliberate fingerprint match:
// surfacing "claude-monitor" in the UA would invite explicit blocking,
// and the request shape is otherwise identical to what codex itself
// sends.
const codexUA = "codex_cli_rs/0.50.0"

// codexUsageEndpoint is a var (not a const) so tests can redirect it
// to an httptest server. Production reads the public ChatGPT backend.
var codexUsageEndpoint = "https://chatgpt.com/backend-api/wham/usage"

// codexUsagePayload is the JSON `/wham/usage` returns. Only the fields
// we surface in the TUI are modeled; codex's `additional_rate_limits`
// (per-feature throttles for cloud-tasks/imagegen) is intentionally
// ignored — the monitor only cares about the primary chat rate-limit
// pair (5h + weekly).
type codexUsagePayload struct {
	PlanType  string           `json:"plan_type"`
	RateLimit *codexRateLimit  `json:"rate_limit"`
	Credits   *codexCredits    `json:"credits"`
	Reached   *codexReachedTag `json:"rate_limit_reached_type"`
}

type codexRateLimit struct {
	Allowed         bool         `json:"allowed"`
	LimitReached    bool         `json:"limit_reached"`
	PrimaryWindow   *codexWindow `json:"primary_window"`
	SecondaryWindow *codexWindow `json:"secondary_window"`
}

// codexWindow mirrors `RateLimitWindowSnapshot`. `used_percent` is an
// integer 0–100, `reset_at` is a unix-seconds timestamp.
type codexWindow struct {
	UsedPercent        int   `json:"used_percent"`
	LimitWindowSeconds int   `json:"limit_window_seconds"`
	ResetAfterSeconds  int   `json:"reset_after_seconds"`
	ResetAt            int64 `json:"reset_at"`
}

type codexCredits struct {
	HasCredits bool    `json:"has_credits"`
	Unlimited  bool    `json:"unlimited"`
	Balance    *string `json:"balance"`
}

type codexReachedTag struct {
	Kind string `json:"type"`
}

// FetchCodexUsage GETs codex's `/wham/usage` and adapts the response to
// the shared `*Usage` shape the TUI already knows how to render:
// `primary_window` → `FiveHour`, `secondary_window` → `SevenDay`. The
// per-model weekly slots (`SevenDaySonnet`/`SevenDayOpus`) stay nil for
// Codex rows — codex's API doesn't split weekly by model the way
// Anthropic's does, so those columns render as `—`.
//
// accountID is the `chatgpt_account_id` JWT claim, passed as
// `ChatGPT-Account-Id` so the backend can disambiguate when a single
// auth covers multiple workspaces. Empty accountID is tolerated for
// freshly-logged-in users whose id_token hasn't been re-parsed yet.
//
// 429 → `*RateLimitError` with Source="usage" so the existing per-row
// backoff machinery in `internal/swap` keeps the row dimmed without
// hammering the endpoint. 401 → distinct "token rejected" error so the
// TUI can suggest a fresh `codex login`.
func FetchCodexUsage(ctx context.Context, accessToken, accountID string) (*Usage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, codexUsageEndpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("User-Agent", codexUA)
	req.Header.Set("Accept", "application/json")
	if accountID != "" {
		req.Header.Set("ChatGPT-Account-Id", accountID)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	switch resp.StatusCode {
	case http.StatusOK:
		// fall through to decode
	case http.StatusTooManyRequests:
		return nil, &RateLimitError{
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), 60*time.Second),
			Body:       string(body),
			Source:     "usage",
		}
	case http.StatusUnauthorized:
		return nil, fmt.Errorf("token rejected by /wham/usage (run `codex login` to re-auth)")
	default:
		preview := string(body)
		if len(preview) > 200 {
			preview = preview[:200] + "…"
		}
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, preview)
	}

	var p codexUsagePayload
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	u := &Usage{}
	if p.RateLimit != nil {
		u.FiveHour = codexWindowToWindow(p.RateLimit.PrimaryWindow)
		u.SevenDay = codexWindowToWindow(p.RateLimit.SecondaryWindow)
	}
	return u, nil
}

// codexWindowToWindow maps codex's integer-percent window to the
// shared `*Window` shape. A nil input yields nil; a zero used_percent
// is preserved (the TUI uses 0% to mean "fresh window", which is
// meaningful — distinct from "no data").
func codexWindowToWindow(c *codexWindow) *Window {
	if c == nil {
		return nil
	}
	w := &Window{Utilization: float64(c.UsedPercent)}
	if c.ResetAt > 0 {
		t := time.Unix(c.ResetAt, 0).UTC()
		w.ResetsAt = &t
	}
	return w
}
