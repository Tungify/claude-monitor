package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Config is persisted to ~/.claude-monitor/config.json so that toggles set
// in the TUI (auto-kick, auto-swap, swap thresholds, …) survive restarts.
//
// Refresh interval is hardcoded to 60s and color rendering is always on
// — both used to be user-configurable but the toggles weren't earning
// their keep, so the surface area shrank to the things the user
// actually wants to tweak (the auto-swap behavior).
type Config struct {
	AutoKick bool `json:"autoKick"`

	// Auto-swap rotates the OAuth token in the default keychain slot
	// ("Claude Code-credentials") among the discovered accounts so a
	// running plain `claude` tab transparently picks up a fresh quota
	// when the active account is near its 5h limit.
	AutoSwap bool `json:"autoSwap"`

	// SwapThresholds is an ascending cascade of 5h utilization tiers.
	// Default [90, 99, 100]: try to swap when the active account hits
	// 90% to a candidate below 90; if no candidate exists, wait until
	// 99% and retry against candidates < 99; finally 100% / < 100.
	SwapThresholds []float64 `json:"swapThresholds"`

	// PickOrder controls how a swap target is chosen among eligible
	// candidates. "lowest" prefers the freshest account (default,
	// spreads load); "highest" drains accounts one at a time.
	PickOrder string `json:"pickOrder"`

	// RebalanceOnReset, when true, swaps to any non-active account
	// whose 5h window just reset (util went from positive to ~0
	// between refreshes). Independent of the threshold cascade —
	// fires even when active is well below 90%.
	RebalanceOnReset bool `json:"rebalanceOnReset"`

	// KeychainSetupDone is set after the macOS one-shot bootstrap
	// (RunKeychainSetup) has registered the `security` CLI in each
	// Claude Code keychain entry's partition list. Until it's true
	// we prompt the user once on launch to enter their macOS
	// password so future swaps stay silent. Always true on
	// non-darwin platforms (no partition list there).
	KeychainSetupDone bool `json:"keychainSetupDone"`
}

const (
	PickOrderLowest  = "lowest"
	PickOrderHighest = "highest"
)

// RefreshIntervalSeconds is the fixed cadence at which the dashboard
// re-fetches /api/oauth/usage. Hardcoded because the API is undocumented
// and 60s was the safe lower bound we settled on against rate-limiting.
const RefreshIntervalSeconds = 60

func defaultConfig() Config {
	return Config{
		AutoKick:         false,
		AutoSwap:         false,
		SwapThresholds:   []float64{90, 99, 100},
		PickOrder:        PickOrderLowest,
		RebalanceOnReset: true,
	}
}

func configPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude-monitor", "config.json"), nil
}

func LoadConfig() (Config, error) {
	cfg := defaultConfig()
	path, err := configPath()
	if err != nil {
		return cfg, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	// Decode on top of defaults so that newly-added fields keep sensible
	// values when reading an old file.
	if err := json.Unmarshal(b, &cfg); err != nil {
		return defaultConfig(), err
	}
	cfg.SwapThresholds = sanitizeThresholds(cfg.SwapThresholds)
	cfg.PickOrder = sanitizePickOrder(cfg.PickOrder)
	return cfg, nil
}

// sanitizeThresholds clamps each value to [0, 100], drops duplicates and
// sorts ascending. An empty list falls back to the default cascade so the
// swap logic always has at least one tier to evaluate.
func sanitizeThresholds(in []float64) []float64 {
	if len(in) == 0 {
		return []float64{90, 99, 100}
	}
	seen := map[float64]struct{}{}
	out := make([]float64, 0, len(in))
	for _, v := range in {
		if v < 0 {
			v = 0
		}
		if v > 100 {
			v = 100
		}
		if _, dup := seen[v]; dup {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1] > out[j]; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

func sanitizePickOrder(s string) string {
	switch s {
	case PickOrderLowest, PickOrderHighest:
		return s
	default:
		return PickOrderLowest
	}
}

func SaveConfig(cfg Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

