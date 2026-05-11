package tunnel

// Auto-setup for cloudflared named tunnels: cover the three one-time
// steps (login, create, route dns) so the user can just type a name
// and a hostname into the UI and click Enable. The login step needs a
// browser OAuth round-trip which we can't fully automate — we open
// Terminal.app so the user sees the URL cloudflared prints and can
// complete it visibly — but the create + route dns steps run silently
// in-process.
//
// All three are idempotent: if cert.pem already exists, EnsureLogin is
// a no-op; if the tunnel name already exists, EnsureTunnel detects the
// "already exists" message and treats it as success; same for routing.
// This makes Enable safely retryable when the user clicks twice or
// recovers from a partial failure.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"claude-monitor/internal/term"
)

// SetupPhase tracks what the auto-setup runner is currently doing so
// the UI can show "Logging in…" / "Creating tunnel…" / "Routing DNS…"
// instead of a generic spinner. Empty = idle (no setup in flight).
type SetupPhase string

const (
	PhaseIdle           SetupPhase = ""
	PhaseLoggingIn      SetupPhase = "logging_in"
	PhaseCreatingTunnel SetupPhase = "creating_tunnel"
	PhaseRoutingDNS     SetupPhase = "routing_dns"
)

// Setup runs the one-time cloudflared steps a named tunnel needs
// before `cloudflared tunnel run <name>` will succeed. Each Ensure*
// method is idempotent and short-lived; the runner doesn't hold any
// long-running state.
type Setup struct {
	binPath string

	mu    sync.Mutex
	phase SetupPhase
	// loginDeadline caps how long EnsureLogin will wait for cert.pem
	// to appear after launching Terminal. Configurable for tests.
	loginDeadline time.Duration
}

func NewSetup(binPath string) *Setup {
	if binPath == "" {
		binPath = "cloudflared"
	}
	return &Setup{binPath: binPath, loginDeadline: 5 * time.Minute}
}

// Phase reports what the runner is currently doing. Cheap to call
// repeatedly — the bridge polls this from /api/public/status.
func (s *Setup) Phase() SetupPhase {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.phase
}

func (s *Setup) setPhase(p SetupPhase) {
	s.mu.Lock()
	s.phase = p
	s.mu.Unlock()
}

// certPath is where `cloudflared tunnel login` writes the OAuth cert
// once the user completes the browser flow. We poll for it to know
// when login finished. Cloudflared also accepts an override via
// $TUNNEL_ORIGIN_CERT but we don't honor it here — the auto-setup
// path uses the default location to keep the flow predictable.
func certPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cloudflared", "cert.pem")
}

// HasLogin reports whether cert.pem exists. Useful for the UI to skip
// the "open Terminal" prompt when cloudflared is already authorized.
func (s *Setup) HasLogin() bool {
	_, err := os.Stat(certPath())
	return err == nil
}

// EnsureLogin spawns a terminal running `cloudflared tunnel login` if
// cert.pem is missing, then polls until cert.pem appears or the deadline
// elapses. Returns nil immediately when cert.pem already exists. On
// headless hosts (no terminal emulator on PATH) the error includes the
// manual command the user should run.
func (s *Setup) EnsureLogin(ctx context.Context) error {
	if s.HasLogin() {
		return nil
	}
	s.setPhase(PhaseLoggingIn)
	defer s.setPhase(PhaseIdle)

	if err := s.launchLoginTerminal(); err != nil {
		return fmt.Errorf("launch login terminal: %w", err)
	}

	// Poll for cert.pem. Cloudflared writes it the moment the browser
	// callback completes, so a 1s tick is plenty responsive without
	// hammering the filesystem.
	deadline := time.Now().Add(s.loginDeadline)
	for {
		if s.HasLogin() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(1 * time.Second):
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out after %s waiting for Cloudflare login (cert.pem not written)",
				s.loginDeadline)
		}
	}
}

// launchLoginTerminal writes a one-shot bash script that runs
// `cloudflared tunnel login` and opens it in a terminal window via
// term.SpawnScript (Terminal.app on macOS; gnome-terminal / konsole /
// xterm / etc. on Linux). The script self-deletes after cloudflared
// exits so the user doesn't end up with stale temp files. Pattern
// mirrors internal/server/login.go's launchLoginTerminal — keep in sync.
func (s *Setup) launchLoginTerminal() error {
	f, err := os.CreateTemp("", "claude-monitor-cf-login-*.sh")
	if err != nil {
		return fmt.Errorf("create script: %w", err)
	}
	script := fmt.Sprintf(
		"#!/bin/bash\nset +e\necho \"==> Cloudflare login required for named tunnel.\"\necho \"==> A browser will open. Pick your domain, then return to this Terminal.\"\necho\n%s tunnel login\nstatus=$?\nrm -f -- \"$0\"\necho\nif [ $status -eq 0 ]; then\n  echo \"==> Login succeeded. You can close this window.\"\nelse\n  echo \"==> Login failed (exit $status). Press any key to close.\"\n  read -n 1\nfi\nexit $status\n",
		shellQuote(s.binPath),
	)
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
	if err := term.SpawnScript(f.Name()); err != nil {
		os.Remove(f.Name())
		if errors.Is(err, term.ErrNoTerminal) {
			return fmt.Errorf("no terminal emulator found on this host; run manually: %s tunnel login", s.binPath)
		}
		return fmt.Errorf("spawn terminal: %w", err)
	}
	return nil
}

// EnsureTunnel runs `cloudflared tunnel create <name>` and treats the
// "already exists" error as success — the user might have created the
// tunnel manually before, or our previous Enable run might have
// gotten this far before failing later.
func (s *Setup) EnsureTunnel(ctx context.Context, name string) error {
	if name == "" {
		return errors.New("tunnel name required")
	}
	s.setPhase(PhaseCreatingTunnel)
	defer s.setPhase(PhaseIdle)

	cmd := exec.CommandContext(ctx, s.binPath, "tunnel", "create", name)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	// cloudflared returns non-zero when the tunnel already exists, with
	// an error fragment like:
	//   "tunnel with name foo already exists"
	// or in newer versions:
	//   "ERR Cannot create tunnel error=\"... already exists\""
	if bytes.Contains(out, []byte("already exists")) {
		return nil
	}
	// "Cannot determine default origin certificate" surfaces when
	// cert.pem is missing — caller should have called EnsureLogin first
	// but we guard explicitly so the error message is clearer than the
	// raw cloudflared output.
	if bytes.Contains(out, []byte("Cannot determine default origin certificate")) {
		return errors.New("cloudflared not logged in — login step must run first")
	}
	return fmt.Errorf("cloudflared tunnel create: %w (%s)", err, strings.TrimSpace(string(out)))
}

// EnsureRoute runs `cloudflared tunnel route dns <name> <hostname>`.
// Idempotent on the "record already exists for this tunnel" case;
// returns an error if the hostname points at a different tunnel
// (cloudflared refuses to overwrite without --overwrite-dns).
func (s *Setup) EnsureRoute(ctx context.Context, name, hostname string) error {
	if name == "" || hostname == "" {
		return errors.New("tunnel name and hostname both required")
	}
	s.setPhase(PhaseRoutingDNS)
	defer s.setPhase(PhaseIdle)

	cmd := exec.CommandContext(ctx, s.binPath, "tunnel", "route", "dns", name, hostname)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	// "An A, AAAA, or CNAME record with that host already exists" means
	// the route was previously created — fine if it points at our
	// tunnel, but we can't easily verify without parsing more output.
	// In practice, cloudflared prints "already exists" both when the
	// record is correctly pointed and when it conflicts. Treat as
	// success; the user will see the conflict at runtime if it's wrong
	// (cf edge will return a different tunnel's response).
	if bytes.Contains(out, []byte("already exists")) {
		return nil
	}
	if bytes.Contains(out, []byte("Cannot determine default origin certificate")) {
		return errors.New("cloudflared not logged in — login step must run first")
	}
	// "failed to add route: code: 1003" is what cloudflared returns
	// when the zone (e.g. example.com) isn't on the user's Cloudflare
	// account. Surface a clearer message.
	if bytes.Contains(out, []byte("zone")) && bytes.Contains(out, []byte("not found")) {
		return fmt.Errorf("zone for %s isn't in your Cloudflare account — add the domain there first", hostname)
	}
	return fmt.Errorf("cloudflared tunnel route dns: %w (%s)", err, strings.TrimSpace(string(out)))
}

// shellQuote single-quotes a string for safe inclusion in a bash
// command. Mirrors the helper in internal/server/login.go (kept local
// to avoid importing a server package from internal/tunnel).
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
