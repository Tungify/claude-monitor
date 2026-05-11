// Package server exposes claude-monitor's account/quota state over HTTP
// and Server-Sent Events so a separate UI (Next.js, mobile, etc.) can
// drive it. The daemon owns its own 60s ticker that refreshes from
// /api/oauth/usage — same code path as the TUI — and broadcasts each
// new snapshot to subscribed SSE clients.
//
// Bind to 127.0.0.1 only. There is no auth; anyone able to connect
// can trigger a swap-to (which mutates the keychain) just by POSTing.
// LAN exposure would leak that capability.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/api"
	"claude-monitor/internal/config"
	"claude-monitor/internal/swap"
)

// Indirected so tests can stub fetch/swap without standing up the
// real keychain + httptest plumbing the underlying packages already
// cover. Production binds to swap.FetchAll / swap.To.
var (
	fetchAll = swap.FetchAll
	swapTo   = swap.To
)

// tickInterval matches the TUI's refresh cadence. Faster polling risks
// the same /api/oauth/usage rate limit the TUI is careful to stay under.
const tickInterval = 60 * time.Second

// Server is the daemon: a cached snapshot, an SSE hub, and a ticker
// that periodically calls swap.FetchAll to refresh both.
type Server struct {
	rootSpec  string
	cfg       config.Config
	logger    *slog.Logger
	startedAt time.Time

	mu        sync.RWMutex
	snap      *Snapshot
	snapErr   error
	skipUntil map[string]time.Time
	prevUtil  map[string]float64
	// lanCtrl is the optional bridge into web.Manager so /api/lan/*
	// can recycle the Next.js child. Nil in --serve mode.
	lanCtrl LANController
	// pubCtrl is the optional bridge into the cloudflared subprocess
	// so /api/public/* can flip the tunnel on/off. Independent of
	// lanCtrl — same orchestrator wires both, but they're orthogonal.
	pubCtrl PublicController

	hub *hub
}

// Snapshot is the JSON-serializable shape returned on /api/accounts and
// pushed on /api/events as `event: snapshot`. Fields are explicit (not
// embedded from internal types) so the wire format is decoupled from
// the swap/account internals — safe to evolve those without breaking
// clients.
//
// ActiveDir tracks the Anthropic active config dir; CodexActiveDir
// tracks the OpenAI one. Both are present so a client can render the
// active marker per provider independently.
type Snapshot struct {
	Accounts       []AccountState `json:"accounts"`
	ActiveDir      string         `json:"active_dir"`
	CodexActiveDir string         `json:"codex_active_dir,omitempty"`
	FetchedAt      time.Time      `json:"fetched_at"`
}

// AccountState is one account's public-safe view. Tokens are
// intentionally omitted — the daemon never serves OAuth credentials
// over HTTP. Clients that need to drive `claude` themselves use
// CLAUDE_CONFIG_DIR + the OS keychain, same path Claude Code uses.
//
// Provider distinguishes Anthropic rows (the original shape: FiveHour
// / Weekly bars from /api/oauth/usage) from OpenAI rows (PlanType +
// TokenExpiresAt from the id_token JWT, no usage bars — Codex has no
// free quota endpoint).
type AccountState struct {
	Name         string      `json:"name"`
	ConfigDir    string      `json:"config_dir"`
	Email        string      `json:"email,omitempty"`
	AccountUUID  string      `json:"account_uuid,omitempty"`
	Provider     string      `json:"provider,omitempty"`
	Active       bool        `json:"active"`
	FiveHour     *api.Window `json:"five_hour,omitempty"`
	Weekly       *api.Window `json:"weekly,omitempty"`
	WeeklySonnet *api.Window `json:"weekly_sonnet,omitempty"`
	WeeklyOpus   *api.Window `json:"weekly_opus,omitempty"`
	Kicked       bool        `json:"kicked,omitempty"`
	KickError    string      `json:"kick_error,omitempty"`
	Error        string      `json:"error,omitempty"`

	// OpenAI-only fields. PlanType is the chatgpt_plan_type claim
	// (free/plus/pro/business/enterprise/edu); TokenExpiresAt is the
	// id_token JWT exp claim (RFC3339). Empty / zero for Anthropic
	// rows so clients can use field presence as a provider check too.
	PlanType       string    `json:"plan_type,omitempty"`
	TokenExpiresAt time.Time `json:"token_expires_at,omitempty"`
}

// SwapEvent mirrors the swap.Event shape but in JSON-friendly form
// (FromUtil/ToUtil flat numbers, no internal types leaked).
type SwapEvent struct {
	FromName string  `json:"from_name"`
	ToName   string  `json:"to_name"`
	FromUtil float64 `json:"from_util"`
	ToUtil   float64 `json:"to_util"`
	Reason   string  `json:"reason"`
}

// New returns a Server ready to serve. Pass the same rootSpec the TUI
// would (empty string for auto-discovery, or a comma-separated path
// list). cfg is loaded once at startup; auto-swap / auto-kick toggles
// here mirror the TUI's persisted settings.
func New(rootSpec string, cfg config.Config, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{
		rootSpec:  rootSpec,
		cfg:       cfg,
		logger:    logger,
		startedAt: time.Now(),
		skipUntil: map[string]time.Time{},
		prevUtil:  map[string]float64{},
		hub:       newHub(),
	}
}

// Routes returns the daemon's http.ServeMux. Exposed so tests can
// hit handlers via httptest without binding a real listener.
func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/accounts", s.handleAccounts)
	mux.HandleFunc("POST /api/swap-to", s.handleSwapTo)
	// Auto-swap settings (threshold cascade, pick order, etc.). The TUI
	// has its own editor; the web UI POSTs partial updates here so users
	// don't need to drop into the terminal to tune the swap behavior.
	mux.HandleFunc("GET /api/swap-config", s.handleSwapConfigGet)
	mux.HandleFunc("POST /api/swap-config", s.handleSwapConfigUpdate)
	mux.HandleFunc("POST /api/account/login", s.handleAccountLogin)
	mux.HandleFunc("POST /api/account/add", s.handleAccountAdd)
	// GET /api/account/mcp-servers — proxies claude.ai's MCP integration
	// list using the account's keychain-stored OAuth token. The token
	// stays inside the daemon; only the parsed server names/URLs cross
	// to the orchestrator UI.
	mux.HandleFunc("GET /api/account/mcp-servers", s.handleAccountMcpServers)
	mux.HandleFunc("GET /api/events", s.handleEvents)
	mux.HandleFunc("POST /api/worktrees", s.handleCreateWorktrees)
	mux.HandleFunc("POST /api/phases/assign", s.handleAssignPhases)
	// LAN exposure toggle. Available only when the orchestrator wired
	// a controller via SetLANController; otherwise these endpoints
	// reply 501 (see handleLAN*).
	mux.HandleFunc("GET /api/lan/status", s.handleLANStatus)
	mux.HandleFunc("POST /api/lan/enable", s.handleLANEnable)
	mux.HandleFunc("POST /api/lan/disable", s.handleLANDisable)
	mux.HandleFunc("GET /api/lan/qr.svg", s.handleLANQR)
	// Public exposure via Cloudflare Tunnel. Subprocess managed by
	// internal/tunnel; daemon just queues toggle requests.
	mux.HandleFunc("GET /api/public/status", s.handlePublicStatus)
	mux.HandleFunc("POST /api/public/enable", s.handlePublicEnable)
	mux.HandleFunc("POST /api/public/disable", s.handlePublicDisable)
	mux.HandleFunc("OPTIONS /api/{rest...}", s.handleCORSPreflight)
	return mux
}

// Start primes the snapshot, starts the ticker and HTTP listener, and
// blocks until ctx is cancelled. On cancel it stops accepting new
// connections, closes SSE subscribers, then returns from Shutdown.
func (s *Server) Start(ctx context.Context, addr string) error {
	s.refreshOnce(ctx)
	go s.tickerLoop(ctx)

	srv := &http.Server{
		Addr:              addr,
		Handler:           withCORS(s.Routes()),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		s.logger.Info("daemon listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.hub.closeAll()
		err := srv.Shutdown(shutdownCtx)
		<-errCh
		return err
	case err := <-errCh:
		return err
	}
}

func (s *Server) tickerLoop(ctx context.Context) {
	t := time.NewTicker(tickInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.refreshOnce(ctx)
		}
	}
}

// refreshOnce calls swap.FetchAll, replaces the cached snapshot, and
// broadcasts to SSE subscribers. The 30s timeout is intentionally
// shorter than the 60s tick so a hung fetch can't pile up two ticks
// worth of in-flight requests.
func (s *Server) refreshOnce(ctx context.Context) {
	fetchCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	res, err := fetchAll(fetchCtx, s.rootSpec, s.cfg, s.skipUntil, s.prevUtil, "", 0)
	if err != nil {
		s.mu.Lock()
		s.snapErr = err
		s.mu.Unlock()
		s.logger.Warn("snapshot fetch failed", "error", err)
		return
	}
	snap := snapshotFromResult(res)
	s.mu.Lock()
	s.snap = &snap
	s.snapErr = nil
	for _, r := range res.Rows {
		if r.Usage != nil && r.Usage.FiveHour != nil {
			s.prevUtil[r.ConfigDir] = r.Usage.FiveHour.Utilization
		}
	}
	s.mu.Unlock()

	s.hub.broadcast(envelope{Type: "snapshot", Data: &snap})
	if res.Swap != nil {
		s.hub.broadcast(envelope{Type: "swap", Data: SwapEvent{
			FromName: res.Swap.FromName,
			ToName:   res.Swap.ToName,
			FromUtil: res.Swap.FromUtil,
			ToUtil:   res.Swap.ToUtil,
			Reason:   res.Swap.Reason,
		}})
	}
	if res.SwapErr != nil {
		s.hub.broadcast(envelope{Type: "error", Data: map[string]string{"message": res.SwapErr.Error()}})
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":         "ok",
		"uptime_seconds": int(time.Since(s.startedAt).Seconds()),
	})
}

func (s *Server) handleAccounts(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	snap := s.snap
	snapErr := s.snapErr
	s.mu.RUnlock()
	if snap == nil {
		msg := "no snapshot yet"
		if snapErr != nil {
			msg = snapErr.Error()
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": msg})
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *Server) handleSwapTo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Ident string `json:"ident"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
		return
	}
	if body.Ident == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ident is required"})
		return
	}
	if err := swapTo(s.rootSpec, body.Ident); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	// Kick a refresh so the new active marker shows up before the next
	// scheduled tick — the UI POSTed expecting an immediate flip.
	s.refreshOnce(r.Context())
	s.mu.RLock()
	active := ""
	if s.snap != nil {
		active = s.snap.ActiveDir
	}
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "active_dir": active})
}

func (s *Server) handleCORSPreflight(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

// snapshotFromResult flattens swap.FetchResult into the wire shape.
// Errors on individual rows surface as the row's Error string; rows
// that errored have nil Usage and so omit the window fields entirely.
// OpenAI rows populate PlanType + TokenExpiresAt instead of Usage
// bars, and their Active flag is computed against CodexActiveDir
// rather than ActiveDir.
func snapshotFromResult(res *swap.FetchResult) Snapshot {
	accs := make([]AccountState, 0, len(res.Rows))
	for _, r := range res.Rows {
		active := r.ConfigDir == res.ActiveDir
		if r.Provider == account.ProviderOpenAI {
			active = r.ConfigDir == res.CodexActiveDir
		}
		a := AccountState{
			Name:        r.Name,
			ConfigDir:   r.ConfigDir,
			Email:       r.Email,
			AccountUUID: r.AccountUUID,
			Provider:    string(r.Provider),
			Active:      active,
			Kicked:      r.Kicked,
		}
		if r.Err != nil {
			a.Error = r.Err.Error()
		}
		if r.KickErr != nil {
			a.KickError = r.KickErr.Error()
		}
		if r.Usage != nil {
			a.FiveHour = r.Usage.FiveHour
			a.Weekly = r.Usage.SevenDay
			a.WeeklySonnet = r.Usage.SevenDaySonnet
			a.WeeklyOpus = r.Usage.SevenDayOpus
		}
		if r.Provider == account.ProviderOpenAI {
			a.PlanType = r.PlanType
			a.TokenExpiresAt = r.TokenExpiresAt
		}
		accs = append(accs, a)
	}
	return Snapshot{
		Accounts:       accs,
		ActiveDir:      res.ActiveDir,
		CodexActiveDir: res.CodexActiveDir,
		FetchedAt:      time.Now().UTC(),
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// withCORS allows any origin since the daemon binds to 127.0.0.1 only —
// the threat model is "another local process / browser tab", and a
// permissive header doesn't change what they can already reach. Tighten
// to specific origins if/when the daemon ever binds beyond loopback.
func withCORS(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		h.ServeHTTP(w, r)
	})
}

