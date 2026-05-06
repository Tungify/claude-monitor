package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"

	"claude-monitor/internal/api"
)

func renderBarPct(st styles, pct float64, width int) string {
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
	var colored string
	switch {
	case pct >= 90:
		colored = st.barRed.Render(bar)
	case pct >= 70:
		colored = st.barYellow.Render(bar)
	case pct >= 1:
		colored = st.barGreen.Render(bar)
	default:
		colored = st.dim.Render(bar)
	}
	return fmt.Sprintf("%s %s", fmtPct(pct), colored)
}

func renderResetsAt(st styles, t *time.Time, now time.Time) string {
	if t == nil {
		return st.dim.Render("—")
	}
	d := t.Sub(now)
	if d < 0 {
		return st.dim.Render("now")
	}
	switch {
	case d < time.Hour:
		return st.warn.Render(fmt.Sprintf("in %dm", int(d.Minutes())))
	case d < 24*time.Hour:
		return fmt.Sprintf("in %dh%02dm", int(d.Hours()), int(d.Minutes())%60)
	default:
		days := int(d.Hours()) / 24
		hrs := int(d.Hours()) % 24
		return fmt.Sprintf("in %dd%dh", days, hrs)
	}
}

func renderPctOnly(st styles, w *api.Window) string {
	if w == nil {
		return st.dim.Render("—")
	}
	if w.Utilization == 0 {
		return st.dim.Render(fmtPct(0))
	}
	s := fmtPct(w.Utilization)
	switch {
	case w.Utilization >= 90:
		return st.barRed.Render(s)
	case w.Utilization >= 70:
		return st.barYellow.Render(s)
	default:
		return st.barGreen.Render(s)
	}
}

func writeCols(cells []string, widths []int, headerStyle *lipgloss.Style) string {
	var b strings.Builder
	for i, cell := range cells {
		if i > 0 {
			b.WriteString("  ")
		}
		val := cell
		if headerStyle != nil {
			val = headerStyle.Render(cell)
		}
		b.WriteString(padRight(val, widths[i]))
	}
	b.WriteString("\n")
	return b.String()
}

func sumWidths(w []int) int {
	s := 0
	for _, x := range w {
		s += x
	}
	return s
}

func getUtil(w *api.Window) float64 {
	if w == nil {
		return 0
	}
	return w.Utilization
}

func getResets(w *api.Window) *time.Time {
	if w == nil {
		return nil
	}
	return w.ResetsAt
}

func fmtPct(p float64) string {
	return fmt.Sprintf("%3.0f%%", p)
}

func onOff(b bool) string {
	if b {
		return "ON"
	}
	return "OFF"
}

func boolBadge(st styles, b bool) string {
	if b {
		return st.on.Render("ON")
	}
	return st.off.Render("OFF")
}
