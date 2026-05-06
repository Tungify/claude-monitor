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

// FetchAll discovers accounts under root, queries /api/oauth/usage for each
// in parallel, optionally kicks any account whose 5h window is at 0%, and
// returns the table rows. It is the single data source the TUI calls on
// every tick.
func FetchAll(ctx context.Context, root string, autoKick bool) ([]AccountUsage, error) {
	accts, err := discoverAccounts(root)
	if err != nil {
		return nil, err
	}
	if len(accts) == 0 {
		return nil, fmt.Errorf("no accounts found under %s", root)
	}

	rows := make([]AccountUsage, len(accts))
	var wg sync.WaitGroup
	for i, a := range accts {
		i, a := i, a
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

func discoverAccounts(root string) ([]discoveredAccount, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var out []discoveredAccount
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		dir := filepath.Join(root, e.Name())
		if !looksLikeClaudeDir(dir) {
			continue
		}
		out = append(out, discoveredAccount{
			name:      e.Name(),
			configDir: dir,
			email:     readAccountEmail(dir),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out, nil
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
