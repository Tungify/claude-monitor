package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// AccountUsage is one row of the dashboard.
type AccountUsage struct {
	Name      string
	ConfigDir string
	Email     string

	Usage *APIUsage // nil when fetch failed
	Err   error     // populated when Usage is nil

	// Auto-kick state. Populated only when AutoKick is on and the row was
	// eligible (5h window at 0% utilization at the moment of refresh).
	Kicked  bool
	KickErr error

	accessToken string // retained for the auto-kick pass; not exported
}

// FetchAll resolves accounts according to rootSpec, queries
// /api/oauth/usage for each in parallel, optionally kicks any account
// whose 5h window is at 0%, and returns the table rows. It is the single
// data source the TUI calls on every tick.
//
// skipUntil maps a config dir to a "do not call API before" timestamp;
// accounts in the backoff window get a synthetic row reflecting the
// remaining wait, so the UI keeps showing them but no request goes out.
func FetchAll(ctx context.Context, rootSpec string, autoKick bool, skipUntil map[string]time.Time) ([]AccountUsage, error) {
	accts, err := ResolveAccountDirs(rootSpec)
	if err != nil {
		return nil, err
	}
	if len(accts) == 0 {
		if rootSpec == "" {
			return nil, fmt.Errorf("no Claude config dirs found in $HOME (looked for ~/.claude*)")
		}
		return nil, fmt.Errorf("no accounts found under %s", rootSpec)
	}

	now := time.Now()
	rows := make([]AccountUsage, len(accts))
	var wg sync.WaitGroup
	for i, a := range accts {
		i, a := i, a
		if t, ok := skipUntil[a.configDir]; ok && now.Before(t) {
			rows[i] = AccountUsage{
				Name:      a.name,
				ConfigDir: a.configDir,
				Email:     a.email,
				Err:       fmt.Errorf("rate limited (retry in %s)", time.Until(t).Round(time.Second)),
			}
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			rows[i] = fetchOne(ctx, a)
		}()
	}
	wg.Wait()

	if autoKick {
		runAutoKick(ctx, rows)
	}
	return rows, nil
}

// runAutoKick fires a 1-token message at every account whose 5h window is
// currently at 0% utilization, in parallel. We do this after the fetch pass
// so we know the actual util value rather than trusting stale state.
func runAutoKick(ctx context.Context, rows []AccountUsage) {
	var wg sync.WaitGroup
	for i := range rows {
		r := &rows[i]
		if r.Err != nil || r.Usage == nil || r.accessToken == "" {
			continue
		}
		if fiveHourUtil(r.Usage) > 0 {
			continue
		}
		wg.Add(1)
		go func(r *AccountUsage) {
			defer wg.Done()
			kickCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			if err := KickWindow(kickCtx, r.accessToken); err != nil {
				r.KickErr = err
				return
			}
			r.Kicked = true
		}(r)
	}
	wg.Wait()
}

func fiveHourUtil(u *APIUsage) float64 {
	if u == nil || u.FiveHour == nil {
		return 0
	}
	return u.FiveHour.Utilization
}

type discoveredAccount struct {
	name      string
	configDir string
	email     string
}

// ResolveAccountDirs interprets a --root spec into a deduped, sorted list
// of accounts.
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
func ResolveAccountDirs(spec string) ([]discoveredAccount, error) {
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
	var out []discoveredAccount
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
			out = append(out, discoveredAccount{
				name:      accountNameFor(abs),
				configDir: abs,
				email:     readAccountEmail(abs),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
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

// accountNameFor derives the display name for an account from its path.
// Strip the leading dot so ".claude" reads as "claude" in the table.
func accountNameFor(absPath string) string {
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

func fetchOne(ctx context.Context, a discoveredAccount) AccountUsage {
	row := AccountUsage{Name: a.name, ConfigDir: a.configDir, Email: a.email}
	creds, err := LoadCredentials(a.configDir)
	if err != nil {
		row.Err = fmt.Errorf("no token (run `claude` once to login)")
		return row
	}
	if creds.Expired() {
		row.Err = fmt.Errorf("token expired (run `claude` once to refresh)")
		return row
	}
	usage, err := FetchUsage(ctx, creds.AccessToken)
	if err != nil {
		row.Err = err
		return row
	}
	row.Usage = usage
	row.accessToken = creds.AccessToken
	return row
}

// looksLikeClaudeDir is permissive on purpose: a freshly authenticated
// account may not have a projects/ subdir yet, but we still want it on the
// dashboard so the user can see the account exists.
func looksLikeClaudeDir(path string) bool {
	for _, marker := range []string{".claude.json", "projects", "sessions"} {
		if _, err := os.Stat(filepath.Join(path, marker)); err == nil {
			return true
		}
	}
	return false
}

// readAccountEmail extracts oauthAccount.emailAddress from .claude.json
// without unmarshalling the whole 24KB blob.
func readAccountEmail(configDir string) string {
	b, err := os.ReadFile(filepath.Join(configDir, ".claude.json"))
	if err != nil {
		return ""
	}
	const key = `"emailAddress":"`
	i := strings.Index(string(b), key)
	if i < 0 {
		return ""
	}
	rest := string(b)[i+len(key):]
	end := strings.Index(rest, `"`)
	if end < 0 {
		return ""
	}
	return rest[:end]
}
