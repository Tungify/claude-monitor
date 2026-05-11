package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"claude-monitor/internal/account"
	"claude-monitor/internal/codex"
)

// handleAccountLogin spawns Terminal.app with `claude auth login` or
// `codex login` scoped to the given account's config dir, depending on
// the account's provider. The OAuth flow is interactive (the binary
// prints a URL and waits for paste-back), so we need a real pty — the
// daemon process has no tty of its own. macOS-only for now.
func (s *Server) handleAccountLogin(w http.ResponseWriter, r *http.Request) {
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
	s.mu.RLock()
	snap := s.snap
	s.mu.RUnlock()
	if snap == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no snapshot yet"})
		return
	}
	var configDir, provider string
	for _, a := range snap.Accounts {
		if a.Name == body.Ident || a.ConfigDir == body.Ident {
			configDir = a.ConfigDir
			provider = a.Provider
			break
		}
	}
	if configDir == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "account not found: " + body.Ident})
		return
	}
	launch := launchLoginTerminal
	if provider == string(account.ProviderOpenAI) {
		launch = launchCodexLoginTerminal
	}
	if err := launch(configDir, ""); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "config_dir": configDir})
}

// handleAccountAdd provisions a fresh config dir (Anthropic by default,
// OpenAI when body.Provider == "openai") then launches the matching
// terminal-based login flow. The next ticker refresh picks up the new
// dir via auto-discovery; we also kick a refresh so the row appears
// immediately for the UI.
func (s *Server) handleAccountAdd(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     string `json:"name"`
		Email    string `json:"email,omitempty"`
		Provider string `json:"provider,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
		return
	}
	provider := body.Provider
	if provider == "" {
		provider = string(account.ProviderAnthropic)
	}
	var (
		dir string
		err error
	)
	switch provider {
	case string(account.ProviderOpenAI):
		if err := codex.ValidateName(body.Name); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		dir, err = codex.Provision(body.Name)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
			return
		}
		if err := launchCodexLoginTerminal(dir, body.Email); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	default:
		if err := account.ValidateName(body.Name); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		dir, err = account.Provision(body.Name)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
			return
		}
		if err := launchLoginTerminal(dir, body.Email); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
	}
	s.refreshOnce(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"config_dir": dir,
		"name":       body.Name,
		"provider":   provider,
	})
}

// launchLoginTerminal writes a one-shot shell script that runs
// `claude auth login` with CLAUDE_CONFIG_DIR set, then opens it in
// Terminal.app. The script self-deletes via `rm -f -- "$0"` once
// claude exits, keeping /tmp clean.
func launchLoginTerminal(configDir, email string) error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("login flow currently macOS-only (GOOS=%s)", runtime.GOOS)
	}
	args := "auth login"
	if email != "" {
		args += " --email " + shellQuote(email)
	}
	return spawnLoginScript(fmt.Sprintf(
		"#!/bin/bash\nset +e\nCLAUDE_CONFIG_DIR=%s claude %s\nstatus=$?\nrm -f -- \"$0\"\nexit $status\n",
		shellQuote(configDir), args,
	))
}

// launchCodexLoginTerminal is the OpenAI counterpart: spawns
// Terminal.app to run `codex login` with $CODEX_HOME set, so the
// resulting auth.json lands in the right per-account directory.
// `codex login` doesn't accept --email — Codex's OAuth provider
// (auth.openai.com) prompts the user to pick the account interactively
// — so the email argument is ignored here. Kept on the signature for
// symmetry with launchLoginTerminal; future Codex versions might add
// a hint flag and we won't need a caller-side change.
func launchCodexLoginTerminal(configDir, _email string) error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("login flow currently macOS-only (GOOS=%s)", runtime.GOOS)
	}
	return spawnLoginScript(fmt.Sprintf(
		"#!/bin/bash\nset +e\nCODEX_HOME=%s codex login\nstatus=$?\nrm -f -- \"$0\"\nexit $status\n",
		shellQuote(configDir),
	))
}

// spawnLoginScript writes script to a self-deleting temp file under
// /tmp and asks `open -a Terminal` to run it. Factored out of
// launchLoginTerminal so the OpenAI variant doesn't duplicate the
// chmod/Open-app dance.
func spawnLoginScript(script string) error {
	f, err := os.CreateTemp("", "claude-monitor-login-*.sh")
	if err != nil {
		return fmt.Errorf("create script: %w", err)
	}
	if _, err := f.WriteString(script); err != nil {
		f.Close()
		return fmt.Errorf("write script: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close script: %w", err)
	}
	if err := os.Chmod(f.Name(), 0o700); err != nil {
		return fmt.Errorf("chmod: %w", err)
	}
	// `open -a Terminal <script>` respects user's default Terminal
	// (Terminal.app or whatever they've assigned). Start (not Run)
	// so the daemon doesn't block waiting for the user to finish.
	cmd := exec.Command("open", "-a", "Terminal", f.Name())
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open Terminal: %w", err)
	}
	return nil
}

// shellQuote single-quotes a string for safe inclusion in a bash
// command. Embedded single quotes are escaped via the standard
// '\'' trick so paths with apostrophes still work.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
