package account

import (
	"testing"

	"claude-monitor/internal/api"
)

func TestLabel(t *testing.T) {
	if got := Label(Row{Name: "n", Email: "e@x"}); got != "e@x" {
		t.Errorf("Label prefers email: got %q, want e@x", got)
	}
	if got := Label(Row{Name: "n", Email: ""}); got != "n" {
		t.Errorf("Label falls back to name: got %q, want n", got)
	}
}

func TestDisplayName(t *testing.T) {
	if got := DisplayName(nil); got != "?" {
		t.Errorf("DisplayName(nil) = %q, want ?", got)
	}
	if got := DisplayName(&Row{Name: "n"}); got != "n" {
		t.Errorf("DisplayName(&{Name:n}) = %q, want n", got)
	}
}

func TestDisplayIdent(t *testing.T) {
	if got := DisplayIdent(nil); got != "?" {
		t.Errorf("DisplayIdent(nil) = %q, want ?", got)
	}
	if got := DisplayIdent(&Row{Name: "n"}); got != "n" {
		t.Errorf("DisplayIdent name-only = %q, want n", got)
	}
	if got := DisplayIdent(&Row{Name: "n", Email: "e@x"}); got != "n (e@x)" {
		t.Errorf("DisplayIdent with email = %q, want 'n (e@x)'", got)
	}
}

func TestFiveHourUtil(t *testing.T) {
	if got := FiveHourUtil(nil); got != 0 {
		t.Errorf("FiveHourUtil(nil) = %v, want 0", got)
	}
	if got := FiveHourUtil(&api.Usage{}); got != 0 {
		t.Errorf("FiveHourUtil(empty) = %v, want 0", got)
	}
	u := &api.Usage{FiveHour: &api.Window{Utilization: 42.5}}
	if got := FiveHourUtil(u); got != 42.5 {
		t.Errorf("FiveHourUtil(0.425) = %v, want 42.5", got)
	}
}

func TestRowFiveHourUtil(t *testing.T) {
	if got := RowFiveHourUtil(nil); got != 0 {
		t.Errorf("RowFiveHourUtil(nil) = %v, want 0", got)
	}
	r := &Row{Usage: &api.Usage{FiveHour: &api.Window{Utilization: 7}}}
	if got := RowFiveHourUtil(r); got != 7 {
		t.Errorf("RowFiveHourUtil = %v, want 7", got)
	}
}

func TestWeeklyUtil(t *testing.T) {
	if got := WeeklyUtil(nil); got != 0 {
		t.Errorf("WeeklyUtil(nil) = %v, want 0", got)
	}
	if got := WeeklyUtil(&api.Usage{}); got != 0 {
		t.Errorf("WeeklyUtil(empty) = %v, want 0", got)
	}
	// Should pick the max across the three weekly windows.
	u := &api.Usage{
		SevenDay:       &api.Window{Utilization: 30},
		SevenDaySonnet: &api.Window{Utilization: 90},
		SevenDayOpus:   &api.Window{Utilization: 50},
	}
	if got := WeeklyUtil(u); got != 90 {
		t.Errorf("WeeklyUtil(mixed) = %v, want 90 (max wins)", got)
	}
}

func TestEffectiveUtil(t *testing.T) {
	// 5h dominates.
	hi5h := &api.Usage{
		FiveHour: &api.Window{Utilization: 95},
		SevenDay: &api.Window{Utilization: 20},
	}
	if got := EffectiveUtil(hi5h); got != 95 {
		t.Errorf("EffectiveUtil(5h=95) = %v, want 95", got)
	}
	// Weekly dominates — the scenario the swap fix is about.
	hiWk := &api.Usage{
		FiveHour: &api.Window{Utilization: 1},
		SevenDay: &api.Window{Utilization: 99},
	}
	if got := EffectiveUtil(hiWk); got != 99 {
		t.Errorf("EffectiveUtil(5h=1 weekly=99) = %v, want 99", got)
	}
	if got := EffectiveUtil(nil); got != 0 {
		t.Errorf("EffectiveUtil(nil) = %v, want 0", got)
	}
}

func TestRowEffectiveUtil(t *testing.T) {
	if got := RowEffectiveUtil(nil); got != 0 {
		t.Errorf("RowEffectiveUtil(nil) = %v, want 0", got)
	}
	r := &Row{Usage: &api.Usage{
		FiveHour: &api.Window{Utilization: 5},
		SevenDay: &api.Window{Utilization: 88},
	}}
	if got := RowEffectiveUtil(r); got != 88 {
		t.Errorf("RowEffectiveUtil = %v, want 88", got)
	}
}

func TestFindRow(t *testing.T) {
	rows := []Row{
		{Name: "a", ConfigDir: "/a"},
		{Name: "b", ConfigDir: "/b"},
		{Name: "c", ConfigDir: "/c"},
	}
	got := FindRow(rows, "/b")
	if got == nil || got.Name != "b" {
		t.Errorf("FindRow(/b) = %v, want b", got)
	}
	if got := FindRow(rows, "/missing"); got != nil {
		t.Errorf("FindRow(/missing) = %v, want nil", got)
	}
	if got := FindRow(nil, "/a"); got != nil {
		t.Errorf("FindRow on nil rows = %v, want nil", got)
	}
}

func TestFindRowByIdent(t *testing.T) {
	rows := []Row{
		{Name: "a", ConfigDir: "/abs/a", Email: "a@example.com"},
		{Name: "b", ConfigDir: "/abs/b", Email: "b@example.com"},
		{Name: "shared", ConfigDir: "/abs/shared", Email: "different@example.com"},
	}

	tests := []struct {
		name, ident string
		wantName    string // empty = expect nil
	}{
		{"by short name", "a", "a"},
		{"by email", "b@example.com", "b"},
		{"by config dir", "/abs/a", "a"},
		{"trims whitespace", "  a  ", "a"},
		{"not found", "zzz", ""},
		{"empty ident", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := FindRowByIdent(rows, tt.ident)
			if tt.wantName == "" {
				if got != nil {
					t.Errorf("expected nil, got %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("expected %q, got nil", tt.wantName)
			}
			if got.Name != tt.wantName {
				t.Errorf("got Name=%q, want %q", got.Name, tt.wantName)
			}
		})
	}

	// Precedence: name first, then email, then config dir. If a name
	// matches one row and an email matches another, name wins.
	conflict := []Row{
		{Name: "shared@example.com", ConfigDir: "/x"},      // name happens to look like an email
		{Name: "other", ConfigDir: "/y", Email: "shared@example.com"},
	}
	got := FindRowByIdent(conflict, "shared@example.com")
	if got == nil || got.ConfigDir != "/x" {
		t.Errorf("name-vs-email precedence: got %+v, want /x (name wins)", got)
	}
}
