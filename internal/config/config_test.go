package config

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

func TestSanitizeThresholds(t *testing.T) {
	tests := []struct {
		name string
		in   []float64
		want []float64
	}{
		{"empty falls back to default cascade", nil, []float64{90, 99, 100}},
		{"empty slice falls back too", []float64{}, []float64{90, 99, 100}},
		{"clamps below zero", []float64{-10, 50}, []float64{0, 50}},
		{"clamps above 100", []float64{50, 150}, []float64{50, 100}},
		{"both clamps", []float64{-1, 200}, []float64{0, 100}},
		{"dedupes exact matches", []float64{50, 50, 80}, []float64{50, 80}},
		{"dedupes after clamp", []float64{-1, 0, 200, 100}, []float64{0, 100}},
		{"sorts ascending", []float64{99, 50, 80}, []float64{50, 80, 99}},
		{"keeps fractional thresholds", []float64{75.5, 25.25}, []float64{25.25, 75.5}},
		{"single value", []float64{42}, []float64{42}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SanitizeThresholds(tt.in)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("SanitizeThresholds(%v) = %v, want %v", tt.in, got, tt.want)
			}
			// Always ascending after sanitize.
			if !sort.Float64sAreSorted(got) {
				t.Errorf("output not sorted ascending: %v", got)
			}
		})
	}
}

func TestSanitizePickOrder(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{PickOrderLowest, PickOrderLowest},
		{PickOrderHighest, PickOrderHighest},
		{"", PickOrderLowest},
		{"random", PickOrderLowest},
		{"LOWEST", PickOrderLowest}, // case-sensitive: unknown → default
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := sanitizePickOrder(tt.in); got != tt.want {
				t.Errorf("sanitizePickOrder(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestDefaults(t *testing.T) {
	d := defaults()
	if d.AutoKick {
		t.Error("AutoKick default should be false")
	}
	if d.AutoSwap {
		t.Error("AutoSwap default should be false")
	}
	if !d.RebalanceOnReset {
		t.Error("RebalanceOnReset default should be true")
	}
	if d.PickOrder != PickOrderLowest {
		t.Errorf("PickOrder default = %q, want %q", d.PickOrder, PickOrderLowest)
	}
	if !reflect.DeepEqual(d.SwapThresholds, []float64{90, 99, 100}) {
		t.Errorf("SwapThresholds default = %v, want [90 99 100]", d.SwapThresholds)
	}
}

// TestLoadSaveRoundTrip writes a config to a temp HOME, reads it back, and
// verifies every field round-trips. Uses t.Setenv("HOME", ...) so we don't
// touch the real ~/.claude-monitor.
func TestLoadSaveRoundTrip(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	cfg := Config{
		AutoKick:          true,
		AutoSwap:          true,
		SwapThresholds:    []float64{50, 80, 100},
		PickOrder:         PickOrderHighest,
		RebalanceOnReset:  false,
		KeychainSetupDone: true,
	}
	if err := Save(cfg); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// File should exist at $HOME/.claude-monitor/config.json.
	wantPath := filepath.Join(tmp, ".claude-monitor", "config.json")
	if _, err := os.Stat(wantPath); err != nil {
		t.Fatalf("config file missing at %s: %v", wantPath, err)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !reflect.DeepEqual(got, cfg) {
		t.Errorf("round-trip mismatch:\n  saved: %+v\n  loaded: %+v", cfg, got)
	}
}

// TestLoadMissingReturnsDefaults: when the config file doesn't exist,
// Load should return defaults (with an informational error that callers
// typically ignore).
func TestLoadMissingReturnsDefaults(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	got, err := Load()
	if err == nil {
		t.Error("expected non-nil error when config file is missing (informational)")
	}
	if !reflect.DeepEqual(got, defaults()) {
		t.Errorf("Load on missing file = %+v, want defaults %+v", got, defaults())
	}
}

// TestLoadCorruptReturnsDefaults: a corrupt JSON file should also fall
// back to defaults rather than crash.
func TestLoadCorruptReturnsDefaults(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	dir := filepath.Join(tmp, ".claude-monitor")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte("not json"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := Load()
	if err == nil {
		t.Error("expected non-nil error on corrupt JSON")
	}
	if !reflect.DeepEqual(got, defaults()) {
		t.Errorf("Load on corrupt file = %+v, want defaults", got)
	}
}

// TestLoadAppliesSanitization: a hand-edited config with bad thresholds
// or pick-order should still come back sanitized.
func TestLoadAppliesSanitization(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	dir := filepath.Join(tmp, ".claude-monitor")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	raw := `{"swapThresholds":[150,-5,50,50],"pickOrder":"weird"}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(raw), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !reflect.DeepEqual(got.SwapThresholds, []float64{0, 50, 100}) {
		t.Errorf("SwapThresholds = %v, want [0 50 100]", got.SwapThresholds)
	}
	if got.PickOrder != PickOrderLowest {
		t.Errorf("PickOrder = %q, want %q", got.PickOrder, PickOrderLowest)
	}
}
