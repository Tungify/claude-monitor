package swap

import (
	"errors"
	"testing"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/api"
	"claude-monitor/internal/config"
)

// row is a tiny helper to build account.Row values inline. We only need
// the fields decideSwap looks at.
func row(name, dir string, util float64, refresh string) account.Row {
	r := account.Row{Name: name, ConfigDir: dir, RefreshToken: refresh}
	r.Usage = &api.Usage{FiveHour: &api.Window{Utilization: util}}
	return r
}

func defaultCfg() config.Config {
	c := config.Config{
		AutoSwap:         true,
		SwapThresholds:   []float64{90, 99, 100},
		PickOrder:        config.PickOrderLowest,
		RebalanceOnReset: true,
	}
	return c
}

func TestDecideSwapNoSwapBelowFirstThreshold(t *testing.T) {
	rows := []account.Row{
		row("a", "/a", 50, "ra"),
		row("b", "/b", 10, "rb"),
	}
	got, _ := decideSwap(rows, "/a", nil, "", 0, defaultCfg())
	if got != nil {
		t.Errorf("expected nil swap (active < first tier), got %+v", got)
	}
}

func TestDecideSwapFiresAtFirstThreshold(t *testing.T) {
	rows := []account.Row{
		row("a", "/a", 91, "ra"),
		row("b", "/b", 10, "rb"),
	}
	got, reason := decideSwap(rows, "/a", nil, "", 0, defaultCfg())
	if got == nil {
		t.Fatal("expected swap to fire at 91%, got nil")
	}
	if got.Name != "b" {
		t.Errorf("target = %q, want b", got.Name)
	}
	if reason == "" {
		t.Error("expected non-empty reason")
	}
}

func TestDecideSwapEscalatesWhenNoCandidateBelowFirstTier(t *testing.T) {
	// active at 99.5% (above the first AND second tiers), candidates
	// all >= 90 so first tier yields no eligible. Second tier (99)
	// finds one below it and the swap fires.
	//
	// The cascade stops *down* (not up): once active.util < tier we
	// return nil. So escalation only happens if active is also above
	// the next tier — which is the realistic "active is maxed out
	// across multiple tiers, find me anyone fresher" case.
	rows := []account.Row{
		row("a", "/a", 99.5, "ra"),
		row("b", "/b", 92, "rb"),  // < 99 → eligible at tier 2
		row("c", "/c", 99, "rc"),  // exactly 99 → not < 99 → not eligible
	}
	got, _ := decideSwap(rows, "/a", nil, "", 0, defaultCfg())
	if got == nil {
		t.Fatal("expected escalation to second tier, got nil")
	}
	if got.Name != "b" {
		t.Errorf("target = %q, want b (only one < 99)", got.Name)
	}
}

// TestDecideSwapStopsAtFirstTierWhenActiveBelowNextTier verifies the
// commented-but-easy-to-miss invariant: once active.util < tier and no
// eligible candidate existed below the previous tier, decideSwap stops.
// It does NOT keep escalating into tiers the active account hasn't even
// crossed yet.
func TestDecideSwapStopsAtFirstTierWhenActiveBelowNextTier(t *testing.T) {
	rows := []account.Row{
		row("a", "/a", 95, "ra"),
		row("b", "/b", 92, "rb"),
		row("c", "/c", 99, "rc"),
	}
	got, _ := decideSwap(rows, "/a", nil, "", 0, defaultCfg())
	if got != nil {
		t.Errorf("expected nil (active 95 < tier 99 stops the cascade), got %+v", got)
	}
}

func TestDecideSwapNoSwapWhenAllMaxed(t *testing.T) {
	rows := []account.Row{
		row("a", "/a", 100, "ra"),
		row("b", "/b", 100, "rb"),
		row("c", "/c", 100, "rc"),
	}
	got, _ := decideSwap(rows, "/a", nil, "", 0, defaultCfg())
	if got != nil {
		t.Errorf("expected nil swap (all maxed), got %+v", got)
	}
}

func TestDecideSwapPickOrderLowest(t *testing.T) {
	cfg := defaultCfg()
	cfg.PickOrder = config.PickOrderLowest

	rows := []account.Row{
		row("a", "/a", 95, "ra"),
		row("low", "/low", 5, "rl"),
		row("mid", "/mid", 50, "rm"),
	}
	got, _ := decideSwap(rows, "/a", nil, "", 0, cfg)
	if got == nil {
		t.Fatal("expected swap, got nil")
	}
	if got.Name != "low" {
		t.Errorf("PickOrderLowest target = %q, want low", got.Name)
	}
}

func TestDecideSwapPickOrderHighest(t *testing.T) {
	cfg := defaultCfg()
	cfg.PickOrder = config.PickOrderHighest

	rows := []account.Row{
		row("a", "/a", 95, "ra"),
		row("low", "/low", 5, "rl"),
		row("mid", "/mid", 50, "rm"),
	}
	got, _ := decideSwap(rows, "/a", nil, "", 0, cfg)
	if got == nil {
		t.Fatal("expected swap, got nil")
	}
	if got.Name != "mid" {
		t.Errorf("PickOrderHighest target = %q, want mid (highest util below tier)", got.Name)
	}
}

func TestDecideSwapSkipsCandidatesWithoutRefreshToken(t *testing.T) {
	rows := []account.Row{
		row("a", "/a", 95, "ra"),
		row("b", "/b", 10, ""), // no refresh token → not a swap target
		row("c", "/c", 50, "rc"),
	}
	got, _ := decideSwap(rows, "/a", nil, "", 0, defaultCfg())
	if got == nil {
		t.Fatal("expected swap, got nil")
	}
	if got.Name != "c" {
		t.Errorf("target = %q, want c (b has no refresh token)", got.Name)
	}
}

func TestDecideSwapSkipsCandidatesWithError(t *testing.T) {
	errored := row("b", "/b", 10, "rb")
	errored.Err = errors.New("rate limited")
	errored.Usage = nil // mimic real error path
	rows := []account.Row{
		row("a", "/a", 95, "ra"),
		errored,
		row("c", "/c", 50, "rc"),
	}
	got, _ := decideSwap(rows, "/a", nil, "", 0, defaultCfg())
	if got == nil {
		t.Fatal("expected swap, got nil")
	}
	if got.Name != "c" {
		t.Errorf("target = %q, want c (b errored)", got.Name)
	}
}

func TestDecideSwapNoActiveReturnsNil(t *testing.T) {
	rows := []account.Row{
		row("a", "/a", 95, "ra"),
		row("b", "/b", 10, "rb"),
	}
	// activeDir doesn't match any row.
	got, _ := decideSwap(rows, "/missing", nil, "", 0, defaultCfg())
	if got != nil {
		t.Errorf("expected nil when active not found, got %+v", got)
	}
}

func TestDecideSwapActiveErroredReturnsNil(t *testing.T) {
	active := row("a", "/a", 95, "ra")
	active.Err = errors.New("transient")
	active.Usage = nil
	rows := []account.Row{active, row("b", "/b", 10, "rb")}
	got, _ := decideSwap(rows, "/a", nil, "", 0, defaultCfg())
	if got != nil {
		t.Errorf("expected nil when active is errored, got %+v", got)
	}
}

func TestDecideSwapNoCandidatesReturnsNil(t *testing.T) {
	// Single-account dashboard.
	rows := []account.Row{row("a", "/a", 95, "ra")}
	got, _ := decideSwap(rows, "/a", nil, "", 0, defaultCfg())
	if got != nil {
		t.Errorf("expected nil with no candidates, got %+v", got)
	}
}

func TestDecideSwapRebalanceOnReset(t *testing.T) {
	cfg := defaultCfg()
	cfg.RebalanceOnReset = true
	// Active well below threshold; one candidate just transitioned 60→0.
	rows := []account.Row{
		row("a", "/a", 30, "ra"),
		row("b", "/b", 0, "rb"), // freshly reset
		row("c", "/c", 40, "rc"),
	}
	prev := map[string]float64{"/b": 60, "/c": 40}
	got, reason := decideSwap(rows, "/a", prev, "", 0, cfg)
	if got == nil {
		t.Fatal("expected rebalance-on-reset swap, got nil")
	}
	if got.Name != "b" {
		t.Errorf("target = %q, want b (just reset)", got.Name)
	}
	if reason == "" {
		t.Error("expected non-empty reason for reset rebalance")
	}
}

func TestDecideSwapRebalanceOnResetIgnoredWhenDisabled(t *testing.T) {
	cfg := defaultCfg()
	cfg.RebalanceOnReset = false
	rows := []account.Row{
		row("a", "/a", 30, "ra"),
		row("b", "/b", 0, "rb"),
	}
	prev := map[string]float64{"/b": 60}
	got, _ := decideSwap(rows, "/a", prev, "", 0, cfg)
	if got != nil {
		t.Errorf("rebalance fired despite cfg disable: %+v", got)
	}
}

func TestDecideSwapRebalanceNeedsThreshold(t *testing.T) {
	cfg := defaultCfg()
	// Candidate dropped from 4 to 0 — below the >=5 prev threshold,
	// shouldn't count as a real reset.
	rows := []account.Row{
		row("a", "/a", 30, "ra"),
		row("b", "/b", 0, "rb"),
	}
	prev := map[string]float64{"/b": 4}
	got, _ := decideSwap(rows, "/a", prev, "", 0, cfg)
	if got != nil {
		t.Errorf("rebalance fired on small drop: %+v", got)
	}
}

func TestDecideSwapRebalanceNoFireOnPositiveCurrent(t *testing.T) {
	cfg := defaultCfg()
	rows := []account.Row{
		row("a", "/a", 30, "ra"),
		row("b", "/b", 1.5, "rb"), // current >= 1, not "fresh"
	}
	prev := map[string]float64{"/b": 60}
	got, _ := decideSwap(rows, "/a", prev, "", 0, cfg)
	if got != nil {
		t.Errorf("rebalance fired on cur=1.5 (>=1): %+v", got)
	}
}

func TestDecideSwapStickyManualPinSkipsLowerTiers(t *testing.T) {
	// User pinned at 52% with thresholds [50, 80, 100]. While the active
	// row matches the manual pick, tier 50 is skipped (active was already
	// past it at pin time). Tier 80 still fires.
	cfg := defaultCfg()
	cfg.SwapThresholds = []float64{50, 80, 100}

	// Active = pinned account at 60% (above 50, below 80) → no swap.
	rows := []account.Row{
		row("pin", "/pin", 60, "rpin"),
		row("low", "/low", 5, "rlow"),
	}
	got, _ := decideSwap(rows, "/pin", nil, "/pin", 52, cfg)
	if got != nil {
		t.Errorf("manual pin should suppress tier <= pinUtil, got swap to %+v", got)
	}

	// Active = pinned account at 85% (above 80) → swap fires.
	rows[0] = row("pin", "/pin", 85, "rpin")
	got, _ = decideSwap(rows, "/pin", nil, "/pin", 52, cfg)
	if got == nil || got.Name != "low" {
		t.Errorf("manual pin should still allow tier > pinUtil to fire, got %+v", got)
	}
}

func TestDecideSwapStickyManualPinSuppressesRebalance(t *testing.T) {
	cfg := defaultCfg()
	rows := []account.Row{
		row("pin", "/pin", 30, "rp"),
		row("b", "/b", 0, "rb"), // freshly reset
	}
	prev := map[string]float64{"/b": 60}

	// With manual pin → rebalance suppressed.
	got, _ := decideSwap(rows, "/pin", prev, "/pin", 30, cfg)
	if got != nil {
		t.Errorf("manual pin should suppress rebalance-on-reset, got %+v", got)
	}

	// Without manual pin → rebalance fires.
	got, _ = decideSwap(rows, "/pin", prev, "", 0, cfg)
	if got == nil {
		t.Error("rebalance should fire without manual pin")
	}
}

func TestDecideSwapManualPinNoLongerActiveDoesNotApply(t *testing.T) {
	// Pin was set on /pin but auto-swap moved active to /a. The pin is
	// no longer the active account, so its threshold-skipping logic
	// doesn't apply.
	cfg := defaultCfg()
	cfg.SwapThresholds = []float64{50, 80, 100}

	rows := []account.Row{
		row("a", "/a", 60, "ra"), // currently active, above 50
		row("low", "/low", 5, "rlow"),
		row("pin", "/pin", 70, "rpin"),
	}
	// manualPickDir=/pin but active=/a → not "stickyManual". So tier 50
	// applies normally and a swap fires.
	got, _ := decideSwap(rows, "/a", nil, "/pin", 52, cfg)
	if got == nil {
		t.Fatal("expected swap when pin is no longer active")
	}
	if got.Name != "low" {
		t.Errorf("target = %q, want low", got.Name)
	}
}

// TestDecideSwapActiveUsageRateLimitedRotates covers the scenario the
// user actually hit in production: active account is the busy one,
// gets 429 on /api/oauth/usage, dashboard can't read its util. Without
// this branch, decideSwap saw active.Err != nil and bailed — leaving
// the user pinned to a throttled account until they swapped manually.
// Now we treat the 429 itself as the "active is maxed" signal and
// rotate to any healthy candidate.
func TestDecideSwapActiveUsageRateLimitedRotates(t *testing.T) {
	active := account.Row{Name: "a", ConfigDir: "/a", RefreshToken: "ra"}
	active.Err = &api.RateLimitError{RetryAfter: 60 * time.Second, Source: "usage"}
	// Usage is nil — that's the whole point.
	rows := []account.Row{
		active,
		row("b", "/b", 10, "rb"),
		row("c", "/c", 50, "rc"),
	}
	got, reason := decideSwap(rows, "/a", nil, "", 0, defaultCfg())
	if got == nil {
		t.Fatal("expected swap when active is usage-rate-limited, got nil")
	}
	if got.Name != "b" {
		t.Errorf("target = %q, want b (lowest util candidate)", got.Name)
	}
	if reason == "" {
		t.Error("expected non-empty reason")
	}
}

// TestDecideSwapActiveRefreshRateLimitDoesNotRotate guards the "only
// usage-source" carve-out: a refresh 429 doesn't mean the token is
// dead, it means our refresh attempt got throttled. The keychain may
// still hold a perfectly fine token (Claude Code or another tab may
// have refreshed it for us). Falling through to the regular cascade
// is the right behavior — and since active.Err != nil and Usage is
// nil, that cascade returns nil, so we sit tight.
func TestDecideSwapActiveRefreshRateLimitDoesNotRotate(t *testing.T) {
	active := account.Row{Name: "a", ConfigDir: "/a", RefreshToken: "ra"}
	active.Err = &api.RateLimitError{RetryAfter: 60 * time.Second, Source: "refresh"}
	rows := []account.Row{
		active,
		row("b", "/b", 10, "rb"),
	}
	got, _ := decideSwap(rows, "/a", nil, "", 0, defaultCfg())
	if got != nil {
		t.Errorf("expected nil for refresh-source 429 (keychain may have fresh token), got %+v", got)
	}
}

// TestDecideSwapActiveUsageRateLimitedNoHealthyCandidates: active is
// 429'd, every candidate is also 429'd. There's nothing to rotate
// to, so we hold position and wait for one of them to recover.
func TestDecideSwapActiveUsageRateLimitedNoHealthyCandidates(t *testing.T) {
	active := account.Row{Name: "a", ConfigDir: "/a", RefreshToken: "ra"}
	active.Err = &api.RateLimitError{RetryAfter: 60 * time.Second, Source: "usage"}

	bad := account.Row{Name: "b", ConfigDir: "/b", RefreshToken: "rb"}
	bad.Err = &api.RateLimitError{RetryAfter: 60 * time.Second, Source: "usage"}

	rows := []account.Row{active, bad}
	got, _ := decideSwap(rows, "/a", nil, "", 0, defaultCfg())
	if got != nil {
		t.Errorf("expected nil when no healthy candidate exists, got %+v", got)
	}
}

// TestDecideSwapActiveUsageRateLimitedRespectsManualPin verifies the
// manual pin (the user's deliberate "hold this account") wins over the
// rate-limit-rotation heuristic. Otherwise pinning a high-traffic
// account would auto-revert the moment Anthropic 429s a usage call.
func TestDecideSwapActiveUsageRateLimitedRespectsManualPin(t *testing.T) {
	active := account.Row{Name: "a", ConfigDir: "/a", RefreshToken: "ra"}
	active.Err = &api.RateLimitError{RetryAfter: 60 * time.Second, Source: "usage"}
	rows := []account.Row{
		active,
		row("b", "/b", 10, "rb"),
	}
	// User pinned /a explicitly.
	got, _ := decideSwap(rows, "/a", nil, "/a", 50, defaultCfg())
	if got != nil {
		t.Errorf("expected nil when active is the manual pin, got %+v", got)
	}
}

func TestPickTargetEmpty(t *testing.T) {
	if got := pickTarget(nil, config.PickOrderLowest); got != nil {
		t.Errorf("pickTarget(nil) = %+v, want nil", got)
	}
}

func TestPickTargetSingleCandidate(t *testing.T) {
	r := row("a", "/a", 50, "ra")
	got := pickTarget([]*account.Row{&r}, config.PickOrderLowest)
	if got == nil || got.Name != "a" {
		t.Errorf("pickTarget single = %+v, want a", got)
	}
}
