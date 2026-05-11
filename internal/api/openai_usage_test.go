package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// withCodexUsageEndpoint redirects the package-level endpoint to an
// httptest server for the duration of the test. Mirrors the pattern
// usage_test.go uses for /api/oauth/usage.
func withCodexUsageEndpoint(t *testing.T, srv *httptest.Server) {
	t.Helper()
	orig := codexUsageEndpoint
	codexUsageEndpoint = srv.URL
	t.Cleanup(func() { codexUsageEndpoint = orig })
}

func TestFetchCodexUsage_HappyPath(t *testing.T) {
	resetAt := time.Now().Add(3 * time.Hour).Unix()
	weeklyResetAt := time.Now().Add(5 * 24 * time.Hour).Unix()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization header = %q, want Bearer test-token", got)
		}
		if got := r.Header.Get("ChatGPT-Account-Id"); got != "acct_123" {
			t.Errorf("ChatGPT-Account-Id = %q, want acct_123", got)
		}
		if got := r.Header.Get("User-Agent"); got == "" {
			t.Errorf("missing User-Agent")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"plan_type": "pro",
			"rate_limit": {
				"allowed": true,
				"limit_reached": false,
				"primary_window": {
					"used_percent": 42,
					"limit_window_seconds": 18000,
					"reset_after_seconds": 10800,
					"reset_at": ` + intToStr(resetAt) + `
				},
				"secondary_window": {
					"used_percent": 7,
					"limit_window_seconds": 604800,
					"reset_after_seconds": 432000,
					"reset_at": ` + intToStr(weeklyResetAt) + `
				}
			},
			"credits": {"has_credits": true, "unlimited": false, "balance": "5.00"}
		}`))
	}))
	defer srv.Close()
	withCodexUsageEndpoint(t, srv)

	u, err := FetchCodexUsage(context.Background(), "test-token", "acct_123")
	if err != nil {
		t.Fatalf("FetchCodexUsage: %v", err)
	}
	if u.FiveHour == nil {
		t.Fatalf("FiveHour nil; want populated")
	}
	if u.FiveHour.Utilization != 42 {
		t.Errorf("FiveHour.Utilization = %v, want 42", u.FiveHour.Utilization)
	}
	if u.FiveHour.ResetsAt == nil || u.FiveHour.ResetsAt.Unix() != resetAt {
		t.Errorf("FiveHour.ResetsAt = %v, want unix %d", u.FiveHour.ResetsAt, resetAt)
	}
	if u.SevenDay == nil || u.SevenDay.Utilization != 7 {
		t.Errorf("SevenDay = %+v, want utilization 7", u.SevenDay)
	}
	if u.SevenDaySonnet != nil || u.SevenDayOpus != nil {
		t.Errorf("per-model weekly windows should stay nil for codex rows")
	}
}

func TestFetchCodexUsage_RateLimit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "45")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	withCodexUsageEndpoint(t, srv)

	_, err := FetchCodexUsage(context.Background(), "tok", "acct")
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("err = %v, want *RateLimitError", err)
	}
	if rl.Source != "usage" {
		t.Errorf("Source = %q, want usage", rl.Source)
	}
	if rl.RetryAfter != 45*time.Second {
		t.Errorf("RetryAfter = %v, want 45s", rl.RetryAfter)
	}
}

func TestFetchCodexUsage_Unauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid_token"}`))
	}))
	defer srv.Close()
	withCodexUsageEndpoint(t, srv)

	_, err := FetchCodexUsage(context.Background(), "tok", "")
	if err == nil {
		t.Fatalf("want error on 401")
	}
	if !contains(err.Error(), "codex login") {
		t.Errorf("err = %q, want hint about `codex login`", err)
	}
}

func TestFetchCodexUsage_NilRateLimit(t *testing.T) {
	// codex sometimes returns plan info without a rate_limit object
	// (workspace plans whose quota is workspace-pooled rather than
	// per-user). Decode shouldn't fail; FiveHour/SevenDay just stay nil
	// and the TUI falls back to plan + expiry.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"plan_type":"enterprise"}`))
	}))
	defer srv.Close()
	withCodexUsageEndpoint(t, srv)

	u, err := FetchCodexUsage(context.Background(), "tok", "")
	if err != nil {
		t.Fatalf("decode without rate_limit: %v", err)
	}
	if u.FiveHour != nil || u.SevenDay != nil {
		t.Errorf("expected nil windows, got %+v / %+v", u.FiveHour, u.SevenDay)
	}
}

func intToStr(n int64) string { return strconv.FormatInt(n, 10) }

func contains(haystack, needle string) bool { return strings.Contains(haystack, needle) }
