package server

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// envelope is the SSE event shape: a discriminator type plus an
// arbitrary payload. Type matches the SSE `event:` line so clients
// can dispatch with addEventListener("snapshot", ...) etc.
type envelope struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

// hub is a fan-out for SSE subscribers. Each subscribe() returns a
// buffered channel; broadcast does a non-blocking send to every
// subscriber so a slow consumer drops events instead of stalling
// the daemon's ticker loop. v1 picks "drop on full" over "block":
// stale-by-one-tick is acceptable, but a stuck broadcast freezing
// fresh snapshots for everyone is not.
type hub struct {
	mu   sync.Mutex
	subs map[chan envelope]struct{}
}

func newHub() *hub {
	return &hub{subs: map[chan envelope]struct{}{}}
}

func (h *hub) subscribe() chan envelope {
	ch := make(chan envelope, 16)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *hub) unsubscribe(ch chan envelope) {
	h.mu.Lock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
	h.mu.Unlock()
}

func (h *hub) broadcast(ev envelope) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

func (h *hub) closeAll() {
	h.mu.Lock()
	for ch := range h.subs {
		close(ch)
		delete(h.subs, ch)
	}
	h.mu.Unlock()
}

// handleEvents serves a long-lived SSE stream. Sends the current
// snapshot immediately on connect (so a freshly opened UI doesn't
// wait up to 60s for the first tick), then forwards every broadcast
// until the client disconnects or the server shuts down.
//
// A 25s heartbeat comment line keeps proxies and idle-connection
// timeouts from severing the stream during long quiet periods.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch := s.hub.subscribe()
	defer s.hub.unsubscribe(ch)

	s.mu.RLock()
	if s.snap != nil {
		sendSSE(w, flusher, envelope{Type: "snapshot", Data: s.snap})
	}
	s.mu.RUnlock()

	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			sendSSE(w, flusher, ev)
		case <-heartbeat.C:
			_, _ = w.Write([]byte(": ping\n\n"))
			flusher.Flush()
		}
	}
}

func sendSSE(w http.ResponseWriter, flusher http.Flusher, ev envelope) {
	payload, err := json.Marshal(ev.Data)
	if err != nil {
		return
	}
	_, _ = w.Write([]byte("event: " + ev.Type + "\n"))
	_, _ = w.Write([]byte("data: "))
	_, _ = w.Write(payload)
	_, _ = w.Write([]byte("\n\n"))
	flusher.Flush()
}
