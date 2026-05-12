// Package uvx probes the local `uvx` launcher (Astral's `uv`
// toolchain) so DB MCP servers — both postgres-mcp and mcp-clickhouse
// — can be spawned. Kept driver-agnostic since uvx availability is a
// host property, not a per-driver one.
package uvx

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"
)

// Status describes whether `uvx` is reachable on PATH. The status
// feeds the web UI: when Available is false, the panel shows the
// install hint instead of letting users save connections that can't
// actually start.
type Status struct {
	Available bool   `json:"available"`
	Version   string `json:"version,omitempty"`
	Path      string `json:"path,omitempty"`
	// InstallHint is the shell snippet the UI suggests when Available
	// is false. Returned here so the daemon can vary it per-OS without
	// the panel needing platform awareness.
	InstallHint string `json:"install_hint,omitempty"`
}

// ErrMissing is returned by callers that require uvx (e.g.
// test-connection) when Check reports Available=false. Kept as a
// sentinel so the HTTP layer can map it to a specific 412 status.
var ErrMissing = errors.New("uvx is not installed or not on PATH")

// Check looks for `uvx` on PATH and runs `uvx --version` with a short
// timeout to confirm it's actually executable (not a broken shim).
// The 3s timeout caps how long a hanging binary can block the
// calling HTTP handler.
func Check(ctx context.Context) Status {
	hint := "curl -LsSf https://astral.sh/uv/install.sh | sh"

	bin, err := exec.LookPath("uvx")
	if err != nil {
		return Status{Available: false, InstallHint: hint}
	}

	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	out, err := exec.CommandContext(cctx, bin, "--version").CombinedOutput()
	if err != nil {
		return Status{Available: false, Path: bin, InstallHint: hint}
	}
	return Status{
		Available: true,
		Version:   strings.TrimSpace(string(out)),
		Path:      bin,
	}
}
