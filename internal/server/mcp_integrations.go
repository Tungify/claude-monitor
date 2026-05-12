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

	"claude-monitor/internal/mcp/integrations"
)

// integrationsListResponse mirrors connectionsListResponse — wraps the
// redacted records in a {integrations: [...]} envelope so future
// per-list metadata (auth status, last-tested timestamp, …) has a
// place to live without an API break.
type integrationsListResponse struct {
	Integrations []integrations.Integration `json:"integrations"`
}

func (s *Server) handleMcpIntegrationsList(w http.ResponseWriter, r *http.Request) {
	all, err := integrations.LoadAll()
	if err != nil {
		s.logger.Warn("mcp integrations load failed", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": err.Error(),
		})
		return
	}
	redacted := make([]integrations.Integration, 0, len(all))
	for _, i := range all {
		redacted = append(redacted, i.Redacted())
	}
	writeJSON(w, http.StatusOK, integrationsListResponse{
		Integrations: redacted,
	})
}

func (s *Server) handleMcpIntegrationsCreate(w http.ResponseWriter, r *http.Request) {
	var body integrations.Integration
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid json: " + err.Error(),
		})
		return
	}
	saved, applyErr, mutateErr := integrations.CreateAndApply(s.rootSpec, body)
	if mutateErr != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"error": mutateErr.Error(),
		})
		return
	}
	var warning string
	if applyErr != nil {
		s.logger.Warn("integrations inject failed", "err", applyErr)
		warning = applyErr.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"integration": saved.Redacted(),
		"warning":     warning,
	})
}

func (s *Server) handleMcpIntegrationsUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}
	var body integrations.Integration
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid json: " + err.Error(),
		})
		return
	}
	saved, applyErr, mutateErr := integrations.UpdateAndApply(s.rootSpec, id, body)
	if mutateErr != nil {
		if strings.Contains(mutateErr.Error(), "not found") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": mutateErr.Error()})
			return
		}
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": mutateErr.Error()})
		return
	}
	var warning string
	if applyErr != nil {
		s.logger.Warn("integrations inject failed", "err", applyErr)
		warning = applyErr.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"integration": saved.Redacted(),
		"warning":     warning,
	})
}

// handleMcpIntegrationsToggle flips the integration's Disabled flag
// and re-applies the full set. UI uses this to park an integration
// (strip from all accounts) without losing the configured secrets.
func (s *Server) handleMcpIntegrationsToggle(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}
	saved, applyErr, mutateErr := integrations.ToggleAndApply(s.rootSpec, id)
	if mutateErr != nil {
		if strings.Contains(mutateErr.Error(), "not found") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": mutateErr.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": mutateErr.Error()})
		return
	}
	var warning string
	if applyErr != nil {
		s.logger.Warn("integrations toggle apply failed", "err", applyErr)
		warning = applyErr.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"integration": saved.Redacted(),
		"warning":     warning,
	})
}

func (s *Server) handleMcpIntegrationsDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}
	removed, ok, applyErr, mutateErr := integrations.DeleteAndApply(s.rootSpec, id)
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
		s.logger.Warn("integrations strip failed", "err", applyErr)
		warning = applyErr.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"removed": removed.Redacted(),
		"warning": warning,
	})
}

// handleMcpIntegrationsTest spawns the npx-launched MCP server long
// enough to confirm it boots. Timeout-as-success mirrors the DB
// connections test path: stdio MCP servers stay alive until their
// caller closes stdin, so "we hit the deadline" = "the binary
// downloaded, launched, and parsed our env vars without bailing."
//
// The body is a draft Integration. When ID is set (editing an
// existing record), missing secrets fall back to the persisted
// values — mirrors the "empty == keep existing" sentinel that Update
// uses. That lets the UI gate Save on a passing Test even when the
// user is only toggling the add-message flag or renaming.
func (s *Server) handleMcpIntegrationsTest(w http.ResponseWriter, r *http.Request) {
	var body integrations.Integration
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "invalid json: " + err.Error(),
		})
		return
	}
	if strings.TrimSpace(body.ID) != "" {
		if existing, ok, err := integrations.FindByID(body.ID); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": err.Error(),
			})
			return
		} else if ok {
			switch body.Service {
			case integrations.ServiceSlack:
				if strings.TrimSpace(body.SlackToken) == "" {
					body.SlackToken = existing.SlackToken
				}
			case integrations.ServiceClickUp:
				if strings.TrimSpace(body.ClickUpAPIKey) == "" {
					body.ClickUpAPIKey = existing.ClickUpAPIKey
				}
			case integrations.ServiceGithub:
				if strings.TrimSpace(body.GithubToken) == "" {
					body.GithubToken = existing.GithubToken
				}
			}
		}
	}
	// Test doesn't require the name to be set — caller may be testing
	// before committing to a name. Force a placeholder so the
	// per-service field check is what fails on bad inputs.
	if strings.TrimSpace(body.Name) == "" {
		body.Name = "draft"
	}
	if err := body.Validate(); err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"error": err.Error(),
		})
		return
	}

	// Cold npx / docker pull fetches the package the first time, which
	// can take >5s on slow networks. Keep the deadline generous; the
	// timeout = success branch below absorbs the wait either way.
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	cmd, err := integrationsTestCommand(ctx, body)
	if err != nil {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"error": err.Error(),
		})
		return
	}

	// Precondition check happens after stanza build so the error
	// message names the actual runtime each service needs (npx for
	// Slack/ClickUp's node-distributed servers, docker for GitHub's
	// ghcr image). exec.CommandContext stashes the LookPath error on
	// cmd.Err — using that is more reliable than re-running LookPath
	// against cmd.Path (which gets rewritten to the absolute path on
	// successful resolve).
	if cmd.Err != nil {
		writeJSON(w, http.StatusPreconditionFailed, map[string]any{
			"error": integrationsRuntimeError(body.Service, cmd.Err),
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

// integrationsRuntimeError shapes the precondition error message
// around which runtime the per-service stanza needs. Keeps the
// "install Node.js" / "install Docker" guidance close to the actual
// LookPath failure rather than buried in service-agnostic text.
func integrationsRuntimeError(svc integrations.Service, lookupErr error) string {
	switch svc {
	case integrations.ServiceGithub:
		return "docker is not installed or not on PATH (Docker is required to run the official GitHub MCP server image): " + lookupErr.Error()
	default:
		return "npx is not installed or not on PATH (install Node.js to enable this integration): " + lookupErr.Error()
	}
}

// integrationsTestCommand mirrors testCommand for connections — pull
// the spawn shape from Stanza so the test path can't drift from
// what's persisted into .claude.json. Strict type assertions so a
// mis-shaped Stanza surfaces as a 500 rather than a false-positive
// test pass.
func integrationsTestCommand(ctx context.Context, in integrations.Integration) (*exec.Cmd, error) {
	stanza := in.Stanza()
	if stanza == nil {
		return nil, errors.New("integration produced no stanza (missing required fields?)")
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
