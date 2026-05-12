package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func setupHome(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", dir)
	}
}

func TestPath(t *testing.T) {
	setupHome(t)
	p, err := Path()
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if !strings.HasSuffix(p, filepath.Join(".claude-monitor", "mcp.json")) {
		t.Fatalf("unexpected path: %s", p)
	}
}

func TestReadAll_Missing(t *testing.T) {
	setupHome(t)
	all, err := ReadAll()
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if len(all) != 0 {
		t.Fatalf("expected empty, got %+v", all)
	}
}

func TestWritePreservesSiblings(t *testing.T) {
	setupHome(t)
	type pg struct {
		URI string `json:"uri"`
	}
	if err := Write("postgres", pg{URI: "postgres://x/y"}); err != nil {
		t.Fatalf("write postgres: %v", err)
	}
	if err := Write("clickhouse", map[string]string{"host": "h"}); err != nil {
		t.Fatalf("write clickhouse: %v", err)
	}
	all, _ := ReadAll()
	if _, ok := all["postgres"]; !ok {
		t.Fatalf("postgres key lost: %v", all)
	}
	if _, ok := all["clickhouse"]; !ok {
		t.Fatalf("clickhouse key lost: %v", all)
	}

	// File permissions are 0600 (POSIX only).
	if runtime.GOOS != "windows" {
		p, _ := Path()
		info, _ := os.Stat(p)
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("expected 0600, got %o", perm)
		}
	}
}

func TestReadInto(t *testing.T) {
	setupHome(t)
	type cfg struct {
		Foo string `json:"foo"`
	}
	if err := Write("ns", cfg{Foo: "bar"}); err != nil {
		t.Fatalf("write: %v", err)
	}
	var got cfg
	if err := ReadInto("ns", &got); err != nil {
		t.Fatalf("ReadInto: %v", err)
	}
	if got.Foo != "bar" {
		t.Fatalf("unexpected: %+v", got)
	}

	// Missing key → zero value, no error.
	var miss cfg
	if err := ReadInto("nope", &miss); err != nil {
		t.Fatalf("ReadInto on missing: %v", err)
	}
	if miss.Foo != "" {
		t.Fatalf("expected zero value, got %+v", miss)
	}
}

func TestDeleteDropsKeyAndFile(t *testing.T) {
	setupHome(t)
	if err := Write("only", map[string]int{"x": 1}); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := Delete("only"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	p, _ := Path()
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("expected file removed, stat err=%v", err)
	}
	if err := Delete("only"); err != nil {
		t.Fatalf("Delete on missing should no-op: %v", err)
	}
}

func TestDeleteOnePreservesOthers(t *testing.T) {
	setupHome(t)
	_ = Write("a", json.RawMessage(`1`))
	_ = Write("b", json.RawMessage(`2`))
	if err := Delete("a"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	all, _ := ReadAll()
	if _, ok := all["a"]; ok {
		t.Fatalf("a should be gone")
	}
	if _, ok := all["b"]; !ok {
		t.Fatalf("b should remain: %v", all)
	}
}
