package format

// Truncate clips s to max runes and replaces the last with an ellipsis
// when truncation occurs. max <= 0 returns "". Used everywhere the
// tool surfaces an arbitrary error/HTTP-body to a fixed-width display.
//
// Rune-aware: a multi-byte UTF-8 input is never sliced mid-rune, so the
// returned string is always valid UTF-8.
func Truncate(s string, max int) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max <= 1 {
		return "…"
	}
	return string(runes[:max-1]) + "…"
}
