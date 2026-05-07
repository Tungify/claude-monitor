package account

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Account is one discovered Claude config dir, with the metadata cheap
// to derive without a network call. The richer per-refresh state (live
// API usage, active marker, etc.) lives on Row, populated by package
// swap.
type Account struct {
	Name        string
	ConfigDir   string
	Email       string
	AccountUUID string
}

// DefaultDir returns ~/.claude on the current user's home directory.
// This is Claude Code's no-CLAUDE_CONFIG_DIR default location.
func DefaultDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude")
}

// ResolveDirs interprets a --root spec into a deduped, sorted list of
// accounts.
//
//   - empty string    → auto-discover every ~/.claude* directory in $HOME
//     that looks like a Claude config dir, plus the
//     subdirectories of ~/.claude-account if present.
//   - comma-separated → each path may be a single Claude config dir
//     (treated as one account) or a parent dir whose
//     subdirectories are accounts.
//
// The function dedupes by canonical absolute path so that, e.g., a
// symlink farm under ~/.claude-account doesn't double-count its targets.
func ResolveDirs(spec string) ([]Account, error) {
	var paths []string
	if spec == "" {
		var err error
		paths, err = autoDiscoverPaths()
		if err != nil {
			return nil, err
		}
	} else {
		for _, p := range strings.Split(spec, ",") {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			paths = append(paths, expandHome(p))
		}
	}

	seen := map[string]struct{}{}
	var out []Account
	for _, p := range paths {
		entries := expandRootPath(p)
		for _, dir := range entries {
			abs, err := filepath.Abs(dir)
			if err != nil {
				abs = dir
			}
			if resolved, err := filepath.EvalSymlinks(abs); err == nil {
				abs = resolved
			}
			if _, dup := seen[abs]; dup {
				continue
			}
			seen[abs] = struct{}{}
			out = append(out, Account{
				Name:        nameFor(abs),
				ConfigDir:   abs,
				Email:       ReadEmail(abs),
				AccountUUID: ReadAccountUUID(abs),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// expandRootPath turns one user-supplied path into the list of actual
// account config dirs it represents. If the path itself is a Claude
// config dir, the path is returned as-is. Otherwise it is treated as a
// parent and its immediate subdirectories are scanned.
func expandRootPath(path string) []string {
	if !dirExists(path) {
		return nil
	}
	if looksLikeClaudeDir(path) {
		return []string{path}
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		sub := filepath.Join(path, e.Name())
		if looksLikeClaudeDir(sub) {
			out = append(out, sub)
		}
	}
	return out
}

// autoDiscoverPaths returns every ~/.claude* entry in $HOME that's a
// directory. The caller decides whether each entry is a single account
// or a parent — autoDiscover doesn't second-guess that.
func autoDiscoverPaths() ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(home)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, ".claude") {
			continue
		}
		if !e.IsDir() {
			// Skip files like .claude.json / .claude.json.backup.
			continue
		}
		out = append(out, filepath.Join(home, name))
	}
	return out, nil
}

// nameFor derives the display name for an account from its path.
// Strip the leading dot so ".claude" reads as "claude" in the table.
func nameFor(absPath string) string {
	base := filepath.Base(absPath)
	return strings.TrimPrefix(base, ".")
}

func expandHome(p string) string {
	if !strings.HasPrefix(p, "~") {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return p
	}
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:])
	}
	return p
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

// looksLikeClaudeDir is permissive on purpose: a freshly authenticated
// account may not have a projects/ subdir yet, but we still want it on
// the dashboard so the user can see the account exists.
func looksLikeClaudeDir(path string) bool {
	for _, marker := range []string{".claude.json", "projects", "sessions"} {
		if _, err := os.Stat(filepath.Join(path, marker)); err == nil {
			return true
		}
	}
	return false
}
