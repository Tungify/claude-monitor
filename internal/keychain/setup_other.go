//go:build !darwin

package keychain

// RunSetup is a no-op outside macOS. The Secret Service / libsecret
// model on Linux and the Credential Manager on Windows don't have an
// analogue of macOS's partition list — entries are accessible to any
// process running as the same user once unlocked, so claude-monitor's
// keychain writes never trigger an auth prompt to begin with.
func RunSetup(configDirs []string) error { return nil }
