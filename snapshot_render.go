package main

import (
	"fmt"
	"strings"
	"time"
)

type SnapshotOpts struct {
	NoColor  bool
	BarWidth int // visible bar width (cells)
}

func renderSnapshot(rows []AccountUsage, opts SnapshotOpts) string {
	c := colorizer{enabled: !opts.NoColor}
	bw := opts.BarWidth
	if bw <= 0 {
		bw = 25
	}

	var b strings.Builder

	now := time.Now()
	b.WriteString(c.bold(fmt.Sprintf("claude-analytic /usage  —  %s", now.Format("2006-01-02 15:04:05"))))
	b.WriteString("\n\n")

	// Header
	header := []string{"ACCOUNT", "5H USAGE", "RESETS", "WEEK", "RESETS", "SONNET WK", "OPUS WK"}
	widths := []int{22, 8 + bw + 1, 12, 8 + bw + 1, 12, 9, 9}
	writeRow(&b, header, widths, c.bold)
	b.WriteString(c.grey(strings.Repeat("─", sumWidths(widths)+(len(widths)-1)*2)))
	b.WriteString("\n")

	for _, r := range rows {
		if r.Err != nil {
			cells := []string{
				accountLabel(r),
				c.red(truncate(r.Err.Error(), widths[1]+widths[2]+widths[3]+widths[4]+widths[5]+widths[6]+12)),
			}
			b.WriteString(padRight(cells[0], widths[0]))
			b.WriteString("  ")
			b.WriteString(cells[1])
			b.WriteString("\n")
			continue
		}
		u := r.Usage
		row := []string{
			accountLabel(r),
			renderBarPct(c, getUtil(u.FiveHour), bw),
			renderResetsAt(c, getResets(u.FiveHour), now),
			renderBarPct(c, getUtil(u.SevenDay), bw),
			renderResetsAt(c, getResets(u.SevenDay), now),
			renderPctOnly(c, u.SevenDaySonnet),
			renderPctOnly(c, u.SevenDayOpus),
		}
		writeRow(&b, row, widths, nil)
	}

	// Aggregated peaks across accounts (max % per window). The user
	// usually cares about which account is closest to its cap, so the
	// peak is more useful than an average.
	var peak5h, peak7d float64
	have := 0
	for _, r := range rows {
		if r.Err != nil || r.Usage == nil {
			continue
		}
		have++
		if u := getUtil(r.Usage.FiveHour); u > peak5h {
			peak5h = u
		}
		if u := getUtil(r.Usage.SevenDay); u > peak7d {
			peak7d = u
		}
	}
	b.WriteString(c.grey(strings.Repeat("─", sumWidths(widths)+(len(widths)-1)*2)))
	b.WriteString("\n")
	if have > 0 {
		b.WriteString(c.bold(fmt.Sprintf("PEAK across %d account(s):  5h %s   weekly %s\n",
			have, fmtPct(peak5h), fmtPct(peak7d))))
	}
	b.WriteString(c.grey("Source: GET /api/oauth/usage (same data as the in-Claude-Code /usage dialog).\n"))
	return b.String()
}

func writeRow(b *strings.Builder, cells []string, widths []int, headerFn func(string) string) {
	for i, cell := range cells {
		if i > 0 {
			b.WriteString("  ")
		}
		val := cell
		if headerFn != nil {
			val = headerFn(cell)
		}
		b.WriteString(padRight(val, widths[i]))
	}
	b.WriteString("\n")
}

func sumWidths(w []int) int {
	s := 0
	for _, x := range w {
		s += x
	}
	return s
}

func accountLabel(r AccountUsage) string {
	if r.Email != "" {
		return fmt.Sprintf("%s (%s)", r.Name, r.Email)
	}
	return r.Name
}

func getUtil(w *Window) float64 {
	if w == nil {
		return 0
	}
	return w.Utilization
}

func getResets(w *Window) *time.Time {
	if w == nil {
		return nil
	}
	return w.ResetsAt
}

func fmtPct(p float64) string {
	return fmt.Sprintf("%3.0f%%", p)
}

func renderBarPct(c colorizer, pct float64, width int) string {
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	filled := int(pct / 100 * float64(width))
	if filled > width {
		filled = width
	}
	bar := strings.Repeat("█", filled) + strings.Repeat("░", width-filled)
	colored := bar
	switch {
	case pct >= 90:
		colored = c.red(bar)
	case pct >= 70:
		colored = c.yellow(bar)
	case pct >= 1:
		colored = c.green(bar)
	default:
		colored = c.grey(bar)
	}
	return fmt.Sprintf("%s %s", fmtPct(pct), colored)
}

func renderResetsAt(c colorizer, t *time.Time, now time.Time) string {
	if t == nil {
		return c.grey("—")
	}
	d := t.Sub(now)
	if d < 0 {
		return c.grey("now")
	}
	switch {
	case d < time.Hour:
		return c.yellow(fmt.Sprintf("in %dm", int(d.Minutes())))
	case d < 24*time.Hour:
		return fmt.Sprintf("in %dh%02dm", int(d.Hours()), int(d.Minutes())%60)
	default:
		days := int(d.Hours()) / 24
		hrs := int(d.Hours()) % 24
		return fmt.Sprintf("in %dd%dh", days, hrs)
	}
}

func renderPctOnly(c colorizer, w *Window) string {
	if w == nil {
		return c.grey("—")
	}
	if w.Utilization == 0 {
		return c.grey(fmtPct(0))
	}
	s := fmtPct(w.Utilization)
	switch {
	case w.Utilization >= 90:
		return c.red(s)
	case w.Utilization >= 70:
		return c.yellow(s)
	default:
		return c.green(s)
	}
}

