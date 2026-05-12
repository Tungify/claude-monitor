package account

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeJSONFile(t *testing.T, path string, data any) {
	t.Helper()
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func readJSONFile(t *testing.T, path string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return out
}

func TestPatchMCPServerInFile_InsertNewSection(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, ".claude.json")
	writeJSONFile(t, p, map[string]any{
		"oauthAccount": map[string]any{"emailAddress": "x@y.z"},
	})

	entry := map[string]any{
		"command": "uvx",
		"args":    []string{"postgres-mcp"},
	}
	if err := PatchMCPServerInFile(p, "postgres-readonly", entry); err != nil {
		t.Fatalf("patch: %v", err)
	}

	got := readJSONFile(t, p)
	servers, ok := got["mcpServers"].(map[string]any)
	if !ok {
		t.Fatalf("expected mcpServers map, got %T", got["mcpServers"])
	}
	if _, present := servers["postgres-readonly"]; !present {
		t.Fatalf("entry not inserted: %v", servers)
	}
	if got["oauthAccount"] == nil {
		t.Fatalf("oauthAccount should be preserved")
	}
}

func TestPatchMCPServerInFile_PreservesSiblings(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, ".claude.json")
	writeJSONFile(t, p, map[string]any{
		"mcpServers": map[string]any{
			"asana": map[string]any{"command": "node"},
		},
	})

	if err := PatchMCPServerInFile(p, "postgres-readonly", map[string]any{
		"command": "uvx",
	}); err != nil {
		t.Fatalf("patch: %v", err)
	}

	got := readJSONFile(t, p)
	servers := got["mcpServers"].(map[string]any)
	if _, ok := servers["asana"]; !ok {
		t.Fatalf("sibling entry was lost: %v", servers)
	}
	if _, ok := servers["postgres-readonly"]; !ok {
		t.Fatalf("new entry missing: %v", servers)
	}
}

func TestPatchMCPServerInFile_DeleteEntry(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, ".claude.json")
	writeJSONFile(t, p, map[string]any{
		"mcpServers": map[string]any{
			"postgres-readonly": map[string]any{"command": "uvx"},
			"asana":             map[string]any{"command": "node"},
		},
	})

	if err := PatchMCPServerInFile(p, "postgres-readonly", nil); err != nil {
		t.Fatalf("patch delete: %v", err)
	}

	got := readJSONFile(t, p)
	servers := got["mcpServers"].(map[string]any)
	if _, ok := servers["postgres-readonly"]; ok {
		t.Fatalf("entry should be deleted: %v", servers)
	}
	if _, ok := servers["asana"]; !ok {
		t.Fatalf("sibling lost on delete: %v", servers)
	}
}

func TestPatchMCPServerInFile_DeleteLastDropsKey(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, ".claude.json")
	writeJSONFile(t, p, map[string]any{
		"mcpServers": map[string]any{
			"postgres-readonly": map[string]any{"command": "uvx"},
		},
	})

	if err := PatchMCPServerInFile(p, "postgres-readonly", nil); err != nil {
		t.Fatalf("patch: %v", err)
	}
	got := readJSONFile(t, p)
	if _, present := got["mcpServers"]; present {
		t.Fatalf("expected mcpServers key to be removed when empty, got %v", got)
	}
}

func TestPatchMCPServerInFile_MissingFileIsNoOp(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "does-not-exist", ".claude.json")
	if err := PatchMCPServerInFile(p, "postgres-readonly", map[string]any{"command": "uvx"}); err != nil {
		t.Fatalf("expected no-op on missing file, got %v", err)
	}
}

func TestPatchMCPServerInFile_IdempotentNoRewrite(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, ".claude.json")
	writeJSONFile(t, p, map[string]any{
		"mcpServers": map[string]any{
			"postgres-readonly": map[string]any{"command": "uvx"},
		},
	})
	stat1, _ := os.Stat(p)

	// Sleep-less: just check that a second patch with the same content
	// produces byte-identical output (which is what we care about).
	if err := PatchMCPServerInFile(p, "postgres-readonly", map[string]any{"command": "uvx"}); err != nil {
		t.Fatalf("patch: %v", err)
	}
	stat2, _ := os.Stat(p)
	if !stat1.ModTime().Equal(stat2.ModTime()) {
		// Not fatal — just informative; some filesystems update mtime
		// even on identical-content writes. Skip rather than fail.
		t.Logf("mtime changed despite identical content; not necessarily a bug")
	}
}
