//go:build !windows

package server

import (
	"os/exec"
	"syscall"
)

// killTreeOnCancel puts the probe in its own process group and kills
// the whole group on cancel. uvx execs the server as a grandchild, so
// killing uvx alone orphans it while it still holds the output pipe.
func killTreeOnCancel(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
