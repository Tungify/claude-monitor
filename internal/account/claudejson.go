package account

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ClaudeJSONPaths returns the candidate .claude.json paths for an
// account's config dir, in priority order. Two cases matter:
//
//   - With CLAUDE_CONFIG_DIR set (e.g. ~/.claude-gem): the file lives
//     *inside* the config dir as <configDir>/.claude.json.
//   - With no env override (the default ~/.claude account): the file
//     lives in $HOME as ~/.claude.json — a sibling of the dir, not a
//     child. The ~/.claude dir itself only holds sessions/projects.
//
// In-dir is tried first so the default account's row keeps reading
// the right email after the home-side $HOME/.claude.json has been
// rewritten by an oauthAccount-sync swap (executeSwap stashes the
// pre-swap default identity into ~/.claude/.claude.json before
// overwriting the home file — see swap.syncHomeOAuthAccount).
func ClaudeJSONPaths(configDir string) []string {
	paths := []string{filepath.Join(configDir, ".claude.json")}
	if configDir == DefaultDir() {
		if home, err := os.UserHomeDir(); err == nil {
			paths = append(paths, filepath.Join(home, ".claude.json"))
		}
	}
	return paths
}

// ReadEmail extracts oauthAccount.emailAddress from .claude.json
// without unmarshalling the whole 24KB blob.
func ReadEmail(configDir string) string {
	for _, p := range ClaudeJSONPaths(configDir) {
		if email := stringFieldFromClaudeJSON(p, "emailAddress"); email != "" {
			return email
		}
	}
	return ""
}

// ReadAccountUUID returns the in-dir <configDir>/.claude.json's
// oauthAccount.accountUuid. Unlike ReadEmail, this does NOT fall back to
// $HOME/.claude.json: that file is patched by both Claude Code (on
// /login) and swap.syncHomeOAuthAccount to mirror whichever account
// currently owns the plain keychain slot — i.e. it represents the
// *active* account, not the configDir's identity. Falling back to it
// would make every row spuriously read the active uuid, which would
// break the comparison detectActiveDir performs between the home file
// and per-row AccountUUIDs (every row would match every active
// account).
//
// Returns "" when the in-dir file or the field is missing — the
// detect-active path falls through to refresh_token matching in that
// case, so the empty value is fine.
func ReadAccountUUID(configDir string) string {
	return stringFieldFromClaudeJSON(filepath.Join(configDir, ".claude.json"), "accountUuid")
}

// ReadActiveAccountUUID returns oauthAccount.accountUuid from
// $HOME/.claude.json, the file Claude Code consults to render its
// "logged in as <email>" banner. Both Claude Code's own /login flow and
// our swap.syncHomeOAuthAccount keep this in sync with whichever account
// currently owns the plain keychain slot, so its accountUuid is the
// stable identifier detectActiveDir uses to figure out which row owns
// the ★. We deliberately bypass ClaudeJSONPaths' default-dir fallback
// chain (which prefers ~/.claude/.claude.json — that's the *backup* of
// the original default identity, not the active one).
//
// Returns "" when $HOME isn't resolvable, the file is missing, or the
// field isn't present (fresh install pre-first-login).
func ReadActiveAccountUUID() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return stringFieldFromClaudeJSON(filepath.Join(home, ".claude.json"), "accountUuid")
}

// emailFromClaudeJSON is kept as a thin wrapper so existing tests (and
// any external lookups) can call the email-specific name; the real
// parser is stringFieldFromClaudeJSON.
func emailFromClaudeJSON(path string) string {
	return stringFieldFromClaudeJSON(path, "emailAddress")
}

// stringFieldFromClaudeJSON locates a top-level string field by name
// inside a Claude Code .claude.json without unmarshalling the whole
// 24KB blob. We assume the field name is unique within the file —
// Claude Code's schema is flat enough at the leaf level (emailAddress,
// accountUuid, etc. live only inside oauthAccount) that this holds in
// practice. Callers that need a nested field should still use
// json.Unmarshal.
//
// Handles both compact (`"key":"v"`) and pretty-printed (`"key": "v"`)
// shapes the encoder may emit, plus `\X` escape pairs inside the value
// so an escaped quote doesn't end the string early.
func stringFieldFromClaudeJSON(path, field string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	s := string(b)
	key := `"` + field + `"`
	i := strings.Index(s, key)
	if i < 0 {
		return ""
	}
	j := i + len(key)
	for j < len(s) && (s[j] == ' ' || s[j] == '\t' || s[j] == '\n' || s[j] == '\r') {
		j++
	}
	if j >= len(s) || s[j] != ':' {
		return ""
	}
	j++
	for j < len(s) && (s[j] == ' ' || s[j] == '\t' || s[j] == '\n' || s[j] == '\r') {
		j++
	}
	if j >= len(s) || s[j] != '"' {
		return ""
	}
	j++
	start := j
	for j < len(s) {
		switch s[j] {
		case '\\':
			j += 2
		case '"':
			return s[start:j]
		default:
			j++
		}
	}
	return ""
}

// ReadOAuthBlock returns the raw JSON of the `oauthAccount` field
// from the account's .claude.json (in-dir first, home fallback for
// the default account). Returns (nil, nil) when the file or field is
// missing — callers treat that as "no identity to copy" and skip
// the sync silently.
//
// Used at swap time to copy the target account's identity (email,
// displayName, accountUuid, organizationName, …) into the plain
// slot's $HOME/.claude.json so `claude` running without
// CLAUDE_CONFIG_DIR shows the right "logged in as <email>" banner
// after the keychain rotation.
func ReadOAuthBlock(configDir string) (json.RawMessage, error) {
	for _, p := range ClaudeJSONPaths(configDir) {
		block, err := ReadOAuthBlockFromFile(p)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if block != nil {
			return block, nil
		}
	}
	return nil, nil
}

// ReadOAuthBlockFromFile reads a single .claude.json and returns its
// oauthAccount field, or (nil, nil) when the field is absent. Exposed
// because swap.syncHomeOAuthAccount needs to peek at $HOME/.claude.json
// directly (not through the configDir → paths resolver).
func ReadOAuthBlockFromFile(path string) (json.RawMessage, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(b, &data); err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	block, ok := data["oauthAccount"]
	if !ok || len(block) == 0 || string(block) == "null" {
		return nil, nil
	}
	return block, nil
}

// PatchOAuthInFile rewrites the `oauthAccount` field in the given
// .claude.json with `block`, preserving every other top-level field.
// Atomic via write-temp-and-rename so a concurrent reader (Claude
// Code itself) never sees a half-written file.
//
// No-op when the destination doesn't exist — we don't conjure a
// .claude.json from scratch; that's Claude Code's responsibility on
// first login.
func PatchOAuthInFile(path string, block json.RawMessage) error {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(b, &data); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	data["oauthAccount"] = block
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	perm := os.FileMode(0o600)
	if info, statErr := os.Stat(path); statErr == nil {
		perm = info.Mode().Perm()
	}
	return writeFileAtomic(path, out, perm)
}

// WriteMinimalClaudeJSON writes a one-field `.claude.json` containing
// only the oauthAccount block. Used to back up the default account's
// identity to ~/.claude/.claude.json before the first swap-away
// rewrites $HOME/.claude.json — without this stash, the original
// default identity would be lost and a future swap-back-to-default
// couldn't restore it.
//
// Idempotent: re-running with the same block produces an identical
// file (modulo Go's map-key ordering on remarshal), so we don't bother
// short-circuiting when the content already matches.
func WriteMinimalClaudeJSON(path string, block json.RawMessage) error {
	payload := map[string]json.RawMessage{"oauthAccount": block}
	out, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	return writeFileAtomic(path, out, 0o600)
}

// writeFileAtomic writes data to a temp file in the same directory and
// renames it over `path`. Avoids partial-write corruption of
// .claude.json when Claude Code is concurrently reading or writing it.
// Permissions on the final file match `perm` (we set them on the temp
// file before the rename).
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, filepath.Base(path)+".tmp.*")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tmpName := f.Name()
	cleanup := func() { _ = os.Remove(tmpName) }
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("write %s: %w", tmpName, err)
	}
	if err := f.Chmod(perm); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("chmod %s: %w", tmpName, err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close %s: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		cleanup()
		return fmt.Errorf("rename %s -> %s: %w", tmpName, path, err)
	}
	return nil
}
