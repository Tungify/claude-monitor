package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"claude-monitor/internal/mcp/connections"
	"claude-monitor/internal/mcp/uvx"
)

// listResponse is the GET /api/mcp/connections payload. Connections
// are serialized through their Redacted form so passwords/URIs never
// leave the daemon's address space over HTTP.
type listResponse struct {
	Connections []connections.Connection `json:"connections"`
	UVX         uvx.Status               `json:"uvx"`
}

func (s *Server) handleMcpConnectionsList(w http.ResponseWriter, r *http.Request) {
	all, err := connections.LoadAll()
	if err != nil {
		s.logger.Warn("mcp connections load failed", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
		return
	}
	redacted := make([]connections.Connection, 0, len(all))
	for _, c := range all {
		redacted = append(redacted, c.Redacted())
	}
	writeJSON(w, http.StatusOK, listResponse{
		Connections: redacted,
		UVX:         uvx.Check(r.Context()),
	})
}

// handleMcpConnectionsCreate persists a new connection then applies
// the full set into every managed account's .claude.json. Application
// failure surfaces as a non-fatal warning in the response so the UI
// can show a toast — the connection is already on disk and the next
// account swap / restart will retry.
func (s *Server) handleMcpConnectionsCreate(w http.ResponseWriter, r *http.Request) {
	var body connections.Connection
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid json: " + err.Error(),
		})
		return
	}
	saved, applyErr, mutateErr := connections.CreateAndApply(s.rootSpec, body)
	if mutateErr != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"error": mutateErr.Error(),
		})
		return
	}
	var warning string
	if applyErr != nil {
		s.logger.Warn("connections inject failed", "err", applyErr)
		warning = applyErr.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"connection": saved.Redacted(),
		"warning":    warning,
	})
}

func (s *Server) handleMcpConnectionsUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}
	var body connections.Connection
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid json: " + err.Error(),
		})
		return
	}
	saved, applyErr, mutateErr := connections.UpdateAndApply(s.rootSpec, id, body)
	if mutateErr != nil {
		// "not found" is the only error we want to map to 404; all
		// other validate/persist errors are 422.
		if strings.Contains(mutateErr.Error(), "not found") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": mutateErr.Error()})
			return
		}
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": mutateErr.Error()})
		return
	}
	var warning string
	if applyErr != nil {
		s.logger.Warn("connections inject failed", "err", applyErr)
		warning = applyErr.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"connection": saved.Redacted(),
		"warning":    warning,
	})
}

func (s *Server) handleMcpConnectionsDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}
	removed, ok, applyErr, mutateErr := connections.DeleteAndApply(s.rootSpec, id)
	if mutateErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": mutateErr.Error(),
		})
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	var warning string
	if applyErr != nil {
		s.logger.Warn("connections strip failed", "err", applyErr)
		warning = applyErr.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"removed": removed.Redacted(),
		"warning": warning,
	})
}

// handleMcpConnectionsTest spawns the appropriate uvx-launched MCP
// server long enough to confirm it boots. Same timeout-as-success
// pattern as the legacy single-tier handler — startup pulls the
// Python package on first run; on subsequent runs the warm uv cache
// makes it near-instant.
//
// The body is a draft Connection. When ID is set (i.e. the user is
// editing an existing connection), missing secrets fall back to the
// persisted record's values — mirroring the same "empty == keep
// existing" sentinel that Update uses. That lets the UI gate Save on
// a passing Test even when the user is only renaming the connection
// or tweaking a non-secret field.
func (s *Server) handleMcpConnectionsTest(w http.ResponseWriter, r *http.Request) {
	var body connections.Connection
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid json: " + err.Error(),
		})
		return
	}
	if strings.TrimSpace(body.ID) != "" {
		if existing, ok, err := connections.FindByID(body.ID); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
			return
		} else if ok {
			if body.Driver == connections.DriverPostgres && body.URI == "" {
				body.URI = existing.URI
			}
			if body.Driver == connections.DriverClickHouse && body.Password == "" {
				body.Password = existing.Password
			}
			if body.Driver == connections.DriverRedis && body.Password == "" {
				body.Password = existing.Password
			}
		}
	}
	// Test doesn't require the name to be set (caller may be testing
	// before deciding on a name). Force it to a placeholder so the
	// per-driver field check is what fails on bad inputs.
	if strings.TrimSpace(body.Name) == "" {
		body.Name = "draft"
	}
	if err := body.Validate(); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"error": err.Error(),
		})
		return
	}
	st := uvx.Check(r.Context())
	if !st.Available {
		writeJSON(w, http.StatusPreconditionFailed, map[string]any{
			"error": uvx.ErrMissing.Error(),
			"uvx":   st,
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	cmd, err := testCommand(ctx, body)
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"error": err.Error(),
		})
		return
	}
	out, runErr := cmd.CombinedOutput()
	switch {
	case runErr == nil:
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":     true,
			"output": tailLines(string(out), 5),
		})
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		// Timeout while the server was running = "it booted, we tore
		// it down" — the success path for an stdio MCP server that
		// stays alive until its caller closes stdin.
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":     true,
			"output": tailLines(string(out), 5),
		})
	default:
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"ok":     false,
			"error":  runErr.Error(),
			"output": tailLines(string(out), 20),
		})
	}
}

// tailLines returns the last n non-empty lines of s. Used to trim
// uvx-spawned-server startup chatter to something digestible in a
// toast.
func tailLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	out := make([]string, 0, n)
	for i := len(lines) - 1; i >= 0 && len(out) < n; i-- {
		l := strings.TrimSpace(lines[i])
		if l == "" {
			continue
		}
		out = append([]string{l}, out...)
	}
	return strings.Join(out, "\n")
}

// testCommand derives the spawn from the Connection's Stanza so the
// test path can't drift from the production stanza emitted into
// .claude.json. Every driver branch reduces to "take stanza, merge
// its env into os.Environ, exec command+args."
//
// Type assertions are strict (not the comma-ok-discard form): every
// driver Stanza must emit []string args and map[string]string env. A
// silently-failed assertion here would test-spawn the wrong binary
// shape and report a false-positive success, which is worse than the
// loud 500 we now return.
func testCommand(ctx context.Context, c connections.Connection) (*exec.Cmd, error) {
	stanza := c.Stanza()
	if stanza == nil {
		return nil, errors.New("connection produced no stanza (missing required fields?)")
	}
	cmdName, ok := stanza["command"].(string)
	if !ok || cmdName == "" {
		return nil, errors.New("stanza missing command")
	}
	args, ok := stanza["args"].([]string)
	if !ok {
		return nil, fmt.Errorf("stanza args has unexpected type %T (want []string)", stanza["args"])
	}
	cmd := exec.CommandContext(ctx, cmdName, args...)
	env := os.Environ()
	if rawEnv, present := stanza["env"]; present {
		stanzaEnv, ok := rawEnv.(map[string]string)
		if !ok {
			return nil, fmt.Errorf("stanza env has unexpected type %T (want map[string]string)", rawEnv)
		}
		for k, v := range stanzaEnv {
			env = append(env, k+"="+v)
		}
	}
	cmd.Env = env
	return cmd, nil
}
