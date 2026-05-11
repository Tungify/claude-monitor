package account

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestNameFor(t *testing.T) {
	tests := []struct {
		path, want string
	}{
		{"/home/user/.claude", "claude"},
		{"/home/user/.claude-gem", "claude-gem"},
		{"/home/user/foo", "foo"},
		{"/foo/bar/.claude-account/sub", "sub"},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := nameFor(tt.path); got != tt.want {
				t.Errorf("nameFor(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

func TestExpandHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	tests := []struct {
		in, want string
	}{
		{"~", home},
		{"~/foo", filepath.Join(home, "foo")},
		{"~/.claude-gem", filepath.Join(home, ".claude-gem")},
		{"/abs/path", "/abs/path"},
		{"relative/path", "relative/path"},
		{"~user/foo", "~user/foo"}, // ~user not expanded — only ~ and ~/
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := expandHome(tt.in); got != tt.want {
				t.Errorf("expandHome(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestLooksLikeClaudeDir(t *testing.T) {
	tmp := t.TempDir()

	// Empty dir → not a claude dir.
	empty := filepath.Join(tmp, "empty")
	if err := os.Mkdir(empty, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if looksLikeClaudeDir(empty) {
		t.Error("empty dir should not look like a claude dir")
	}

	// With .claude.json → yes.
	withJSON := filepath.Join(tmp, "withjson")
	if err := os.Mkdir(withJSON, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(withJSON, ".claude.json"), []byte("{}"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if !looksLikeClaudeDir(withJSON) {
		t.Error("dir with .claude.json should look like a claude dir")
	}

	// With projects/ → yes (no .claude.json yet).
	withProjects := filepath.Join(tmp, "withprojects")
	if err := os.MkdirAll(filepath.Join(withProjects, "projects"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if !looksLikeClaudeDir(withProjects) {
		t.Error("dir with projects/ should look like a claude dir")
	}

	// With sessions/ → yes.
	withSessions := filepath.Join(tmp, "withsessions")
	if err := os.MkdirAll(filepath.Join(withSessions, "sessions"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if !looksLikeClaudeDir(withSessions) {
		t.Error("dir with sessions/ should look like a claude dir")
	}
}

func TestDirExists(t *testing.T) {
	tmp := t.TempDir()
	if !dirExists(tmp) {
		t.Errorf("dirExists(%q) = false, want true", tmp)
	}
	if dirExists(filepath.Join(tmp, "nope")) {
		t.Errorf("dirExists on missing path returned true")
	}
	// File, not dir → false.
	f := filepath.Join(tmp, "f")
	if err := os.WriteFile(f, []byte{}, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if dirExists(f) {
		t.Errorf("dirExists on regular file returned true")
	}
}

// TestResolveDirsExplicitSpec exercises the comma-separated path form,
// dedup behavior, and the parent-dir-fanout case.
func TestResolveDirsExplicitSpec(t *testing.T) {
	tmp := t.TempDir()

	// One direct claude dir.
	a := filepath.Join(tmp, "a")
	if err := os.Mkdir(a, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(a, ".claude.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Parent dir with two claude subdirs.
	parent := filepath.Join(tmp, "parent")
	for _, name := range []string{"x", "y"} {
		sub := filepath.Join(parent, name)
		if err := os.MkdirAll(filepath.Join(sub, "projects"), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}
	// Hidden subdir under parent should be ignored.
	if err := os.MkdirAll(filepath.Join(parent, ".hidden", "projects"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	spec := a + "," + parent
	got, err := ResolveDirs(spec)
	if err != nil {
		t.Fatalf("ResolveDirs: %v", err)
	}

	// Expect 3 unique accounts: a, parent/x, parent/y.
	if len(got) != 3 {
		t.Fatalf("got %d accounts, want 3: %+v", len(got), got)
	}

	// Sorted by Name.
	names := make([]string, len(got))
	for i, acct := range got {
		names[i] = acct.Name
	}
	if !sort.StringsAreSorted(names) {
		t.Errorf("accounts not sorted by Name: %v", names)
	}

	// Each account's ConfigDir must be absolute.
	for _, acct := range got {
		if !filepath.IsAbs(acct.ConfigDir) {
			t.Errorf("ConfigDir not absolute: %q", acct.ConfigDir)
		}
	}
}

// TestResolveDirsDedupes confirms that listing the same dir twice (or
// via a symlink) collapses to one entry.
func TestResolveDirsDedupes(t *testing.T) {
	tmp := t.TempDir()
	real := filepath.Join(tmp, "real")
	if err := os.MkdirAll(filepath.Join(real, "projects"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	// Same dir listed twice.
	got, err := ResolveDirs(real + "," + real)
	if err != nil {
		t.Fatalf("ResolveDirs: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("expected 1 (deduped), got %d: %+v", len(got), got)
	}

	// Symlink to the real dir.
	link := filepath.Join(tmp, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink not supported in temp: %v", err)
	}
	got, err = ResolveDirs(real + "," + link)
	if err != nil {
		t.Fatalf("ResolveDirs (with symlink): %v", err)
	}
	if len(got) != 1 {
		t.Errorf("expected 1 (deduped via symlink), got %d: %+v", len(got), got)
	}
}

// TestResolveDirsEmptyAutoDiscovers points HOME at a temp dir with two
// .claude* siblings and verifies they're picked up.
func TestResolveDirsAutoDiscover(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	// .claude (default account) — needs a marker.
	if err := os.MkdirAll(filepath.Join(tmp, ".claude", "projects"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// .claude-gem
	if err := os.MkdirAll(filepath.Join(tmp, ".claude-gem", "sessions"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// A non-.claude dir to make sure it's ignored.
	if err := os.MkdirAll(filepath.Join(tmp, ".other"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// A .claude.json file (not a dir) to make sure it's ignored.
	if err := os.WriteFile(filepath.Join(tmp, ".claude.json"), []byte("{}"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := ResolveDirs("")
	if err != nil {
		t.Fatalf("ResolveDirs(\"\"): %v", err)
	}
	names := make([]string, len(got))
	for i, a := range got {
		names[i] = a.Name
	}
	want := []string{"claude", "claude-gem"}
	sort.Strings(names)
	if !reflect.DeepEqual(names, want) {
		t.Errorf("auto-discovered names = %v, want %v", names, want)
	}
}

// TestResolveDirsSkipsOwnStateDir guards against a regression where
// ~/.claude-monitor (where this app stores its own persisted sessions
// under sessions/) gets picked up as a Claude account: its name starts
// with ".claude" *and* the sessions/ subdir satisfies
// looksLikeClaudeDir's marker check, so without an explicit skip it
// shows up as a phantom "claude-monitor" row in the Accounts modal.
func TestResolveDirsSkipsOwnStateDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	// Real account.
	if err := os.MkdirAll(filepath.Join(tmp, ".claude", "projects"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Our own state dir — has sessions/ so it WOULD pass
	// looksLikeClaudeDir if we didn't filter it out.
	if err := os.MkdirAll(filepath.Join(tmp, ".claude-monitor", "sessions"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	// Hypothetical sibling state dir.
	if err := os.MkdirAll(filepath.Join(tmp, ".claude-monitor-cache", "sessions"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	got, err := ResolveDirs("")
	if err != nil {
		t.Fatalf("ResolveDirs: %v", err)
	}
	names := make([]string, len(got))
	for i, a := range got {
		names[i] = a.Name
	}
	for _, n := range names {
		if n == "claude-monitor" || strings.HasPrefix(n, "claude-monitor-") {
			t.Errorf("auto-discover surfaced own state dir %q in %v", n, names)
		}
	}
	want := []string{"claude"}
	sort.Strings(names)
	if !reflect.DeepEqual(names, want) {
		t.Errorf("auto-discovered names = %v, want %v", names, want)
	}
}

// TestResolveDirsAutoDiscoverCodex makes sure ~/.codex* dirs surface
// alongside ~/.claude* and are tagged with ProviderOpenAI. This is the
// foundation of the OpenAI Codex integration — without it the rest of
// the per-provider branching never runs.
func TestResolveDirsAutoDiscoverCodex(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	// One Claude account + one Codex account side by side.
	if err := os.MkdirAll(filepath.Join(tmp, ".claude", "projects"), 0o755); err != nil {
		t.Fatalf("mkdir claude: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(tmp, ".codex-acc1"), 0o755); err != nil {
		t.Fatalf("mkdir codex: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tmp, ".codex-acc1", "auth.json"), []byte(`{"tokens":{}}`), 0o600); err != nil {
		t.Fatalf("write auth.json: %v", err)
	}

	got, err := ResolveDirs("")
	if err != nil {
		t.Fatalf("ResolveDirs: %v", err)
	}
	byName := map[string]Account{}
	for _, a := range got {
		byName[a.Name] = a
	}
	if a, ok := byName["claude"]; !ok {
		t.Errorf("claude account missing; got %+v", got)
	} else if a.Provider != ProviderAnthropic {
		t.Errorf("claude account Provider = %q, want anthropic", a.Provider)
	}
	if a, ok := byName["codex-acc1"]; !ok {
		t.Errorf("codex-acc1 account missing; got %+v", got)
	} else if a.Provider != ProviderOpenAI {
		t.Errorf("codex-acc1 Provider = %q, want openai", a.Provider)
	}
}

func TestDefaultDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	got := DefaultDir()
	want := filepath.Join(tmp, ".claude")
	if got != want {
		t.Errorf("DefaultDir() = %q, want %q", got, want)
	}
}
