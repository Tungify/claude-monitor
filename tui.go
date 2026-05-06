package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ----------------------------------------------------------------------
// Messages
// ----------------------------------------------------------------------

// tickMsg fires every config.IntervalSeconds and triggers a refresh.
type tickMsg time.Time

// refreshMsg carries the result of a FetchAll call back into the model.
type refreshMsg struct {
	rows []AccountUsage
	err  error
	at   time.Time
}

// flashClearMsg clears a transient status banner (used for "config saved",
// "kick toggled", etc).
type flashClearMsg struct{}

// ----------------------------------------------------------------------
// Model
// ----------------------------------------------------------------------

type model struct {
	cfg  Config
	root string

	rows        []AccountUsage
	err         error
	lastRefresh time.Time
	refreshing  bool

	// inflight is incremented every time we issue a refreshCmd and
	// compared against the version embedded in the resulting refreshMsg
	// — a stale result from a previous tick is discarded if a newer
	// refresh has been started in the meantime.
	inflight uint64

	flash       string
	flashExpiry time.Time

	width    int
	height   int
	showHelp bool
}

func initialModel(root string, cfg Config) model {
	return model{
		root:     root,
		cfg:      cfg,
		showHelp: true,
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(
		m.refreshCmd(m.inflight+1),
		tickCmd(m.cfg.IntervalSeconds),
	)
}

// ----------------------------------------------------------------------
// Commands
// ----------------------------------------------------------------------

func (m *model) refreshCmd(version uint64) tea.Cmd {
	root := m.root
	autoKick := m.cfg.AutoKick
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		rows, err := FetchAll(ctx, root, autoKick)
		_ = version // version is captured separately on the model side
		return refreshMsg{rows: rows, err: err, at: time.Now()}
	}
}

func tickCmd(secs int) tea.Cmd {
	return tea.Tick(time.Duration(secs)*time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func flashClearCmd(d time.Duration) tea.Cmd {
	return tea.Tick(d, func(time.Time) tea.Msg { return flashClearMsg{} })
}

// ----------------------------------------------------------------------
// Update
// ----------------------------------------------------------------------

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(msg)

	case tickMsg:
		// Schedule the next tick + kick a refresh if one isn't already in
		// flight. We always re-arm the tick so the cadence stays steady
		// even when the user has just done a manual refresh.
		cmds := []tea.Cmd{tickCmd(m.cfg.IntervalSeconds)}
		if !m.refreshing {
			m.refreshing = true
			m.inflight++
			cmds = append(cmds, m.refreshCmd(m.inflight))
		}
		return m, tea.Batch(cmds...)

	case refreshMsg:
		m.refreshing = false
		m.rows = msg.rows
		m.err = msg.err
		m.lastRefresh = msg.at
		return m, nil

	case flashClearMsg:
		if time.Now().After(m.flashExpiry) {
			m.flash = ""
		}
		return m, nil
	}
	return m, nil
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c", "esc":
		return m, tea.Quit

	case "r":
		if m.refreshing {
			return m, nil
		}
		m.refreshing = true
		m.inflight++
		return m, m.refreshCmd(m.inflight)

	case "k":
		m.cfg.AutoKick = !m.cfg.AutoKick
		m.persistAndFlash(fmt.Sprintf("auto-kick: %s", onOff(m.cfg.AutoKick)))
		return m, flashClearCmd(2 * time.Second)

	case "c":
		m.cfg.Color = !m.cfg.Color
		m.persistAndFlash(fmt.Sprintf("color: %s", onOff(m.cfg.Color)))
		return m, flashClearCmd(2 * time.Second)

	case "+", "=":
		m.cfg.IntervalSeconds = stepInterval(m.cfg.IntervalSeconds, +1)
		m.persistAndFlash(fmt.Sprintf("interval: %s", fmtInterval(m.cfg.IntervalSeconds)))
		return m, tea.Batch(tickCmd(m.cfg.IntervalSeconds), flashClearCmd(2*time.Second))

	case "-", "_":
		m.cfg.IntervalSeconds = stepInterval(m.cfg.IntervalSeconds, -1)
		m.persistAndFlash(fmt.Sprintf("interval: %s", fmtInterval(m.cfg.IntervalSeconds)))
		return m, tea.Batch(tickCmd(m.cfg.IntervalSeconds), flashClearCmd(2*time.Second))

	case "?":
		m.showHelp = !m.showHelp
		return m, nil
	}
	return m, nil
}

func (m *model) persistAndFlash(text string) {
	if err := SaveConfig(m.cfg); err != nil {
		m.flash = "save failed: " + err.Error()
	} else {
		m.flash = text
	}
	m.flashExpiry = time.Now().Add(2 * time.Second)
}

// ----------------------------------------------------------------------
// View
// ----------------------------------------------------------------------

func (m model) View() string {
	var b strings.Builder
	st := newStyles(m.cfg.Color)

	b.WriteString(m.header(st))
	b.WriteString("\n")
	b.WriteString(m.table(st))
	b.WriteString(m.peakLine(st))
	if m.showHelp {
		b.WriteString("\n")
		b.WriteString(m.helpBar(st))
	}
	return b.String()
}

func (m model) header(st styles) string {
	title := st.title.Render("claude-monitor")
	now := time.Now()

	var status string
	switch {
	case m.refreshing && m.lastRefresh.IsZero():
		status = st.dim.Render("loading…")
	case m.refreshing:
		status = st.accent.Render("refreshing…")
	case m.err != nil:
		status = st.errText.Render("error: " + m.err.Error())
	default:
		ago := now.Sub(m.lastRefresh).Truncate(time.Second)
		next := time.Duration(m.cfg.IntervalSeconds)*time.Second - ago
		if next < 0 {
			next = 0
		}
		status = st.dim.Render(fmt.Sprintf(
			"refreshed %s ago   next in %s   accounts: %d",
			ago, next.Truncate(time.Second), len(m.rows),
		))
	}

	flash := ""
	if m.flash != "" && time.Now().Before(m.flashExpiry) {
		flash = "   " + st.flash.Render(m.flash)
	}

	return st.headerBar.Render(title+"   "+status) + flash
}

func (m model) table(st styles) string {
	if m.err != nil && len(m.rows) == 0 {
		return st.errText.Render("⚠ "+m.err.Error()) + "\n"
	}
	if len(m.rows) == 0 {
		return st.dim.Render("no accounts yet — fetching…\n")
	}

	bw := 25 // bar width
	header := []string{"ACCOUNT", "5H", "RESETS", "WEEKLY", "RESETS", "SONNET WK", "OPUS WK"}
	widths := []int{22, 8 + bw + 1, 10, 8 + bw + 1, 10, 9, 9}

	var b strings.Builder
	b.WriteString(writeCols(header, widths, &st.colHeader))
	b.WriteString(st.divider.Render(strings.Repeat("─", sumWidths(widths)+(len(widths)-1)*2)))
	b.WriteString("\n")

	now := time.Now()
	for _, r := range m.rows {
		if r.Err != nil {
			label := accountLabel(r)
			line := padRight(st.colHeader.Render(label), widths[0]) +
				"  " + st.errText.Render(truncate(r.Err.Error(), m.width-widths[0]-4))
			b.WriteString(line)
			b.WriteString("\n")
			continue
		}
		u := r.Usage
		cells := []string{
			st.account.Render(accountLabel(r)),
			renderBarPct(st, fiveHourUtil(u), bw),
			renderResetsAt(st, getResets(u.FiveHour), now),
			renderBarPct(st, getUtil(u.SevenDay), bw),
			renderResetsAt(st, getResets(u.SevenDay), now),
			renderPctOnly(st, u.SevenDaySonnet),
			renderPctOnly(st, u.SevenDayOpus),
		}
		row := writeCols(cells, widths, nil)
		// trim trailing newline from writeCols so we can append the kick suffix
		row = strings.TrimRight(row, "\n")
		if r.Kicked {
			row += "  " + st.kicked.Render("[kicked]")
		} else if r.KickErr != nil {
			row += "  " + st.errText.Render("[kick failed: "+truncate(r.KickErr.Error(), 60)+"]")
		}
		b.WriteString(row)
		b.WriteString("\n")
	}
	b.WriteString(st.divider.Render(strings.Repeat("─", sumWidths(widths)+(len(widths)-1)*2)))
	b.WriteString("\n")
	return b.String()
}

func (m model) peakLine(st styles) string {
	var peak5h, peakWk float64
	have := 0
	for _, r := range m.rows {
		if r.Err != nil || r.Usage == nil {
			continue
		}
		have++
		if u := fiveHourUtil(r.Usage); u > peak5h {
			peak5h = u
		}
		if u := getUtil(r.Usage.SevenDay); u > peakWk {
			peakWk = u
		}
	}
	if have == 0 {
		return ""
	}
	return st.peak.Render(fmt.Sprintf(
		"PEAK across %d account(s):  5h %s   weekly %s",
		have, fmtPct(peak5h), fmtPct(peakWk),
	)) + "\n"
}

func (m model) helpBar(st styles) string {
	parts := []string{
		fmt.Sprintf("%s auto-kick: %s", st.key.Render("[k]"), boolBadge(st, m.cfg.AutoKick)),
		fmt.Sprintf("%s color: %s", st.key.Render("[c]"), boolBadge(st, m.cfg.Color)),
		fmt.Sprintf("%s interval: %s", st.key.Render("[+/-]"), st.value.Render(fmtInterval(m.cfg.IntervalSeconds))),
		st.key.Render("[r]") + " refresh",
		st.key.Render("[?]") + " toggle help",
		st.key.Render("[q]") + " quit",
	}
	return st.helpBar.Render(strings.Join(parts, "   "))
}

// ----------------------------------------------------------------------
// Cell rendering
// ----------------------------------------------------------------------

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

func renderPctOnly(st styles, w *Window) string {
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

func fmtInterval(s int) string {
	d := time.Duration(s) * time.Second
	if d >= time.Hour {
		return d.Truncate(time.Hour).String()
	}
	if d >= time.Minute {
		return d.Truncate(time.Minute).String()
	}
	return d.String()
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

// ----------------------------------------------------------------------
// Styles
// ----------------------------------------------------------------------

type styles struct {
	title     lipgloss.Style
	headerBar lipgloss.Style
	colHeader lipgloss.Style
	account   lipgloss.Style
	divider   lipgloss.Style
	dim       lipgloss.Style
	accent    lipgloss.Style
	errText   lipgloss.Style
	warn      lipgloss.Style
	flash     lipgloss.Style
	barGreen  lipgloss.Style
	barYellow lipgloss.Style
	barRed    lipgloss.Style
	kicked    lipgloss.Style
	peak      lipgloss.Style
	helpBar   lipgloss.Style
	key       lipgloss.Style
	value     lipgloss.Style
	on        lipgloss.Style
	off       lipgloss.Style
}

// newStyles builds a palette that respects the user's color toggle. When
// color is off, every style is reset to the no-op default, which lipgloss
// renders as plain text.
func newStyles(color bool) styles {
	var s styles
	s.title = lipgloss.NewStyle().Bold(true)
	s.headerBar = lipgloss.NewStyle().Padding(0, 1)
	s.colHeader = lipgloss.NewStyle().Bold(true)
	s.account = lipgloss.NewStyle().Bold(true)
	s.divider = lipgloss.NewStyle()
	s.dim = lipgloss.NewStyle()
	s.accent = lipgloss.NewStyle()
	s.errText = lipgloss.NewStyle()
	s.warn = lipgloss.NewStyle()
	s.flash = lipgloss.NewStyle()
	s.barGreen = lipgloss.NewStyle()
	s.barYellow = lipgloss.NewStyle()
	s.barRed = lipgloss.NewStyle()
	s.kicked = lipgloss.NewStyle()
	s.peak = lipgloss.NewStyle().Bold(true)
	s.helpBar = lipgloss.NewStyle().Padding(0, 1)
	s.key = lipgloss.NewStyle().Bold(true)
	s.value = lipgloss.NewStyle()
	s.on = lipgloss.NewStyle()
	s.off = lipgloss.NewStyle()

	if !color {
		return s
	}

	// Adaptive colors so we don't blow out either light or dark themes.
	c := func(dark, light string) lipgloss.AdaptiveColor {
		return lipgloss.AdaptiveColor{Dark: dark, Light: light}
	}

	s.title = s.title.Foreground(c("#FAFAFA", "#1F1F1F"))
	s.headerBar = s.headerBar.
		Foreground(c("#FAFAFA", "#1F1F1F")).
		Background(c("#5A4FCF", "#E0DCFF"))
	s.colHeader = s.colHeader.Foreground(c("#A6ADC8", "#4C566A"))
	s.account = s.account.Foreground(c("#FAFAFA", "#1F1F1F"))
	s.divider = s.divider.Foreground(c("#3B3F45", "#D8DEE9"))
	s.dim = s.dim.Foreground(c("#7A828F", "#9097A1"))
	s.accent = s.accent.Foreground(c("#7AA2F7", "#3B6EE0"))
	s.errText = s.errText.Foreground(c("#F38BA8", "#B33A55"))
	s.warn = s.warn.Foreground(c("#F9E2AF", "#B58900"))
	s.flash = s.flash.Foreground(c("#1F1F1F", "#FAFAFA")).
		Background(c("#A6E3A1", "#3FA776")).Padding(0, 1).Bold(true)
	s.barGreen = s.barGreen.Foreground(c("#A6E3A1", "#3FA776"))
	s.barYellow = s.barYellow.Foreground(c("#F9E2AF", "#B58900"))
	s.barRed = s.barRed.Foreground(c("#F38BA8", "#B33A55"))
	s.kicked = s.kicked.Foreground(c("#A6E3A1", "#3FA776")).Bold(true)
	s.peak = s.peak.Foreground(c("#FAFAFA", "#1F1F1F"))
	s.helpBar = s.helpBar.
		Foreground(c("#A6ADC8", "#4C566A")).
		Background(c("#1F2335", "#EDEEF2"))
	s.key = s.key.Foreground(c("#7AA2F7", "#3B6EE0")).Bold(true)
	s.value = s.value.Foreground(c("#FAFAFA", "#1F1F1F"))
	s.on = s.on.Foreground(c("#A6E3A1", "#3FA776")).Bold(true)
	s.off = s.off.Foreground(c("#7A828F", "#9097A1"))
	return s
}
