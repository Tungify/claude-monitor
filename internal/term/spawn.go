// Package term spawns a visible terminal window running a one-shot
// shell script — used by the dashboard's Relogin / Add account flow
// (internal/server/login.go) and the Cloudflare tunnel auto-setup
// (internal/tunnel/setup.go) to drive an interactive OAuth flow that
// needs a real TTY.
//
// macOS uses `open -a Terminal`. Linux probes a prioritized list of
// terminal emulators ($TERMINAL → gnome-terminal → konsole → ... →
// xterm). When nothing on the list resolves (headless box, SSH without
// X forwarding, WSL without WSLg) we return ErrNoTerminal so the caller
// can surface a manual fallback command instead of a generic 500.
package term

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

// ErrNoTerminal signals that no terminal emulator could be launched.
// Callers should wrap it with a user-facing manual fallback command
// (e.g. `CLAUDE_CONFIG_DIR=… claude auth login`).
var ErrNoTerminal = errors.New("no terminal emulator available")

// SpawnScript opens a visible terminal window running scriptPath via
// bash. The script is expected to handle its own UX (banner, prompts,
// cleanup) — this helper just gets it on screen. Returns immediately
// after the terminal process is launched; we don't wait for the script
// to finish.
func SpawnScript(scriptPath string) error {
	switch runtime.GOOS {
	case "darwin":
		return spawnDarwin(scriptPath)
	case "linux":
		return spawnLinux(scriptPath)
	default:
		return fmt.Errorf("interactive terminal spawn unsupported on GOOS=%s: %w", runtime.GOOS, ErrNoTerminal)
	}
}

func spawnDarwin(scriptPath string) error {
	cmd := exec.Command("open", "-a", "Terminal", scriptPath)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open Terminal: %w", err)
	}
	return nil
}

// linuxLaunchers is the prioritized lookup table for Linux terminals.
// Order matters: $TERMINAL first (user/window-manager override), then
// the per-DE defaults (Ubuntu/GNOME → KDE → XFCE), then wayland-friendly
// modern terminals, then the Debian alternatives system, then xterm as
// a last-resort that works on any X11 box.
//
// Exec-syntax differs per terminal:
//   - `-- bash script` (gnome-terminal, wezterm): separator then argv.
//   - `-e bash script` (xterm, alacritty, konsole): -e accepts argv.
//   - `-e "bash script"` (tilix, x-terminal-emulator): -e takes ONE
//     string that gets handed to /bin/sh -c.
//   - bare positional (kitty, foot): just append the command.
//   - `-x` (xfce4-terminal): legacy alias for execute-rest-of-argv.
var linuxLaunchers = []struct {
	bin     string
	argsFor func(scriptPath string) []string
}{
	{"gnome-terminal", func(p string) []string { return []string{"--", "bash", p} }},
	{"konsole", func(p string) []string { return []string{"-e", "bash", p} }},
	{"xfce4-terminal", func(p string) []string { return []string{"-x", "bash", p} }},
	{"tilix", func(p string) []string { return []string{"-e", "bash " + p} }},
	{"kitty", func(p string) []string { return []string{"bash", p} }},
	{"alacritty", func(p string) []string { return []string{"-e", "bash", p} }},
	{"wezterm", func(p string) []string { return []string{"start", "--", "bash", p} }},
	{"foot", func(p string) []string { return []string{"bash", p} }},
	{"x-terminal-emulator", func(p string) []string { return []string{"-e", "bash " + p} }},
	{"xterm", func(p string) []string { return []string{"-e", "bash", p} }},
}

func spawnLinux(scriptPath string) error {
	// $TERMINAL override: respect whatever the user has set. We pass the
	// script as a bare positional argv tail — works for most terminals;
	// users with an exotic CLI can wrap it in their own launcher script.
	if t := os.Getenv("TERMINAL"); t != "" {
		if path, err := exec.LookPath(t); err == nil {
			if err := startBg(path, "-e", "bash "+scriptPath); err == nil {
				return nil
			}
		}
	}

	for _, l := range linuxLaunchers {
		path, err := exec.LookPath(l.bin)
		if err != nil {
			continue
		}
		if err := startBg(path, l.argsFor(scriptPath)...); err == nil {
			return nil
		}
	}
	return fmt.Errorf("tried $TERMINAL, gnome-terminal, konsole, xterm, etc.: %w", ErrNoTerminal)
}

func startBg(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	return cmd.Start()
}
