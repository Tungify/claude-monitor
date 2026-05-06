package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

var (
	flagRoot     = flag.String("root", "", "Root directory holding account configs (default: ~/.claude-account)")
	flagLive     = flag.Bool("live", false, "Live local-transcript token tracker (legacy mode)")
	flagInterval = flag.Duration("interval", 2*time.Second, "Refresh interval for --live mode")
	flagNoCost   = flag.Bool("no-cost", false, "Hide cost columns in --live mode")
	flagNoColor  = flag.Bool("no-color", false, "Disable ANSI colors")
	flagMaxCwd   = flag.Int("max-cwd", 40, "Max width of the active-cwd column in --live mode")
	flagBarWidth = flag.Int("bar", 25, "Width of the percentage bar in snapshot mode (chars)")
)

func main() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr,
			"claude-analytic — usage snapshot across multiple Claude Code accounts.\n\n"+
				"Default: one-shot snapshot of /api/oauth/usage percentages (5h, weekly).\n"+
				"--live:  legacy live mode that aggregates local transcript JSONL files.\n\n"+
				"Usage:\n  %s [flags]\n\nFlags:\n", os.Args[0])
		flag.PrintDefaults()
	}
	flag.Parse()

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

	if *flagLive {
		mon := NewMonitor(root)
		opts := RenderOpts{
			NoCost:   *flagNoCost,
			NoColor:  *flagNoColor,
			MaxCwd:   *flagMaxCwd,
			Interval: *flagInterval,
		}
		runLive(mon, opts)
		return
	}

	if err := RunSnapshot(root, SnapshotOpts{
		NoColor:  *flagNoColor,
		BarWidth: *flagBarWidth,
	}); err != nil {
		die("%v", err)
	}
}

func runLive(mon *Monitor, opts RenderOpts) {
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)

	hideCursor()
	clearScreen()
	defer func() {
		showCursor()
		fmt.Println()
	}()

	tick := time.NewTicker(opts.Interval)
	defer tick.Stop()

	render := func() {
		if err := mon.Refresh(); err != nil {
			cursorHome()
			fmt.Fprintf(os.Stderr, "scan failed: %v\n", err)
			return
		}
		cursorHome()
		fmt.Print(Render(mon.Snapshot(), opts))
		clearToEnd()
	}

	render()
	for {
		select {
		case <-tick.C:
			render()
		case <-sigs:
			return
		}
	}
}

func clearScreen() { fmt.Print("\x1b[2J") }
func clearToEnd()  { fmt.Print("\x1b[0J") }
func cursorHome()  { fmt.Print("\x1b[H") }
func hideCursor()  { fmt.Print("\x1b[?25l") }
func showCursor()  { fmt.Print("\x1b[?25h") }

func die(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}
