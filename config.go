package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Config is persisted to ~/.claude-monitor/config.json so that toggles set
// in the TUI (auto-kick, refresh interval, color) survive restarts.
type Config struct {
	AutoKick        bool `json:"autoKick"`
	IntervalSeconds int  `json:"intervalSeconds"`
	Color           bool `json:"color"`
}

// IntervalChoices is the set of refresh intervals the +/- hotkeys cycle
// through. Min is 60s on purpose — /api/oauth/usage is undocumented and
// hammering it would invite rate-limiting.
var IntervalChoices = []int{60, 120, 300, 600}

func defaultConfig() Config {
	return Config{
		AutoKick:        false,
		IntervalSeconds: 60,
		Color:           true,
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
	cfg.IntervalSeconds = clampInterval(cfg.IntervalSeconds)
	return cfg, nil
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

// clampInterval snaps an arbitrary value to the nearest allowed choice
// (defensive against hand-edited config files).
func clampInterval(v int) int {
	if v < IntervalChoices[0] {
		return IntervalChoices[0]
	}
	for _, c := range IntervalChoices {
		if v == c {
			return v
		}
	}
	// Pick the closest choice.
	best := IntervalChoices[0]
	bestDiff := abs(v - best)
	for _, c := range IntervalChoices[1:] {
		if d := abs(v - c); d < bestDiff {
			best, bestDiff = c, d
		}
	}
	return best
}

// stepInterval returns the next interval in IntervalChoices, dir > 0 for
// "longer", dir < 0 for "shorter". Saturates at the ends.
func stepInterval(cur, dir int) int {
	for i, c := range IntervalChoices {
		if c == cur {
			j := i + dir
			if j < 0 {
				j = 0
			}
			if j >= len(IntervalChoices) {
				j = len(IntervalChoices) - 1
			}
			return IntervalChoices[j]
		}
	}
	return clampInterval(cur)
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
