package codex

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateName(t *testing.T) {
	cases := []struct {
		name string
		want bool // true = valid
	}{
		{"acc1", true},
		{"acc-1", true},
		{"acc_1", true},
		{"acc.1", true},
		{"", false},
		{".", false},
		{"..", false},
		{"a/b", false},
		{"a b", false},
		{"a*b", false},
		{strings.Repeat("a", 51), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := ValidateName(c.name)
			if (err == nil) != c.want {
				t.Errorf("ValidateName(%q): want valid=%v, got err=%v", c.name, c.want, err)
			}
		})
	}
}

func TestConfigDirForName(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir, err := ConfigDirForName("dev1")
	if err != nil {
		t.Fatalf("ConfigDirForName: %v", err)
	}
	want := filepath.Join(home, ".codex-dev1")
	if dir != want {
		t.Errorf("dir = %q, want %q", dir, want)
	}
}

func TestProvisionCreatesDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir, err := Provision("dev1")
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Errorf("provisioned dir missing: %v", err)
	}
	// LooksLikeCodexDir keys on config.toml — the stub file Provision
	// writes must satisfy the marker so auto-discovery picks the new
	// dir up before `codex login` runs.
	if !LooksLikeCodexDir(dir) {
		t.Errorf("provisioned dir not detected as codex dir")
	}
}

func TestProvisionRefusesExistingDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	existing := filepath.Join(home, ".codex-dev1")
	if err := os.MkdirAll(existing, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	_, err := Provision("dev1")
	if err == nil {
		t.Fatalf("Provision on existing dir succeeded, want error")
	}
}
