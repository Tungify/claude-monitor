//go:build windows

package update

import "fmt"

// RestartSelf is a no-op on Windows. CreateProcess + Exit would leave
// the parent shell racing the new TUI for the console, which produces
// a flicker and sometimes a stuck prompt. Until we adopt a cleaner
// pattern (e.g. relaunch via cmd /c), we surface a message and let
// the user re-run the command themselves.
func RestartSelf() error {
	fmt.Println("✓ upgraded — run claude-monitor to use the new version.")
	return nil
}
