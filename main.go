package main

import (
	"flag"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
)

var (
	flagRoot = flag.String("root", "",
		"Account search path. Empty = auto-discover ~/.claude* in $HOME. "+
			"Otherwise a comma-separated list of paths; each path can be a single "+
			"Claude config dir or a parent directory containing several.")
	flagVersion = flag.Bool("version", false, "Print version and exit")
)

// version is wired by ldflags via the Makefile.
var version = "dev"

func main() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr,
			"claude-monitor — real-time TUI dashboard for multiple Claude Code accounts.\n\n"+
				"With no flags, it auto-discovers ~/.claude* directories in $HOME. Pass\n"+
				"--root to override. All in-app settings (auto-kick, interval, color)\n"+
				"are toggled via hotkeys and persisted to ~/.claude-monitor/config.json.\n\n"+
				"Usage:\n  %s [flags]\n\nFlags:\n", os.Args[0])
		flag.PrintDefaults()
	}
	flag.Parse()

	if *flagVersion {
		fmt.Println(version)
		return
	}

	cfg, _ := LoadConfig() // missing/corrupt → defaults; not fatal

	p := tea.NewProgram(initialModel(*flagRoot, cfg), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		die("tui error: %v", err)
	}
}

func die(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}
