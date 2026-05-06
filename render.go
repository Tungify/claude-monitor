package main

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	ansiReset  = "\x1b[0m"
	ansiBold   = "\x1b[1m"
	ansiDim    = "\x1b[2m"
	ansiCyan   = "\x1b[36m"
	ansiGreen  = "\x1b[32m"
	ansiYellow = "\x1b[33m"
	ansiRed    = "\x1b[31m"
	ansiBlue   = "\x1b[34m"
	ansiMag    = "\x1b[35m"
	ansiGrey   = "\x1b[90m"
)

type RenderOpts struct {
	NoCost   bool
	NoColor  bool
	MaxCwd   int
	Interval time.Duration
}

type column struct {
	header string
	width  int
	right  bool
}

func Render(accts []*Account, opts RenderOpts) string {
	c := colorizer{enabled: !opts.NoColor}

	cols := []column{
		{header: "ACCOUNT", width: 22},
		{header: "ACT", width: 4, right: true},
		{header: "SESS", width: 5, right: true},
		{header: "LAST", width: 9},
		{header: "5H TOK", width: 9, right: true},
		{header: "24H TOK", width: 9, right: true},
		{header: "7D TOK", width: 9, right: true},
	}
	if !opts.NoCost {
		cols = append(cols,
			column{header: "5H $", width: 8, right: true},
			column{header: "TOTAL $", width: 9, right: true},
		)
	}
	cols = append(cols,
		column{header: "MODELS (5H)", width: 26},
		column{header: "ACTIVE CWD", width: clamp(opts.MaxCwd, 20, 80)},
	)

	var b strings.Builder

	now := time.Now()
	title := fmt.Sprintf("claude-analytic  %s   accounts: %d   refresh: %s",
		now.Format("2006-01-02 15:04:05"), len(accts), opts.Interval)
	b.WriteString(c.bold(title))
	b.WriteString("\n")
	b.WriteString(c.grey(strings.Repeat("─", totalWidth(cols))))
	b.WriteString("\n")

	// Header row
	for i, col := range cols {
		if i > 0 {
			b.WriteString("  ")
		}
		text := c.bold(col.header)
		if col.right {
			b.WriteString(padLeft(text, col.width))
		} else {
			b.WriteString(padRight(text, col.width))
		}
	}
	b.WriteString("\n")

	// Aggregate totals across accounts to print at the bottom.
	var tot Stats
	tot.ModelMix5h = map[string]int64{}

	for _, a := range accts {
		s := a.Stats
		fields := []string{
			c.account(a.Name),
			renderActive(c, s.ActiveSessions),
			fmt.Sprintf("%d", s.Sessions),
			renderLast(c, s.LastActivity),
			c.tokens(s.Last5hTokens, "5h"),
			formatTokens(s.Last24hTokens),
			formatTokens(s.Last7dTokens),
		}
		if !opts.NoCost {
			fields = append(fields,
				formatCost(s.Cost5h),
				formatCost(s.CostTotal),
			)
		}
		fields = append(fields,
			renderModelMix(c, s.ModelMix5h, cols[len(cols)-2].width),
			renderCwd(c, s.ActiveCwds, cols[len(cols)-1].width),
		)

		for i, col := range cols {
			if i > 0 {
				b.WriteString("  ")
			}
			cell := fields[i]
			if col.right {
				b.WriteString(padLeft(cell, col.width))
			} else {
				b.WriteString(padRight(cell, col.width))
			}
		}
		b.WriteString("\n")

		tot.Sessions += s.Sessions
		tot.ActiveSessions += s.ActiveSessions
		tot.TotalTokens += s.TotalTokens
		tot.Last5hTokens += s.Last5hTokens
		tot.Last24hTokens += s.Last24hTokens
		tot.Last7dTokens += s.Last7dTokens
		tot.Cost5h += s.Cost5h
		tot.CostTotal += s.CostTotal
		for k, v := range s.ModelMix5h {
			tot.ModelMix5h[k] += v
		}
	}

	b.WriteString(c.grey(strings.Repeat("─", totalWidth(cols))))
	b.WriteString("\n")

	// Totals row
	totFields := []string{
		c.bold("TOTAL"),
		fmt.Sprintf("%d", tot.ActiveSessions),
		fmt.Sprintf("%d", tot.Sessions),
		"—",
		c.tokens(tot.Last5hTokens, "5h"),
		formatTokens(tot.Last24hTokens),
		formatTokens(tot.Last7dTokens),
	}
	if !opts.NoCost {
		totFields = append(totFields, formatCost(tot.Cost5h), formatCost(tot.CostTotal))
	}
	totFields = append(totFields,
		renderModelMix(c, tot.ModelMix5h, cols[len(cols)-2].width),
		"",
	)
	for i, col := range cols {
		if i > 0 {
			b.WriteString("  ")
		}
		cell := totFields[i]
		if col.right {
			b.WriteString(padLeft(cell, col.width))
		} else {
			b.WriteString(padRight(cell, col.width))
		}
	}
	b.WriteString("\n")
	b.WriteString(c.grey("Ctrl-C to exit. Tokens shown are sums of input + output + cache_read + cache_write."))
	b.WriteString("\n")
	return b.String()
}

func renderActive(c colorizer, n int) string {
	if n == 0 {
		return c.grey("·")
	}
	return c.green(fmt.Sprintf("●%d", n))
}

func renderLast(c colorizer, t time.Time) string {
	rel := formatRelative(t)
	d := time.Since(t)
	switch {
	case t.IsZero():
		return c.grey(rel)
	case d < 2*time.Minute:
		return c.green(rel)
	case d < time.Hour:
		return c.yellow(rel)
	default:
		return c.grey(rel)
	}
}

func renderModelMix(c colorizer, mix map[string]int64, width int) string {
	if len(mix) == 0 {
		return c.grey("—")
	}
	type kv struct {
		k string
		v int64
	}
	var pairs []kv
	for k, v := range mix {
		pairs = append(pairs, kv{k, v})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].v > pairs[j].v })

	parts := make([]string, 0, len(pairs))
	for _, p := range pairs {
		var label string
		switch p.k {
		case "opus":
			label = c.mag("opus")
		case "sonnet":
			label = c.cyan("sonnet")
		case "haiku":
			label = c.blue("haiku")
		default:
			label = p.k
		}
		parts = append(parts, fmt.Sprintf("%s %s", label, formatTokens(p.v)))
	}
	out := strings.Join(parts, " ")
	if visibleLen(out) > width {
		out = truncate(out, width)
	}
	return out
}

func renderCwd(c colorizer, cwds []string, width int) string {
	if len(cwds) == 0 {
		return c.grey("—")
	}
	short := make([]string, 0, len(cwds))
	for _, p := range cwds {
		short = append(short, filepath.Base(p))
	}
	out := strings.Join(short, ", ")
	if visibleLen(out) > width {
		out = truncate(out, width)
	}
	return c.cyan(out)
}

func totalWidth(cols []column) int {
	sum := 0
	for i, c := range cols {
		if i > 0 {
			sum += 2
		}
		sum += c.width
	}
	return sum
}

func padLeft(s string, width int) string {
	v := visibleLen(s)
	if v >= width {
		return s
	}
	return strings.Repeat(" ", width-v) + s
}

func clamp(v, lo, hi int) int {
	if v == 0 {
		v = lo
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// colorizer wraps coloring helpers and respects --no-color.
type colorizer struct{ enabled bool }

func (c colorizer) wrap(code, s string) string {
	if !c.enabled {
		return s
	}
	return code + s + ansiReset
}
func (c colorizer) bold(s string) string   { return c.wrap(ansiBold, s) }
func (c colorizer) grey(s string) string   { return c.wrap(ansiGrey, s) }
func (c colorizer) green(s string) string  { return c.wrap(ansiGreen, s) }
func (c colorizer) yellow(s string) string { return c.wrap(ansiYellow, s) }
func (c colorizer) red(s string) string    { return c.wrap(ansiRed, s) }
func (c colorizer) cyan(s string) string   { return c.wrap(ansiCyan, s) }
func (c colorizer) blue(s string) string   { return c.wrap(ansiBlue, s) }
func (c colorizer) mag(s string) string    { return c.wrap(ansiMag, s) }

func (c colorizer) account(name string) string {
	// Strip the "claude-" / "gem-account" prefix to keep things tidy
	// without losing identifying info.
	return c.bold(name)
}

// tokens picks a color based on how close to a soft "high usage"
// threshold the count is. The thresholds are heuristics — a Pro 5h
// window is roughly low-millions of tokens — so they're meant to flag
// loud outliers, not enforce a quota.
func (c colorizer) tokens(n int64, _ string) string {
	s := formatTokens(n)
	switch {
	case n == 0:
		return c.grey(s)
	case n > 5_000_000:
		return c.red(s)
	case n > 1_000_000:
		return c.yellow(s)
	default:
		return c.green(s)
	}
}
