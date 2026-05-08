package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/api"
	"claude-monitor/internal/config"
	"claude-monitor/internal/swap"
)

func newTestServer(t *testing.T) *Server {
	t.Helper()
	return New("", config.Config{}, nil)
}

func TestHandleHealth(t *testing.T) {
	s := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	s.handleHealth(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want %d", rec.Code, http.StatusOK)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("status: got %v want ok", body["status"])
	}
	if _, ok := body["uptime_seconds"]; !ok {
		t.Errorf("missing uptime_seconds in %v", body)
	}
}

func TestHandleAccounts_NoSnapshot(t *testing.T) {
	s := newTestServer(t)
	rec := httptest.NewRecorder()
	s.handleAccounts(rec, httptest.NewRequest(http.MethodGet, "/api/accounts", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status: got %d want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

func TestHandleAccounts_WithSnapshot(t *testing.T) {
	s := newTestServer(t)
	s.snap = &Snapshot{
		Accounts: []AccountState{
			{Name: "acc-1", ConfigDir: "/tmp/.claude-acc-1", Active: true,
				FiveHour: &api.Window{Utilization: 42}},
		},
		ActiveDir: "/tmp/.claude-acc-1",
		FetchedAt: time.Now().UTC(),
	}
	rec := httptest.NewRecorder()
	s.handleAccounts(rec, httptest.NewRequest(http.MethodGet, "/api/accounts", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want %d", rec.Code, http.StatusOK)
	}
	var body Snapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(body.Accounts) != 1 || body.Accounts[0].Name != "acc-1" {
		t.Errorf("unexpected accounts: %+v", body.Accounts)
	}
	// Tokens must never appear in the response — guard against
	// regressions where a refactor accidentally serializes account.Row.
	if strings.Contains(rec.Body.String(), "access_token") || strings.Contains(rec.Body.String(), "refresh_token") {
		t.Error("snapshot response leaked token field names")
	}
}

func TestHandleSwapTo_EmptyIdent(t *testing.T) {
	s := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/swap-to", bytes.NewReader([]byte(`{}`)))
	s.handleSwapTo(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleSwapTo_InvalidJSON(t *testing.T) {
	s := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/swap-to", bytes.NewReader([]byte(`not json`)))
	s.handleSwapTo(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleSwapTo_Success(t *testing.T) {
	s := newTestServer(t)
	// Pre-seed a snapshot so post-swap refresh has something to read
	// without hitting the keychain.
	s.snap = &Snapshot{ActiveDir: "/tmp/.claude-acc-2", FetchedAt: time.Now()}

	origSwapTo, origFetchAll := swapTo, fetchAll
	t.Cleanup(func() { swapTo, fetchAll = origSwapTo, origFetchAll })

	var calledIdent string
	swapTo = func(rootSpec, ident string) error {
		calledIdent = ident
		return nil
	}
	fetchAll = func(ctx context.Context, rootSpec string, cfg config.Config, skip map[string]time.Time, prev map[string]float64, pickDir string, pickUtil float64) (*swap.FetchResult, error) {
		return &swap.FetchResult{
			Rows:      []account.Row{{Name: "acc-2", ConfigDir: "/tmp/.claude-acc-2"}},
			ActiveDir: "/tmp/.claude-acc-2",
		}, nil
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/swap-to", bytes.NewReader([]byte(`{"ident":"acc-2"}`)))
	s.handleSwapTo(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want %d body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if calledIdent != "acc-2" {
		t.Errorf("swapTo ident: got %q want acc-2", calledIdent)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["ok"] != true {
		t.Errorf("body.ok: got %v want true", body["ok"])
	}
	if body["active_dir"] != "/tmp/.claude-acc-2" {
		t.Errorf("body.active_dir: got %v", body["active_dir"])
	}
}

func TestHandleSwapTo_BackendError(t *testing.T) {
	s := newTestServer(t)
	origSwapTo := swapTo
	t.Cleanup(func() { swapTo = origSwapTo })
	swapTo = func(_, _ string) error { return errIdentNotFound }

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/swap-to", bytes.NewReader([]byte(`{"ident":"missing"}`)))
	s.handleSwapTo(rec, req)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status: got %d want 422", rec.Code)
	}
}

// errIdentNotFound is a stand-in for the wrapped error swap.To returns
// when the requested ident matches no row.
var errIdentNotFound = simpleErr("account not found")

type simpleErr string

func (e simpleErr) Error() string { return string(e) }

func TestSnapshotFromResult_ErrorRowOmitsUsage(t *testing.T) {
	res := &swap.FetchResult{
		Rows: []account.Row{
			{Name: "ok", ConfigDir: "/a", Usage: &api.Usage{
				FiveHour: &api.Window{Utilization: 10},
			}},
			{Name: "rate-limited", ConfigDir: "/b", Err: simpleErr("rate limited")},
		},
		ActiveDir: "/a",
	}
	snap := snapshotFromResult(res)
	if len(snap.Accounts) != 2 {
		t.Fatalf("accounts: %d want 2", len(snap.Accounts))
	}
	if snap.Accounts[0].FiveHour == nil || snap.Accounts[0].FiveHour.Utilization != 10 {
		t.Errorf("ok row: bad five_hour: %+v", snap.Accounts[0].FiveHour)
	}
	if snap.Accounts[1].Error == "" {
		t.Error("error row: missing Error")
	}
	if snap.Accounts[1].FiveHour != nil {
		t.Errorf("error row: should have nil FiveHour, got %+v", snap.Accounts[1].FiveHour)
	}
}

func TestHub_BroadcastAndSubscribe(t *testing.T) {
	h := newHub()
	a := h.subscribe()
	b := h.subscribe()

	h.broadcast(envelope{Type: "test", Data: "hello"})

	for _, ch := range []chan envelope{a, b} {
		select {
		case ev := <-ch:
			if ev.Type != "test" || ev.Data != "hello" {
				t.Errorf("unexpected event: %+v", ev)
			}
		case <-time.After(100 * time.Millisecond):
			t.Error("subscriber didn't receive event")
		}
	}
}

func TestHub_SlowSubscriberDoesNotBlock(t *testing.T) {
	h := newHub()
	slow := h.subscribe()
	// Don't drain `slow`. Fill its buffer (16) plus one extra so
	// broadcast must drop. Test passes if it returns promptly.
	done := make(chan struct{})
	go func() {
		for range 32 {
			h.broadcast(envelope{Type: "spam"})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("broadcast stalled on slow subscriber")
	}
	// Drain so the goroutine cleanup is clean.
	go func() {
		for range slow {
		}
	}()
	h.unsubscribe(slow)
}

func TestHub_UnsubscribeIsIdempotent(t *testing.T) {
	h := newHub()
	ch := h.subscribe()
	h.unsubscribe(ch)
	h.unsubscribe(ch) // must not panic / double-close
}

func TestSSE_StreamSendsCurrentSnapshot(t *testing.T) {
	s := newTestServer(t)
	s.snap = &Snapshot{ActiveDir: "/x", FetchedAt: time.Now()}

	srv := httptest.NewServer(s.Routes())
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get events: %v", err)
	}
	t.Cleanup(func() { resp.Body.Close() })

	if got := resp.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Errorf("Content-Type: got %q want text/event-stream", got)
	}

	buf := make([]byte, 1024)
	var collected strings.Builder
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		n, _ := resp.Body.Read(buf)
		if n > 0 {
			collected.Write(buf[:n])
			if strings.Contains(collected.String(), "event: snapshot") {
				return
			}
		}
	}
	t.Fatalf("never saw snapshot event in: %q", collected.String())
}

// guard ensures we never accidentally drop CORS once a UI is wired up
func TestRoutes_CORSHeadersOnGet(t *testing.T) {
	s := newTestServer(t)
	srv := httptest.NewServer(withCORS(s.Routes()))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/api/health")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("CORS: got %q want *", got)
	}
}

// Sanity: the daemon should not block startup on an initial fetch
// failing (e.g. no accounts on disk yet).
func TestStart_InitialFetchFailureDoesNotPanic(t *testing.T) {
	s := newTestServer(t)
	origFetchAll := fetchAll
	t.Cleanup(func() { fetchAll = origFetchAll })
	fetchAll = func(_ context.Context, _ string, _ config.Config, _ map[string]time.Time, _ map[string]float64, _ string, _ float64) (*swap.FetchResult, error) {
		return nil, simpleErr("no accounts")
	}

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_ = s.Start(ctx, "127.0.0.1:0")
	}()
	// Let the goroutine reach ListenAndServe before cancelling so the
	// shutdown path actually exercises Server.Shutdown.
	time.Sleep(50 * time.Millisecond)
	cancel()
	wg.Wait()
}
