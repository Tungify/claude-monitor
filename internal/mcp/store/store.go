// Package store is the shared on-disk envelope for claude-monitor's
// MCP driver configs. Each driver (postgres, clickhouse, …) owns a
// top-level key in ~/.claude-monitor/mcp.json:
//
//	{ "postgres": {...}, "clickhouse": {...} }
//
// Save/Clear preserve sibling keys so a postgres save doesn't wipe
// the clickhouse stanza (and vice versa).
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Path returns the absolute path to mcp.json.
func Path() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude-monitor", "mcp.json"), nil
}

// ReadAll returns the merged file as a map of raw JSON values keyed
// by driver name. Missing file → empty map.
func ReadAll() (map[string]json.RawMessage, error) {
	p, err := Path()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]json.RawMessage{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", p, err)
	}
	if len(b) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	out := map[string]json.RawMessage{}
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("decode %s: %w", p, err)
	}
	return out, nil
}

// ReadInto unmarshals the value under `key` into `dst`. Missing key
// is not an error — caller gets the zero value of dst.
func ReadInto(key string, dst any) error {
	all, err := ReadAll()
	if err != nil {
		return err
	}
	raw, ok := all[key]
	if !ok || len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return json.Unmarshal(raw, dst)
}

// Write sets `key` to `value` (encoded as JSON) and writes the merged
// file back. Other keys are preserved verbatim.
func Write(key string, value any) error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(p), err)
	}
	all, err := ReadAll()
	if err != nil {
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode %s: %w", key, err)
	}
	all[key] = raw
	return write(p, all)
}

// Delete drops `key` from the file. No-op when absent.
func Delete(key string) error {
	p, err := Path()
	if err != nil {
		return err
	}
	all, err := ReadAll()
	if err != nil {
		return err
	}
	if _, present := all[key]; !present {
		return nil
	}
	delete(all, key)
	if len(all) == 0 {
		// Clean up the empty file so /api/mcp/* sees a clean
		// "nothing configured" state rather than a `{}` shell.
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove %s: %w", p, err)
		}
		return nil
	}
	return write(p, all)
}

func write(path string, all map[string]json.RawMessage) error {
	// Re-encode pretty so the file stays human-editable. Sort key
	// order via re-decoding into a map[string]any happens implicitly
	// in json.MarshalIndent (Go sorts map keys).
	b, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return fmt.Errorf("encode: %w", err)
	}
	return os.WriteFile(path, b, 0o600)
}
