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

// AccountUsage is one row in the snapshot output.
type AccountUsage struct {
	Name      string
	ConfigDir string
	Email     string

	Usage *APIUsage // nil when fetch failed
	Err   error    // populated when Usage is nil
}

func RunSnapshot(root string, opts SnapshotOpts) error {
	accts, err := discoverAccounts(root)
	if err != nil {
		return err
	}
	if len(accts) == 0 {
		return fmt.Errorf("no accounts found under %s", root)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

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

	fmt.Print(renderSnapshot(rows, opts))
	return nil
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
	return row
}

// readAccountEmail extracts oauthAccount.emailAddress from .claude.json.
// It's only used to label rows; missing/malformed JSON degrades silently.
func readAccountEmail(configDir string) string {
	b, err := os.ReadFile(filepath.Join(configDir, ".claude.json"))
	if err != nil {
		return ""
	}
	// Manual scan for the emailAddress field — fastest path that doesn't
	// require unmarshalling the whole 24KB blob, and avoids defining
	// a partial struct that breaks if Anthropic adds fields.
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
