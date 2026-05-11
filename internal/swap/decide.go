package swap

import (
	"errors"
	"fmt"
	"sort"

	"claude-monitor/internal/account"
	"claude-monitor/internal/api"
	"claude-monitor/internal/config"
)

// decideSwap picks the swap target for the given snapshot, or returns
// nil when no swap should happen. Logic:
//
//  1. Threshold cascade. For each tier t in ascending order:
//     - if active.effective < t and there is no eligible candidate at
//       the lower tiers, stop — let the active account keep burning.
//     - if active.effective >= t and there is at least one candidate
//       below t, pick the best per cfg.PickOrder and return it.
//     - if active.effective >= t but no candidate < t, escalate to the
//       next tier.
//
//     "effective util" is max(5h, weekly) per account — so an account
//     whose 5h sits at 1% but whose weekly is at 99% is treated as
//     exhausted, because the next 5h reset won't refresh its weekly
//     budget and the next API call may 429.
//
//  2. Reset rebalance. If RebalanceOnReset is on and any non-active
//     account just transitioned from positive 5h util to ~0 since the
//     last refresh, swap to that fresh account regardless of the
//     threshold. This keeps load spread across accounts as their 5h
//     windows reset (weekly resets are too rare and too costly to
//     detect reliably across long restarts — they fall out via the
//     cascade instead). Suppressed while the active account matches
//     manualPickDir — once the user has manually pinned an account,
//     only the threshold cascade is allowed to move off it.
//
// prevUtil maps configDir → previous-tick 5h util, used only for the
// reset detection. Pass nil on the first refresh.
//
// manualPickDir is the configDir of the user's most recent manual pick
// (empty when none). manualPickUtil is the effective utilization
// (max of 5h + weekly) of that account at the moment the user pinned
// it. While the active account matches manualPickDir, two relaxations
// apply:
//
//   - rebalance-on-reset is suppressed entirely.
//   - threshold cascade skips any tier <= manualPickUtil — i.e. the
//     pin "consumes" thresholds the picked account had already
//     crossed at pin time, so a deliberate pick at 52% with thresholds
//     [50, 80, 100] sticks until 80 (not 50, which would fire on the
//     very next tick).
func decideSwap(rows []account.Row, activeDir string, prevUtil map[string]float64, manualPickDir string, manualPickUtil float64, cfg config.Config) (*account.Row, string) {
	var active *account.Row
	candidates := make([]*account.Row, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		if r.ConfigDir == activeDir {
			active = r
			continue
		}
		if r.Err != nil || r.Usage == nil || r.RefreshToken == "" {
			continue
		}
		candidates = append(candidates, r)
	}
	if active == nil {
		return nil, ""
	}
	// Active is fetch-usage rate-limited: we can't read its util, but
	// the 429 itself is the strongest "this account is the busy one"
	// signal there is — Anthropic only throttles tokens that are being
	// hammered by `claude`. Rotate to any healthy candidate so the
	// next request hits a fresh token. We deliberately skip the
	// threshold cascade (no util to compare) and the rebalance-on-reset
	// path (no prev-util reliable here either).
	//
	// The refresh-source 429 path is intentionally NOT caught here:
	// the token itself isn't dead, just our refresh attempt got
	// limited; the existing tokens in the keychain may still be fresh
	// (Claude Code or another tab may have refreshed them already).
	// Falling through to the regular cascade keeps that behavior.
	if rl := rateLimitErr(active.Err); rl != nil && rl.Source != "refresh" {
		if len(candidates) == 0 {
			return nil, ""
		}
		// Don't auto-rotate off a manually pinned active even when
		// it's rate-limited — that's the user explicitly saying
		// "hold this one regardless." They can [m] off it themselves.
		if manualPickDir != "" && active.ConfigDir == manualPickDir {
			return nil, ""
		}
		target := pickTarget(candidates, cfg.PickOrder)
		if target == nil {
			return nil, ""
		}
		return target, "active rate limited"
	}
	if active.Err != nil || active.Usage == nil {
		return nil, ""
	}
	if len(candidates) == 0 {
		return nil, ""
	}

	stickyManual := manualPickDir != "" && active.ConfigDir == manualPickDir
	if cfg.RebalanceOnReset && len(prevUtil) > 0 && !stickyManual {
		for _, c := range candidates {
			cur := account.FiveHourUtil(c.Usage)
			prev, hadPrev := prevUtil[c.ConfigDir]
			if !hadPrev || prev < 5 || cur >= 1 {
				continue
			}
			// 5h reset doesn't help if the candidate's weekly is also
			// near-exhausted — we'd just swap onto an account that
			// 429s on its weekly limit a few requests later. Require
			// weekly headroom below the first threshold tier too.
			if len(cfg.SwapThresholds) > 0 &&
				account.WeeklyUtil(c.Usage) >= cfg.SwapThresholds[0] {
				continue
			}
			return c, fmt.Sprintf("%s window reset", c.Name)
		}
	}

	activeUtil := account.EffectiveUtil(active.Usage)
	for _, t := range cfg.SwapThresholds {
		// While the user's manual pin is still in effect, skip any
		// threshold the picked account had already exceeded at pin
		// time. Without this, picking a 52% account with thresholds
		// [50, 80, 100] would auto-revert on the very next tick (52
		// >= 50, candidate < 50 found, swap fires).
		if stickyManual && t <= manualPickUtil {
			continue
		}
		if activeUtil < t {
			return nil, ""
		}
		eligible := candidates[:0:0]
		for _, c := range candidates {
			if account.EffectiveUtil(c.Usage) < t {
				eligible = append(eligible, c)
			}
		}
		if len(eligible) == 0 {
			continue
		}
		target := pickTarget(eligible, cfg.PickOrder)
		if target == nil {
			continue
		}
		// Surface which window drove the swap so log lines stay
		// diagnosable when a "5h is fine but weekly is dead" rotation
		// fires.
		window := "5h"
		if account.WeeklyUtil(active.Usage) >= account.FiveHourUtil(active.Usage) &&
			account.WeeklyUtil(active.Usage) >= t {
			window = "weekly"
		}
		reason := fmt.Sprintf("active hit %.0f%% (%s)", activeUtil, window)
		return target, reason
	}
	return nil, ""
}

// rateLimitErr unwraps a row's Err into a *api.RateLimitError when
// applicable, else nil. Centralizing this keeps decideSwap from
// caring whether the rate-limit error is the bare value or wrapped
// (fmt.Errorf with %w would still unwrap correctly).
func rateLimitErr(err error) *api.RateLimitError {
	if err == nil {
		return nil
	}
	var rl *api.RateLimitError
	if errors.As(err, &rl) {
		return rl
	}
	return nil
}

func pickTarget(eligible []*account.Row, order string) *account.Row {
	if len(eligible) == 0 {
		return nil
	}
	sorted := append([]*account.Row(nil), eligible...)
	sort.SliceStable(sorted, func(i, j int) bool {
		ui := account.EffectiveUtil(sorted[i].Usage)
		uj := account.EffectiveUtil(sorted[j].Usage)
		if order == config.PickOrderHighest {
			return ui > uj
		}
		return ui < uj
	})
	return sorted[0]
}
