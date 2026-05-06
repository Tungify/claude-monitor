package format

import "testing"

func TestTruncate(t *testing.T) {
	tests := []struct {
		name string
		s    string
		max  int
		want string
	}{
		{"max zero returns empty", "hello", 0, ""},
		{"max negative returns empty", "hello", -3, ""},
		{"shorter than max returned as-is", "hi", 5, "hi"},
		{"equal to max returned as-is", "hello", 5, "hello"},
		{"longer than max gets ellipsis", "hello world", 5, "hell…"},
		{"max 1 returns just ellipsis", "abcdef", 1, "…"},
		{"max 2 keeps first byte plus ellipsis", "abcdef", 2, "a…"},
		{"empty string passes through", "", 5, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Truncate(tt.s, tt.max); got != tt.want {
				t.Errorf("Truncate(%q, %d) = %q, want %q", tt.s, tt.max, got, tt.want)
			}
		})
	}
}

// TestTruncateRuneAware verifies that Truncate operates on runes, not
// bytes, so multi-byte UTF-8 input is never sliced mid-encoding.
func TestTruncateRuneAware(t *testing.T) {
	tests := []struct {
		s    string
		max  int
		want string
	}{
		// "héllo" is 5 runes (h, é, l, l, o). max=4 keeps 3 runes + ellipsis.
		{"héllo", 4, "hél…"},
		// All ASCII fits within max → return as-is even when byte-len > max
		// would have truncated.
		{"héllo", 5, "héllo"},
		// CJK input: each character is 3 bytes in UTF-8.
		{"日本語テスト", 4, "日本語…"},
		// Already valid: short input, plenty of room.
		{"日本", 5, "日本"},
		// max=1 always returns the ellipsis alone, regardless of input.
		{"héllo", 1, "…"},
	}
	for _, tt := range tests {
		got := Truncate(tt.s, tt.max)
		if got != tt.want {
			t.Errorf("Truncate(%q, %d) = %q, want %q", tt.s, tt.max, got, tt.want)
		}
	}
}
