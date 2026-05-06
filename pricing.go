package main

import "strings"

// Rates are USD per 1M tokens. Cache write uses the 5m ephemeral default.
// These mirror Anthropic's published list pricing for the Claude 4 family
// and are used purely for client-side estimation — they aren't authoritative.
type Rates struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
}

func ratesFor(model string) Rates {
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "opus"):
		return Rates{Input: 15, Output: 75, CacheRead: 1.50, CacheWrite: 18.75}
	case strings.Contains(m, "haiku"):
		return Rates{Input: 0.80, Output: 4, CacheRead: 0.08, CacheWrite: 1.00}
	default:
		// Sonnet (and anything unrecognized) — Sonnet rates as a safe middle.
		return Rates{Input: 3, Output: 15, CacheRead: 0.30, CacheWrite: 3.75}
	}
}

func costOf(model string, u Usage) float64 {
	r := ratesFor(model)
	per := func(tokens int64, rate float64) float64 {
		return float64(tokens) * rate / 1_000_000
	}
	return per(u.Input, r.Input) +
		per(u.Output, r.Output) +
		per(u.CacheRead, r.CacheRead) +
		per(u.CacheCreate, r.CacheWrite)
}

func shortModel(model string) string {
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "opus"):
		return "opus"
	case strings.Contains(m, "sonnet"):
		return "sonnet"
	case strings.Contains(m, "haiku"):
		return "haiku"
	default:
		return model
	}
}
