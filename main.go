package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

var (
	flagRoot = flag.String("root", "",
		"Account search path. Empty = auto-discover ~/.claude* in $HOME. "+
			"Otherwise a comma-separated list of paths; each path can be a single "+
			"Claude config dir or a parent directory containing several.")
	flagVersion = flag.Bool("version", false, "Print version and exit")
	flagUpgrade = flag.Bool("upgrade", false, "Download and install the latest release, then exit")
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

	if *flagUpgrade {
		if err := runUpgrade(); err != nil {
			die("upgrade failed: %v", err)
		}
		return
	}

	// Clean up <exe>.old / <exe>.new from prior upgrades — Windows
	// can't remove them while the running process holds them.
	cleanupStaleUpgradeArtifacts()

	cfg, _ := LoadConfig() // missing/corrupt → defaults; not fatal

	p := tea.NewProgram(initialModel(*flagRoot, cfg), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		die("tui error: %v", err)
	}
}

func runUpgrade() error {
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	info, err := fetchLatestRelease(ctx)
	if err != nil {
		return err
	}
	if !isNewerVersion(info.LatestTag, version) {
		fmt.Printf("already on latest (%s)\n", version)
		return nil
	}
	fmt.Printf("upgrading %s → %s\n", version, info.LatestTag)
	if err := PerformUpgrade(ctx, info); err != nil {
		return err
	}
	fmt.Printf("✓ upgraded to %s\n", info.LatestTag)
	return nil
}

func die(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}
