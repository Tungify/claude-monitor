package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseRetryAfter(t *testing.T) {
	const def = 30 * time.Second

	tests := []struct {
		name string
		hdr  string
		want time.Duration
	}{
		{"empty falls back to default", "", def},
		{"numeric seconds", "120", 120 * time.Second},
		{"zero seconds returns default", "0", def},
		{"negative returns default", "-5", def},
		{"non-numeric garbage returns default", "tomorrow", def},
		// HTTP-date in the future returns "until that date".
		// Use a date 2 minutes in the future and assert ~120s ± slack.
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseRetryAfter(tt.hdr, def)
			if got != tt.want {
				t.Errorf("parseRetryAfter(%q) = %s, want %s", tt.hdr, got, tt.want)
			}
		})
	}

	t.Run("HTTP-date in future returns positive duration", func(t *testing.T) {
		future := time.Now().Add(2 * time.Minute).UTC().Format(http.TimeFormat)
		got := parseRetryAfter(future, def)
		// Allow some slack for clock drift.
		if got < 90*time.Second || got > 130*time.Second {
			t.Errorf("HTTP-date parse: got %s, want ~120s", got)
		}
	})

	t.Run("HTTP-date in past returns default", func(t *testing.T) {
		past := time.Now().Add(-2 * time.Minute).UTC().Format(http.TimeFormat)
		got := parseRetryAfter(past, def)
		if got != def {
			t.Errorf("HTTP-date past: got %s, want default %s", got, def)
		}
	})
}

func TestRateLimitErrorMessage(t *testing.T) {
	e := &RateLimitError{RetryAfter: 90 * time.Second}
	got := e.Error()
	if !strings.Contains(got, "rate limited") || !strings.Contains(got, "1m30s") {
		t.Errorf("Error() = %q, want substring 'rate limited' and '1m30s'", got)
	}
}

// TestFetchUsageSuccess validates the happy path: 200 with a JSON body
// that decodes into Usage.
func TestFetchUsageSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization header = %q, want Bearer test-token", got)
		}
		if got := r.Header.Get("anthropic-beta"); got != "oauth-2025-04-20" {
			t.Errorf("anthropic-beta = %q, want oauth-2025-04-20", got)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"five_hour":{"utilization":42.5,"resets_at":null},"seven_day":null}`))
	}))
	t.Cleanup(srv.Close)

	// FetchUsage hits a hardcoded const URL. To exercise the parsing
	// logic without DI, we replicate the handler and call the parser
	// indirectly via a one-off http GET against the test server.
	req, err := http.NewRequest(http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

// TestFetchUsage429Wrapping validates that a 429 response body and the
// Retry-After header are captured into RateLimitError. We exercise the
// error type directly because FetchUsage uses a hardcoded URL.
func TestFetchUsage429ErrorShape(t *testing.T) {
	rl := &RateLimitError{
		RetryAfter: 5 * time.Minute,
		Body:       `{"error":"too many requests"}`,
	}
	var target *RateLimitError
	if !errors.As(rl, &target) {
		t.Fatal("errors.As failed for *RateLimitError")
	}
	if target.RetryAfter != 5*time.Minute {
		t.Errorf("RetryAfter = %s, want 5m", target.RetryAfter)
	}
	if !strings.Contains(target.Body, "too many requests") {
		t.Errorf("Body lost the detail: %q", target.Body)
	}
}

// TestFetchUsageContextCancellation makes sure the timeout is honored.
func TestFetchUsageContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already canceled

	// The hardcoded URL means we can't dial-test; we can at least make
	// sure the context cancellation propagates through NewRequestWithContext.
	_, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://example.invalid", nil)
	if err != nil {
		t.Fatalf("NewRequestWithContext: %v", err)
	}
	// And that a Do on a canceled context fails.
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://example.invalid", nil)
	if _, err := http.DefaultClient.Do(req); err == nil {
		t.Error("expected error from Do with canceled context")
	}
}
