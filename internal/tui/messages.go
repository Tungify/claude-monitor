package tui

import (
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/swap"
	"claude-monitor/internal/update"
)

// tickMsg fires every config.RefreshIntervalSeconds and triggers a
// refresh.
type tickMsg time.Time

// secondTickMsg fires once per second to drive live countdowns
// ("refreshed 12s ago", "rate limited (retry in 4m23s)") that aren't
// tied to the slower refresh cadence.
type secondTickMsg struct{}

// refreshMsg carries the result of a swap.FetchAll call back into the
// model. The version field matches the inflight counter at the time
// the refresh was launched so that stale results from a superseded
// refresh can be dropped silently.
type refreshMsg struct {
	rows           []account.Row
	activeDir      string
	codexActiveDir string
	swap           *swap.Event
	swapErr        error
	err            error
	at             time.Time
	version        uint64
}

// flashClearMsg clears a transient status banner (used for "config
// saved", "kick toggled", etc).
type flashClearMsg struct{}

// updateCheckMsg carries the result of the background GitHub-Releases
// check that fires once on Init. info==nil means "no update available
// or the check failed silently"; either way the banner stays hidden.
type updateCheckMsg struct {
	info *update.Info
}

// upgradeDoneMsg is the result of a [u]-triggered self-replace.
type upgradeDoneMsg struct {
	tag string
	err error
}

// upgradeQuitMsg fires a few seconds after a successful upgrade so the
// user has time to read "✓ upgraded" before the TUI tears down.
type upgradeQuitMsg struct{}

// loginDoneMsg is delivered after a tea.ExecProcess running `claude
// auth login` (with CLAUDE_CONFIG_DIR set) returns. Always followed by
// a fresh refresh tick so the new/relogged-in account picks up its
// usage row immediately. label is the short name we showed in the
// "logging in: <name>…" flash; the done flash reuses it.
//
// fresh is true when this came from the [a] add flow (so the success
// message reads "added"), false from [L] relogin ("relogin").
type loginDoneMsg struct {
	configDir string
	label     string
	fresh     bool
	err       error
}

// manualSwapDoneMsg is the result of a [m]-triggered keychain rewrite.
// targetDir identifies the account the user picked; targetUtil is the
// effective utilization (max of 5h and weekly) of that account at the
// moment of pin (used by decideSwap to decide which threshold tiers to
// skip while the pin is in effect). err is non-nil when the keychain
// write failed (in which case the active account is unchanged and a
// flash banner reports the error).
type manualSwapDoneMsg struct {
	targetDir  string
	targetTag  string
	fromTag    string
	targetUtil float64
	err        error
}
