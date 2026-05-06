package tui

import "github.com/charmbracelet/lipgloss"

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

// newStyles builds a palette that respects the user's color toggle.
// When color is off, every style is reset to the no-op default,
// which lipgloss renders as plain text.
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
