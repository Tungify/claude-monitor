package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

// APIUsage is the parsed response from /api/oauth/usage.
// We model only the fields the official `/usage` slash command surfaces;
// other fields (tangelo, iguana_necktie, omelette_promotional, ...) are
// internal A/B-test buckets and intentionally ignored.
type APIUsage struct {
	FiveHour       *Window     `json:"five_hour"`
	SevenDay       *Window     `json:"seven_day"`
	SevenDaySonnet *Window     `json:"seven_day_sonnet"`
	SevenDayOpus   *Window     `json:"seven_day_opus"`
	ExtraUsage     *ExtraUsage `json:"extra_usage"`
}

func FetchUsage(ctx context.Context, token string) (*APIUsage, error) {
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
	if resp.StatusCode != http.StatusOK {
		// Trim the response so a stray HTML page from a misroute doesn't
		// flood stderr in the table.
		preview := string(body)
		if len(preview) > 200 {
			preview = preview[:200] + "…"
		}
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, preview)
	}

	var u APIUsage
	if err := json.Unmarshal(body, &u); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return &u, nil
}
