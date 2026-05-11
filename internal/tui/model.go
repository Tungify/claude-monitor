// Package tui owns the bubbletea dashboard. Run is the only exported
// entry point — everything else (model, messages, commands, views) is
// package-internal and split across files by concern: model.go
// (state + Init), messages.go (msg types), update.go (Update +
// hotkeys), view.go (rendering), refresh.go (commands), picker.go
// (manual swap), editor.go (settings form), styles.go (lipgloss
// palette), cells.go (per-cell renderers), format.go (text helpers).
package tui

import (
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"claude-monitor/internal/account"
	"claude-monitor/internal/config"
	"claude-monitor/internal/swap"
	"claude-monitor/internal/update"
)

type model struct {
	cfg     config.Config
	root    string
	version string
	// webURL is the orchestrator URL the [o] hotkey opens in the user's
	// browser. Empty means no spawn was hinted (legacy --tui standalone)
	// — the hotkey shows a flash instead of trying to open nothing.
	webURL string

	rows        []account.Row
	activeDir   string
	lastSwap    *swap.Event
	swapErr     error
	prevUtil    map[string]float64
	err         error
	lastRefresh time.Time
	refreshing  bool

	// backoff[configDir] is the earliest moment at which we'll call
	// the API for that account again. Populated when an account hits
	// HTTP 429 and cleared once the window expires (lazily, on next
	// refresh) or when the user presses 'R' to force a retry.
	backoff map[string]time.Time

	// refreshBackoff[configDir] is the deadline for refresh-source
	// 429s. Unlike backoff, this map is rendering-only — snapshot.go
	// does NOT pre-skip on it, because the api package's circuit
	// breaker handles the actual throttling and a parallel `claude`
	// invocation may refresh the keychain entry before our deadline
	// elapses. Storing the deadline here lets the view's live-second
	// loop tick the "retry in Xs" countdown down smoothly instead of
	// freezing at whatever value the last tick captured.
	refreshBackoff map[string]time.Time

	// inflight is incremented every time we issue a refreshCmd and
	// compared against the version embedded in the resulting
	// refreshMsg — a stale result from a previous tick is discarded
	// if a newer refresh has been started in the meantime.
	inflight uint64

	flash       string
	flashExpiry time.Time

	// Update state. updateInfo is populated asynchronously on Init by
	// update.Check; nil means no banner. upgrading is true while a
	// [u]-triggered self-replace is downloading. upgradeRestart is
	// read by Run() after p.Run() returns: true means "we
	// successfully replaced the binary, please re-exec yourself so
	// the user lands in the new version's TUI without typing the
	// command again".
	updateInfo     *update.Info
	upgrading      bool
	upgradeRestart bool

	width    int
	height   int
	showHelp bool

	editing bool
	editor  editorState

	// Manual-swap picker state. When picking is true, [m] is open and
	// pickCursor is the index into m.rows of the highlighted row;
	// arrow keys move it, Enter executes the swap. manualPickDir is
	// the configDir of the user's most recent manual pick — while
	// it equals the active dir, auto-swap's rebalance-on-reset is
	// suppressed (the threshold cascade still applies, so the pick
	// sticks until the next tier is hit).
	picking       bool
	pickCursor    int
	manualPickDir string
	// manualPickUtil is the effective util (max of 5h and weekly) of
	// the picked account at the moment of pin. decideSwap uses it to
	// skip threshold tiers the user already saw at pin time — so a
	// deliberate pick at 52% with thresholds [50, 80, 100] sticks
	// until 80, not 50.
	manualPickUtil float64
	manualSwapping bool

	// pickerMode toggles what [enter] does in the picker overlay.
	// pickerSwap (default) wires Enter to manualSwapCmd; pickerRelogin
	// wires it to loginCmd against the highlighted row's config dir.
	// Both modes share picker.go's cursor-and-arrow handling.
	pickerMode pickerMode

	// Add-account form state. addingAccount mirrors editing/picking —
	// only one overlay is active at a time. addState owns the text
	// buffers and validation feedback.
	addingAccount bool
	addState      addState

	// loggingIn is true while a tea.ExecProcess for `claude auth login`
	// is running (terminal handed off, TUI suspended). Set when we
	// dispatch loginCmd, cleared by loginDoneMsg. Used to gate hotkeys
	// so a stray keypress queued before resume doesn't fire on the
	// next frame.
	loggingIn bool
}

// pickerMode is what the [enter] key does inside the picker overlay.
// Both modes use the same row-cursor UI; only the action on confirm
// differs.
type pickerMode int

const (
	pickerSwap pickerMode = iota
	pickerRelogin
)

func initialModel(root string, cfg config.Config, version, webURL string) model {
	// Start at inflight=1, refreshing=true so the first frame already
	// shows "loading…" while Init's refreshCmd runs.
	return model{
		root:       root,
		cfg:        cfg,
		version:    version,
		webURL:     webURL,
		showHelp:   true,
		inflight:   1,
		refreshing: true,
		backoff:        map[string]time.Time{},
		refreshBackoff: map[string]time.Time{},
		prevUtil:       map[string]float64{},
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(
		m.refreshCmd(m.inflight),
		tickCmd(config.RefreshIntervalSeconds),
		secondTickCmd(),
		updateCheckCmd(m.version),
	)
}

// Run starts the bubbletea program with an alt-screen and returns
// once the user quits. The bool return signals that an in-app
// upgrade happened and main should re-exec the (now-replaced) binary
// to drop the user back into the new version's dashboard. cfg is
// passed by value because the TUI owns its own copy after launch
// (toggles persist via config.Save without touching the caller's
// instance).
func Run(root string, cfg config.Config, version, webURL string) (restart bool, err error) {
	p := tea.NewProgram(initialModel(root, cfg, version, webURL), tea.WithAltScreen())
	final, err := p.Run()
	if err != nil {
		return false, err
	}
	if mm, ok := final.(model); ok && mm.upgradeRestart {
		return true, nil
	}
	return false, nil
}
