package tui

import (
	"reflect"
	"testing"
)

func TestPadRight(t *testing.T) {
	tests := []struct {
		name       string
		s          string
		width      int
		want       string
	}{
		{"shorter than width", "ab", 5, "ab   "},
		{"exact width", "abcde", 5, "abcde"},
		{"longer than width unchanged", "abcdef", 3, "abcdef"},
		{"zero width unchanged", "ab", 0, "ab"},
		{"empty padded", "", 3, "   "},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := padRight(tt.s, tt.width); got != tt.want {
				t.Errorf("padRight(%q, %d) = %q, want %q", tt.s, tt.width, got, tt.want)
			}
		})
	}
}

func TestPadRightIgnoresAnsiEscapes(t *testing.T) {
	// "\x1b[31mhi\x1b[0m" has 2 visible chars but 11 bytes. padRight to
	// width 5 should add 3 spaces (5 - 2 visible).
	in := "\x1b[31mhi\x1b[0m"
	got := padRight(in, 5)
	want := in + "   "
	if got != want {
		t.Errorf("padRight ANSI: got %q, want %q", got, want)
	}
}

func TestVisibleLen(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want int
	}{
		{"plain ascii", "hello", 5},
		{"empty", "", 0},
		{"ansi color stripped", "\x1b[31mhi\x1b[0m", 2},
		{"multiple ansi runs", "\x1b[1m\x1b[31mab\x1b[0m\x1b[0m", 2},
		{"non-color escape still consumed until 'm'", "\x1b[2;31mab\x1b[0m", 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := visibleLen(tt.in); got != tt.want {
				t.Errorf("visibleLen(%q) = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}

func TestFmtPct(t *testing.T) {
	tests := []struct {
		in   float64
		want string
	}{
		{0, "  0%"},
		{5, "  5%"},
		{50, " 50%"},
		{100, "100%"},
		{42.7, " 43%"}, // rounds to 43 via %.0f
	}
	for _, tt := range tests {
		t.Run("", func(t *testing.T) {
			if got := fmtPct(tt.in); got != tt.want {
				t.Errorf("fmtPct(%v) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestOnOff(t *testing.T) {
	if got := onOff(true); got != "ON" {
		t.Errorf("onOff(true) = %q, want ON", got)
	}
	if got := onOff(false); got != "OFF" {
		t.Errorf("onOff(false) = %q, want OFF", got)
	}
}

func TestParseThresholds(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    []float64
		wantErr bool
	}{
		{"valid trio", "80, 95, 100", []float64{80, 95, 100}, false},
		{"single value", "50", []float64{50}, false},
		{"whitespace only fails", "   ", nil, true},
		{"empty string fails", "", nil, true},
		{"negative rejected", "-5, 50", nil, true},
		{"over 100 rejected", "50, 105", nil, true},
		{"non-number rejected", "50, foo", nil, true},
		{"unsorted gets sorted", "100, 80, 95", []float64{80, 95, 100}, false},
		{"dupes deduped", "50, 50, 80", []float64{50, 80}, false},
		{"trailing comma tolerated", "50, 80,", []float64{50, 80}, false},
		{"all blank parts after trim becomes empty", ", , ,", nil, true},
		{"floats preserved", "12.5, 50", []float64{12.5, 50}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseThresholds(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Errorf("expected error for %q, got %v", tt.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error for %q: %v", tt.in, err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parseThresholds(%q) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

func TestThresholdsToString(t *testing.T) {
	tests := []struct {
		in   []float64
		want string
	}{
		{[]float64{50, 80, 100}, "50, 80, 100"},
		{[]float64{50.5}, "50.5"},
		{[]float64{}, ""},
		{nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			if got := thresholdsToString(tt.in); got != tt.want {
				t.Errorf("thresholdsToString(%v) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// TestParseThresholdsRoundTrip ensures parse → tostring → parse is stable.
func TestParseThresholdsRoundTrip(t *testing.T) {
	in := "75, 92, 100"
	parsed1, err := parseThresholds(in)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	roundtrip := thresholdsToString(parsed1)
	parsed2, err := parseThresholds(roundtrip)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if !reflect.DeepEqual(parsed1, parsed2) {
		t.Errorf("round trip diverged: %v → %q → %v", parsed1, roundtrip, parsed2)
	}
}
