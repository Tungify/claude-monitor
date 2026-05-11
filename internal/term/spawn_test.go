package term

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestSpawnScriptLinuxNoTerminal exercises the Linux fallback path: when
// nothing on linuxLaunchers resolves on PATH (and $TERMINAL is empty),
// SpawnScript must return ErrNoTerminal rather than a generic exec error
// — callers wrap that sentinel into a user-facing "run manually: …"
// message, and any other return value would leak as a 500 in the UI.
//
// We isolate the test from the host's real PATH by pointing it at an
// empty dir, and clear $TERMINAL so the override path doesn't kick in.
func TestSpawnScriptLinuxNoTerminal(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skipf("Linux-only path (GOOS=%s)", runtime.GOOS)
	}
	t.Setenv("PATH", t.TempDir())
	t.Setenv("TERMINAL", "")

	err := SpawnScript("/tmp/some-script.sh")
	if err == nil {
		t.Fatal("expected ErrNoTerminal, got nil")
	}
	if !errors.Is(err, ErrNoTerminal) {
		t.Errorf("err = %v, want errors.Is(ErrNoTerminal) = true", err)
	}
}

// TestSpawnScriptLinuxTerminalEnv verifies the $TERMINAL override path
// takes priority over the built-in launcher table. A fake "terminal"
// (just `true`) is dropped into a sandbox PATH and pointed at by
// $TERMINAL; SpawnScript should pick it up and Start() it successfully.
func TestSpawnScriptLinuxTerminalEnv(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skipf("Linux-only path (GOOS=%s)", runtime.GOOS)
	}
	dir := t.TempDir()
	fake := filepath.Join(dir, "faketerm")
	// /bin/true exits 0 immediately — perfect stand-in for a terminal
	// launcher we don't actually want to interact with.
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write fake terminal: %v", err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("TERMINAL", "faketerm")

	if err := SpawnScript("/tmp/some-script.sh"); err != nil {
		t.Errorf("SpawnScript with $TERMINAL set should succeed, got: %v", err)
	}
}

// TestSpawnScriptUnsupportedOS guards the Windows / freebsd / etc. case
// — SpawnScript must surface ErrNoTerminal so the caller routes to the
// manual-command fallback, never bubble a raw GOOS string up to a UI.
// We can only assert this when actually running on a non-darwin /
// non-linux GOOS, so the test is mostly a documentation pin.
func TestSpawnScriptUnsupportedOS(t *testing.T) {
	if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
		t.Skipf("unsupported-OS path doesn't fire on GOOS=%s", runtime.GOOS)
	}
	err := SpawnScript("/tmp/x.sh")
	if !errors.Is(err, ErrNoTerminal) {
		t.Errorf("err = %v, want errors.Is(ErrNoTerminal) = true", err)
	}
}
