package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// makeJWTWithExp mirrors codex auth_test.go's helper but stays local to
// the api package so the test doesn't depend on the codex package's
// internals.
func makeJWTWithExp(t *testing.T, exp int64) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	body, _ := json.Marshal(map[string]any{"exp": exp})
	payload := base64.RawURLEncoding.EncodeToString(body)
	return header + "." + payload + ".sig"
}

func TestRefreshOpenAI_Success(t *testing.T) {
	exp := time.Now().Add(time.Hour).Unix()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Content-Type = %q", r.Header.Get("Content-Type"))
		}
		var body openaiRefreshReq
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body.ClientID != openaiClientID {
			t.Errorf("client_id = %q, want %q", body.ClientID, openaiClientID)
		}
		if body.GrantType != "refresh_token" {
			t.Errorf("grant_type = %q", body.GrantType)
		}
		if body.RefreshToken != "old-refresh" {
			t.Errorf("refresh_token = %q", body.RefreshToken)
		}
		_ = json.NewEncoder(w).Encode(openaiRefreshResp{
			IDToken:      makeJWTWithExp(t, exp),
			AccessToken:  "new-access",
			RefreshToken: "new-refresh",
		})
	}))
	defer srv.Close()
	oldEndpoint := openaiTokenEndpoint
	openaiTokenEndpoint = srv.URL
	defer func() { openaiTokenEndpoint = oldEndpoint }()
	// Shrink the inter-call throttle so the test doesn't sleep.
	oldInterval := refreshMinInterval
	refreshMinInterval = 0
	defer func() { refreshMinInterval = oldInterval }()
	// Clear breaker state from any earlier test.
	rateLimitedUntil = time.Time{}
	consecutive429 = 0
	lastRefreshNetwork = time.Time{}

	got, err := RefreshOpenAI(context.Background(), "old-refresh")
	if err != nil {
		t.Fatalf("RefreshOpenAI: %v", err)
	}
	if got.AccessToken != "new-access" {
		t.Errorf("AccessToken = %q, want new-access", got.AccessToken)
	}
	if got.RefreshToken != "new-refresh" {
		t.Errorf("RefreshToken = %q, want new-refresh", got.RefreshToken)
	}
	if got.ExpiresAt.Unix() != exp {
		t.Errorf("ExpiresAt = %v, want unix=%d", got.ExpiresAt, exp)
	}
}

func TestRefreshOpenAI_429(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "12")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate_limited"}`))
	}))
	defer srv.Close()
	oldEndpoint := openaiTokenEndpoint
	openaiTokenEndpoint = srv.URL
	defer func() { openaiTokenEndpoint = oldEndpoint }()
	oldInterval := refreshMinInterval
	refreshMinInterval = 0
	defer func() { refreshMinInterval = oldInterval }()
	rateLimitedUntil = time.Time{}
	consecutive429 = 0
	lastRefreshNetwork = time.Time{}

	_, err := RefreshOpenAI(context.Background(), "old-refresh")
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("err = %v, want *RateLimitError", err)
	}
	if rl.Source != "refresh" {
		t.Errorf("Source = %q, want refresh", rl.Source)
	}
	// The 12s Retry-After is jittered ±20% before being returned,
	// so just bound-check rather than assert exact equality.
	if rl.RetryAfter < 9*time.Second || rl.RetryAfter > 16*time.Second {
		t.Errorf("RetryAfter = %s, want ≈12s", rl.RetryAfter)
	}
}

func TestRefreshOpenAI_MissingTokens(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"only-access"}`))
	}))
	defer srv.Close()
	oldEndpoint := openaiTokenEndpoint
	openaiTokenEndpoint = srv.URL
	defer func() { openaiTokenEndpoint = oldEndpoint }()
	oldInterval := refreshMinInterval
	refreshMinInterval = 0
	defer func() { refreshMinInterval = oldInterval }()
	rateLimitedUntil = time.Time{}
	consecutive429 = 0
	lastRefreshNetwork = time.Time{}

	_, err := RefreshOpenAI(context.Background(), "old-refresh")
	if err == nil {
		t.Fatalf("expected error for missing refresh_token, got nil")
	}
}
