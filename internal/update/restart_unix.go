//go:build !windows

package update

import (
	"fmt"
	"os"
	"syscall"
)

// RestartSelf replaces the running process with a fresh exec of the
// (just-upgraded) binary at the same path, preserving the original
// argv and environment. Unix-only — Windows lacks execve, so the
// windows variant prints a "run it again" hint instead.
//
// Called from main() after the bubbletea program has torn down its
// alt-screen, so the user's terminal is in a clean state by the time
// the new process starts drawing.
func RestartSelf() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate self: %w", err)
	}
	return syscall.Exec(exe, os.Args, os.Environ())
}
