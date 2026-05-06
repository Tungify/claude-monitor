package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	tea "github.com/charmbracelet/bubbletea"
)

var (
	flagRoot    = flag.String("root", "", "Root directory holding account configs (default: ~/.claude-account)")
	flagVersion = flag.Bool("version", false, "Print version and exit")
)

// version is wired by ldflags via the Makefile.
var version = "dev"

func main() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr,
			"claude-monitor — real-time TUI dashboard for multiple Claude Code accounts.\n\n"+
				"All settings (auto-kick, refresh interval, color) are toggled inside the\n"+
				"app via hotkeys; press ? once running to see them. Settings persist to\n"+
				"~/.claude-monitor/config.json.\n\n"+
				"Usage:\n  %s [flags]\n\nFlags:\n", os.Args[0])
		flag.PrintDefaults()
	}
	flag.Parse()

	if *flagVersion {
		fmt.Println(version)
		return
	}

	root := *flagRoot
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			die("cannot determine home dir: %v", err)
		}
		root = filepath.Join(home, ".claude-account")
	}
	if _, err := os.Stat(root); err != nil {
		die("root %q is not accessible: %v", root, err)
	}

	cfg, _ := LoadConfig() // missing/corrupt → defaults; not fatal

	p := tea.NewProgram(initialModel(root, cfg), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		die("tui error: %v", err)
	}
}

func die(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}
