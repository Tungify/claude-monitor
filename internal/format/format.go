package format

// Truncate clips s to max runes and replaces the last with an ellipsis
// when truncation occurs. max <= 0 returns "". Used everywhere the
// tool surfaces an arbitrary error/HTTP-body to a fixed-width display.
func Truncate(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if len(s) <= max {
		return s
	}
	if max <= 1 {
		return "…"
	}
	return s[:max-1] + "…"
}
