//go:build windows

package server

import "os/exec"

// killTreeOnCancel is a no-op on Windows; WaitDelay still unblocks the
// probe when a grandchild outlives uvx.
func killTreeOnCancel(cmd *exec.Cmd) {}
