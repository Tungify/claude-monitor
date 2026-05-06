package tui

import (
	"context"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"claude-monitor/internal/account"
	"claude-monitor/internal/swap"
	"claude-monitor/internal/update"
)

// refreshCmd kicks a swap.FetchAll in a goroutine and reports the
// result back as a refreshMsg. We snapshot the backoff and prev-util
// maps so the goroutine has a stable view, even if the user presses
// 'R' (which mutates m.backoff) or another tick fires while in
// flight.
func (m *model) refreshCmd(version uint64) tea.Cmd {
	root := m.root
	cfg := m.cfg
	manualPick := m.manualPickDir
	manualPickUtil := m.manualPickUtil
	skipUntil := make(map[string]time.Time, len(m.backoff))
	for k, v := range m.backoff {
		skipUntil[k] = v
	}
	prev := make(map[string]float64, len(m.prevUtil))
	for k, v := range m.prevUtil {
		prev[k] = v
	}
	return func() tea.Msg {
		// Auto-swap involves keychain writes (~hundreds of ms each), so
		// give a more generous deadline when swapping is enabled.
		deadline := 30 * time.Second
		if cfg.AutoSwap {
			deadline = 60 * time.Second
		}
		ctx, cancel := context.WithTimeout(context.Background(), deadline)
		defer cancel()
		res, err := swap.FetchAll(ctx, root, cfg, skipUntil, prev, manualPick, manualPickUtil)
		msg := refreshMsg{err: err, at: time.Now(), version: version}
		if res != nil {
			msg.rows = res.Rows
			msg.activeDir = res.ActiveDir
			msg.swap = res.Swap
			msg.swapErr = res.SwapErr
		}
		return msg
	}
}

// manualSwapCmd runs swap.Execute off the UI goroutine. We snapshot
// the rows + activeDir so the keychain writes don't race with
// concurrent refreshes mutating m.rows.
func (m *model) manualSwapCmd(target account.Row) tea.Cmd {
	rows := append([]account.Row(nil), m.rows...)
	activeDir := m.activeDir
	fromTag := "?"
	if active := account.FindRow(rows, activeDir); active != nil {
		fromTag = account.Label(*active)
	}
	targetTag := account.Label(target)
	targetUtil := account.FiveHourUtil(target.Usage)
	return func() tea.Msg {
		err := swap.Execute(rows, activeDir, target.ConfigDir)
		return manualSwapDoneMsg{
			targetDir:  target.ConfigDir,
			targetTag:  targetTag,
			fromTag:    fromTag,
			targetUtil: targetUtil,
			err:        err,
		}
	}
}

func tickCmd(secs int) tea.Cmd {
	return tea.Tick(time.Duration(secs)*time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func secondTickCmd() tea.Cmd {
	return tea.Tick(time.Second, func(time.Time) tea.Msg {
		return secondTickMsg{}
	})
}

func flashClearCmd(d time.Duration) tea.Cmd {
	return tea.Tick(d, func(time.Time) tea.Msg { return flashClearMsg{} })
}

func updateCheckCmd(currentVersion string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		info, _ := update.Check(ctx, currentVersion)
		return updateCheckMsg{info: info}
	}
}

func upgradeCmd(info *update.Info) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
		defer cancel()
		err := update.Perform(ctx, info)
		return upgradeDoneMsg{tag: info.LatestTag, err: err}
	}
}

