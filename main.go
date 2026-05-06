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
	flagSwapTo  = flag.String("swap-to", "",
		"Rewrite the default keychain slot to the given account (by name, email, or config dir) and exit. "+
			"Lets a `/switch-account` slash command flip the running `claude` tab to a different account.")
	flagListAccounts = flag.Bool("list-accounts", false,
		"Print discovered accounts (name, email, 5h utilization, active marker) and exit.")
	flagKeychainSetup = flag.Bool("keychain-setup", false,
		"Re-register claude-monitor with the macOS keychain so account swaps don't prompt for "+
			"a password every time. Asks for your macOS user password once (not stored). "+
			"No-op on Linux/Windows.")
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

	if *flagListAccounts {
		if err := ListAccounts(*flagRoot); err != nil {
			die("%v", err)
		}
		return
	}

	if *flagSwapTo != "" {
		if err := SwapTo(*flagRoot, *flagSwapTo); err != nil {
			die("%v", err)
		}
		return
	}

	cfg, _ := LoadConfig() // missing/corrupt → defaults; not fatal

	if *flagKeychainSetup {
		if err := RunKeychainSetup(*flagRoot); err != nil {
			die("%v", err)
		}
		cfg.KeychainSetupDone = true
		_ = SaveConfig(cfg)
		return
	}

	// Clean up <exe>.old / <exe>.new from prior upgrades — Windows
	// can't remove them while the running process holds them.
	cleanupStaleUpgradeArtifacts()

	// One-shot keychain registration on the first launch so future
	// swaps don't pop a password prompt every time. RunKeychainSetup
	// is a no-op on Linux/Windows (no partition list to update) and
	// short-circuits on darwin if stdin isn't a TTY or there are no
	// accounts yet. We always set the flag afterwards, even on
	// skip/failure, so the user isn't re-prompted on every launch —
	// they can rerun the bootstrap explicitly via --keychain-setup.
	if !cfg.KeychainSetupDone {
		_ = RunKeychainSetup(*flagRoot)
		cfg.KeychainSetupDone = true
		_ = SaveConfig(cfg)
	}

	p := tea.NewProgram(initialModel(*flagRoot, cfg), tea.WithAltScreen())
	final, err := p.Run()
	if err != nil {
		die("tui error: %v", err)
	}
	// Auto-restart after a successful in-app [u]-upgrade so the user
	// lands back in the dashboard running the new version, without
	// having to re-type the command. On Windows this is a no-op
	// (restartSelf prints a hint instead — see restart_windows.go).
	if mm, ok := final.(model); ok && mm.UpgradeRestart {
		if err := restartSelf(); err != nil {
			fmt.Fprintf(os.Stderr, "auto-restart failed: %v\nrun `claude-monitor` to use the new version.\n", err)
		}
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
