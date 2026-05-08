package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/config"
	"claude-monitor/internal/keychain"
	"claude-monitor/internal/server"
	"claude-monitor/internal/swap"
	"claude-monitor/internal/tui"
	"claude-monitor/internal/update"
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
	flagServe = flag.String("serve", "",
		"Run as a daemon: bind an HTTP+SSE API at the given address "+
			"(e.g. 127.0.0.1:8788) for a separate UI to consume, and exit "+
			"only on SIGINT/SIGTERM. The TUI is not started in this mode.")
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
		if err := swap.ListAccounts(*flagRoot); err != nil {
			die("%v", err)
		}
		return
	}

	if *flagSwapTo != "" {
		if err := swap.To(*flagRoot, *flagSwapTo); err != nil {
			die("%v", err)
		}
		return
	}

	cfg, _ := config.Load() // missing/corrupt → defaults; not fatal

	if *flagServe != "" {
		if err := runServe(*flagServe, *flagRoot, cfg); err != nil {
			die("daemon: %v", err)
		}
		return
	}

	if *flagKeychainSetup {
		if err := keychain.RunSetup(discoverConfigDirs(*flagRoot)); err != nil {
			die("%v", err)
		}
		cfg.KeychainSetupDone = true
		_ = config.Save(cfg)
		return
	}

	// Clean up <exe>.old / <exe>.new from prior upgrades — Windows
	// can't remove them while the running process holds them.
	update.CleanupStaleArtifacts()

	// One-shot keychain registration on the first launch so future
	// swaps don't pop a password prompt every time. RunSetup is a
	// no-op on Linux/Windows (no partition list to update) and
	// short-circuits on darwin if stdin isn't a TTY or there are no
	// accounts yet. We always set the flag afterwards, even on
	// skip/failure, so the user isn't re-prompted on every launch —
	// they can rerun the bootstrap explicitly via --keychain-setup.
	if !cfg.KeychainSetupDone {
		_ = keychain.RunSetup(discoverConfigDirs(*flagRoot))
		cfg.KeychainSetupDone = true
		_ = config.Save(cfg)
	}

	restart, err := tui.Run(*flagRoot, cfg, version)
	if err != nil {
		die("tui error: %v", err)
	}
	// Auto-restart after a successful in-app [u]-upgrade so the user
	// lands back in the dashboard running the new version, without
	// having to re-type the command. On Windows this is a no-op
	// (RestartSelf prints a hint instead).
	if restart {
		if err := update.RestartSelf(); err != nil {
			fmt.Fprintf(os.Stderr, "auto-restart failed: %v\nrun `claude-monitor` to use the new version.\n", err)
		}
	}
}

// discoverConfigDirs is a thin caller-side helper around
// account.ResolveDirs so keychain.RunSetup stays a leaf (no account
// import). Returns nil when discovery fails, matching the behavior
// keychain.RunSetup expects (treats empty as "skip silently").
func discoverConfigDirs(rootSpec string) []string {
	accts, err := account.ResolveDirs(rootSpec)
	if err != nil || len(accts) == 0 {
		return nil
	}
	dirs := make([]string, len(accts))
	for i, a := range accts {
		dirs[i] = a.ConfigDir
	}
	return dirs
}

// runServe boots the daemon and blocks until SIGINT/SIGTERM. The
// keychain-setup bootstrap that gates TUI startup is intentionally
// skipped here — interactive password prompting doesn't fit a
// long-running headless daemon. Run `claude-monitor --keychain-setup`
// once before starting the daemon if swap prompts get noisy.
func runServe(addr, rootSpec string, cfg config.Config) error {
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	srv := server.New(rootSpec, cfg, logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return srv.Start(ctx, addr)
}

func runUpgrade() error {
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	info, err := update.FetchLatest(ctx)
	if err != nil {
		return err
	}
	if !update.IsNewer(info.LatestTag, version) {
		fmt.Printf("already on latest (%s)\n", version)
		return nil
	}
	fmt.Printf("upgrading %s → %s\n", version, info.LatestTag)
	if err := update.Perform(ctx, info); err != nil {
		return err
	}
	fmt.Printf("✓ upgraded to %s\n", info.LatestTag)
	return nil
}

func die(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}
