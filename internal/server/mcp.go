package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"claude-monitor/internal/keychain"
)

// claudeAiMcpEndpoint is the production claude.ai API endpoint that
// lists the user's enabled MCP integrations (Asana, Atlassian, etc.).
// Shape mirrors what the Claude Code CLI hits — same path, same beta
// header, same limit. Override via env for staging/local testing.
//
// We don't surface a config knob: the orchestrator already hard-codes
// console.anthropic.com for OAuth refresh and api.anthropic.com is its
// sibling. Anyone needing to retarget can patch this binary.
var claudeAiMcpEndpoint = "https://api.anthropic.com/v1/mcp_servers?limit=1000"

const (
	mcpServersBetaHeader = "mcp-servers-2025-12-04"
	mcpFetchTimeout      = 5 * time.Second
	mcpScope             = "user:mcp_servers"
)

// handleAccountMcpServers proxies the claude.ai-managed MCP integration
// list to clients that can't read the OAuth token themselves (the web
// orchestrator running under Node). The token never leaves the daemon
// — we read it from the keychain, hit the upstream API, and return only
// the resulting server list.
//
// Surface mirrors the leaked CLI's services/mcp/claudeai.ts so the
// caller can render the same scope label ("claude.ai integrations")
// with the same per-row defaults. Missing scope / 401 / 403 collapse
// to {servers: [], needs_auth: true} so the chat panel can prompt
// re-login without seeing a stack trace.
//
// Query params:
//
//	config_dir — absolute path to the account's CLAUDE_CONFIG_DIR. We
//	             resolve creds against this exact dir; the caller
//	             already knows it from the session metadata.
func (s *Server) handleAccountMcpServers(w http.ResponseWriter, r *http.Request) {
	configDir := r.URL.Query().Get("config_dir")
	if configDir == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "config_dir query parameter is required",
		})
		return
	}

	creds, err := keychain.LoadCredentials(configDir)
	if err != nil {
		// No keychain entry + no fallback file → not authenticated.
		// We deliberately return 200 with needs_auth=true rather than
		// 404 so the caller's "/mcp panel" branch can render the
		// re-login banner without a separate error path.
		writeJSON(w, http.StatusOK, mcpServersResponse{
			Servers:   []claudeAiServer{},
			NeedsAuth: true,
		})
		return
	}

	if !slices.Contains(creds.Scopes, mcpScope) {
		// Signed in but the token wasn't issued with user:mcp_servers
		// — the user pre-dates the connectors feature or skipped that
		// scope at login. Re-login fixes it; we surface the signal so
		// the panel can say so.
		writeJSON(w, http.StatusOK, mcpServersResponse{
			Servers:   []claudeAiServer{},
			NeedsAuth: true,
		})
		return
	}

	if creds.Expired() {
		// Token expired before the next refresh ticked. Rather than
		// firing a synchronous refresh from this handler (which would
		// contend with the dashboard's own refresh loop and could trip
		// the IP-level OAuth rate limit), we report needs_auth and let
		// the dashboard's existing periodic refresh restore it on the
		// next tick. Re-trying /mcp after that yields fresh data.
		writeJSON(w, http.StatusOK, mcpServersResponse{
			Servers:   []claudeAiServer{},
			NeedsAuth: true,
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), mcpFetchTimeout)
	defer cancel()
	servers, status, ferr := fetchClaudeAiMcpServers(ctx, creds.AccessToken)
	if ferr != nil {
		// Network error / unparseable response — log + degrade to
		// "no claude.ai integrations" rather than failing /mcp.
		s.logger.Warn("claude.ai mcp_servers fetch failed",
			"err", ferr, "config_dir", configDir)
		writeJSON(w, http.StatusOK, mcpServersResponse{
			Servers:   []claudeAiServer{},
			NeedsAuth: false,
		})
		return
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		// Upstream said the token isn't accepted — same UI outcome as
		// scope-missing locally. Don't burn the user's time on a
		// hopeful retry.
		writeJSON(w, http.StatusOK, mcpServersResponse{
			Servers:   []claudeAiServer{},
			NeedsAuth: true,
		})
		return
	}
	if status >= 400 {
		s.logger.Warn("claude.ai mcp_servers non-OK", "status", status)
		writeJSON(w, http.StatusOK, mcpServersResponse{
			Servers:   []claudeAiServer{},
			NeedsAuth: false,
		})
		return
	}

	writeJSON(w, http.StatusOK, mcpServersResponse{
		Servers:   servers,
		NeedsAuth: false,
	})
}

// claudeAiServer mirrors the wire shape returned by the claude.ai MCP
// listing endpoint. We surface the bits the panel renders and drop
// internal fields (created_at, server-side metadata) the chat panel
// has no use for.
type claudeAiServer struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	URL         string `json:"url"`
}

type mcpServersResponse struct {
	Servers   []claudeAiServer `json:"servers"`
	NeedsAuth bool             `json:"needs_auth"`
}

// upstreamResp matches the body of api.anthropic.com/v1/mcp_servers.
// "data" is the actual list; pagination cursors exist but at the 1000
// limit we use, every real user fits on one page (claude.ai caps a
// user's connector count well below that). Extra fields are ignored.
type upstreamResp struct {
	Data []struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		URL         string `json:"url"`
	} `json:"data"`
}

// fetchClaudeAiMcpServers calls api.anthropic.com/v1/mcp_servers with
// the user's bearer token. Returns the parsed server list, the HTTP
// status (so the handler can distinguish 401/403 from network errors),
// and any wire-level error. status=0 means the request didn't reach a
// response (DNS, timeout, etc.).
func fetchClaudeAiMcpServers(
	ctx context.Context, accessToken string,
) ([]claudeAiServer, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, claudeAiMcpEndpoint, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-beta", mcpServersBetaHeader)
	req.Header.Set("anthropic-version", "2023-06-01")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return nil, res.StatusCode, nil
	}

	var body upstreamResp
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return nil, res.StatusCode, fmt.Errorf("decode: %w", err)
	}
	out := make([]claudeAiServer, 0, len(body.Data))
	for _, s := range body.Data {
		// Skip rows missing required fields rather than rendering
		// "(empty) · △ needs authentication" — the CLI wouldn't show
		// those either.
		if strings.TrimSpace(s.DisplayName) == "" {
			continue
		}
		out = append(out, claudeAiServer{
			ID:          s.ID,
			DisplayName: s.DisplayName,
			URL:         s.URL,
		})
	}
	return out, res.StatusCode, nil
}
