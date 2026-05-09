package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"claude-monitor/internal/config"
)

// PublicStatus mirrors tunnel.Status (lives here so clients don't
// import internal/tunnel). The bridge in cmd/claude-monitor adapts
// between this shape and tunnel.Tunnel.
type PublicStatus struct {
	Enabled      bool   `json:"enabled"`
	URL          string `json:"url,omitempty"`
	Pending      bool   `json:"pending,omitempty"`
	AllowIPs     string `json:"allow_ips,omitempty"`
	CfTunnelName string `json:"cf_tunnel_name,omitempty"`
	CfHostname   string `json:"cf_hostname,omitempty"`
	// Token is the current bearer token shared with proxy.ts. Surfaced
	// here (in addition to LANStatus) so the public-enable handler can
	// persist it without a second round-trip — Public uses the same
	// auth gate as LAN, so the token must survive daemon restarts even
	// when LAN itself was never explicitly enabled.
	Token string `json:"-"` // never wire-serialized; UI reads via /api/lan/status
	Error string `json:"error,omitempty"`
}

// PublicConfig is the input shape for Enable. Splitting it from the
// (ctx, params...) signature keeps Enable from churning every time we
// add a new toggle — and lets the bridge persist the whole bundle
// atomically.
type PublicConfig struct {
	AllowIPs     string
	CfTunnelName string
	CfHostname   string
}

// PublicController is the contract the orchestrator implements to flip
// the cloudflared subprocess on/off. Same shape as LANController, kept
// separate because the two surfaces are orthogonal: a user can enable
// LAN without public, public without LAN, or both.
type PublicController interface {
	Status() PublicStatus
	Enable(ctx context.Context, cfg PublicConfig) (PublicStatus, error)
	Disable(ctx context.Context) (PublicStatus, error)
}

func (s *Server) SetPublicController(c PublicController) {
	s.mu.Lock()
	s.pubCtrl = c
	s.mu.Unlock()
}

func (s *Server) handlePublicStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	ctrl := s.pubCtrl
	s.mu.RUnlock()
	if ctrl == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"error": "public mode requires the web orchestrator (not available in --serve mode)",
		})
		return
	}
	writeJSON(w, http.StatusOK, ctrl.Status())
}

func (s *Server) handlePublicEnable(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	ctrl := s.pubCtrl
	s.mu.RUnlock()
	if ctrl == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"error": "public mode requires the web orchestrator (not available in --serve mode)",
		})
		return
	}
	var body struct {
		AllowIPs     string `json:"allow_ips,omitempty"`
		CfTunnelName string `json:"cf_tunnel_name,omitempty"`
		CfHostname   string `json:"cf_hostname,omitempty"`
	}
	if r.ContentLength > 0 {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	// Normalize: trim whitespace around each entry, drop empties so a
	// trailing comma in the UI doesn't smuggle a "" entry into proxy.ts.
	cfg := PublicConfig{
		AllowIPs:     normalizeIPList(body.AllowIPs),
		CfTunnelName: strings.TrimSpace(body.CfTunnelName),
		CfHostname:   strings.TrimSpace(body.CfHostname),
	}
	// Reject the partial-named-tunnel case server-side so a UI bypass
	// can't silently fall through to a quick tunnel. cloudflared needs
	// both the name (to look up credentials) and the hostname (to set
	// the public URL); having one without the other yields the same
	// random *.trycloudflare.com behaviour as no config at all, which
	// is confusing if the user typed a real hostname expecting it.
	if (cfg.CfTunnelName == "") != (cfg.CfHostname == "") {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "named tunnel needs both name and hostname (leave both empty for a quick tunnel)",
		})
		return
	}

	// 30s timeout: cloudflared cold-start can take ~5-15s for the
	// public URL to propagate, plus a buffer for slow networks.
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	status, err := ctrl.Enable(ctx, cfg)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	s.persistPublicState(true, cfg, status.Token)
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handlePublicDisable(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	ctrl := s.pubCtrl
	s.mu.RUnlock()
	if ctrl == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{
			"error": "public mode requires the web orchestrator (not available in --serve mode)",
		})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	status, err := ctrl.Disable(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Disable keeps AllowIPs / named-tunnel config / LAN token in
	// config.json — re-enabling shouldn't make the user re-enter their
	// allowlist, re-pick the tunnel, or re-paste the token URL. They
	// can clear AllowIPs by re-enabling with an empty string.
	s.persistPublicState(false, PublicConfig{
		AllowIPs:     s.cfg.AllowIPs,
		CfTunnelName: s.cfg.CfTunnelName,
		CfHostname:   s.cfg.CfHostname,
	}, s.cfg.LANToken)
	writeJSON(w, http.StatusOK, status)
}

// persistPublicState writes the public toggle + named-tunnel config
// + bearer token to config.json. Same fire-and-forget style as
// persistLANState — log and continue if the disk write fails, the
// in-memory state is what counts for the running session. Token is
// persisted under cfg.LANToken (the same field LAN uses) because
// Public and LAN share one auth gate; passing "" leaves it unchanged
// so a Disable-with-no-token call doesn't wipe a still-valid LAN
// session's token.
func (s *Server) persistPublicState(enabled bool, cfg PublicConfig, token string) {
	s.mu.Lock()
	s.cfg.PublicEnabled = enabled
	s.cfg.AllowIPs = cfg.AllowIPs
	s.cfg.CfTunnelName = cfg.CfTunnelName
	s.cfg.CfHostname = cfg.CfHostname
	if token != "" {
		s.cfg.LANToken = token
	}
	saved := s.cfg
	s.mu.Unlock()
	if err := config.Save(saved); err != nil {
		s.logger.Warn("persist public state failed", "error", err)
	}
}

// normalizeIPList trims and de-empties a comma-separated IP list. We
// don't validate IP format here — proxy.ts is the source of truth for
// "is this string a valid IP/CIDR" and the daemon merely forwards
// what the user provided. Pushing validation into proxy.ts keeps the
// two layers in sync without a shared parser.
func normalizeIPList(s string) string {
	if s == "" {
		return ""
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		out = append(out, p)
	}
	return strings.Join(out, ",")
}
