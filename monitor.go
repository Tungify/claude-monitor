package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Stats struct {
	Sessions       int
	ActiveSessions int
	LastActivity   time.Time

	TotalTokens   int64
	Last5hTokens  int64
	Last24hTokens int64
	Last7dTokens  int64

	CostTotal float64
	Cost5h    float64

	// ModelMix5h: short-model-name ("opus", "sonnet", ...) -> tokens in last 5h.
	ModelMix5h map[string]int64

	ActiveCwds []string
}

type Account struct {
	Name  string
	Path  string
	Stats Stats
}

type Monitor struct {
	root   string
	parser *Parser

	mu       sync.RWMutex
	accounts []*Account
}

func NewMonitor(root string) *Monitor {
	return &Monitor{root: root, parser: NewParser()}
}

func (m *Monitor) Refresh() error {
	entries, err := os.ReadDir(m.root)
	if err != nil {
		return err
	}
	now := time.Now()
	var accts []*Account
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		path := filepath.Join(m.root, e.Name())
		if !looksLikeClaudeDir(path) {
			continue
		}
		stats := m.aggregate(path, now)
		accts = append(accts, &Account{Name: e.Name(), Path: path, Stats: stats})
	}
	sort.Slice(accts, func(i, j int) bool { return accts[i].Name < accts[j].Name })

	m.mu.Lock()
	m.accounts = accts
	m.mu.Unlock()
	return nil
}

func (m *Monitor) Snapshot() []*Account {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Account, len(m.accounts))
	copy(out, m.accounts)
	return out
}

func (m *Monitor) aggregate(acctPath string, now time.Time) Stats {
	stats := Stats{ModelMix5h: map[string]int64{}}

	projectsDir := filepath.Join(acctPath, "projects")
	projects, err := os.ReadDir(projectsDir)
	if err == nil {
		for _, pe := range projects {
			if !pe.IsDir() {
				continue
			}
			sessFiles, err := os.ReadDir(filepath.Join(projectsDir, pe.Name()))
			if err != nil {
				continue
			}
			for _, sf := range sessFiles {
				if sf.IsDir() || !strings.HasSuffix(sf.Name(), ".jsonl") {
					continue
				}
				path := filepath.Join(projectsDir, pe.Name(), sf.Name())
				records, err := m.parser.Parse(path)
				if err != nil {
					continue
				}
				if len(records) == 0 {
					continue
				}
				stats.Sessions++
				for _, r := range records {
					tot := r.Usage.Total()
					cost := costOf(r.Model, r.Usage)
					stats.TotalTokens += tot
					stats.CostTotal += cost
					if r.Time.After(stats.LastActivity) {
						stats.LastActivity = r.Time
					}
					age := now.Sub(r.Time)
					if age <= 5*time.Hour {
						stats.Last5hTokens += tot
						stats.Cost5h += cost
						stats.ModelMix5h[shortModel(r.Model)] += tot
					}
					if age <= 24*time.Hour {
						stats.Last24hTokens += tot
					}
					if age <= 7*24*time.Hour {
						stats.Last7dTokens += tot
					}
				}
			}
		}
	}

	// Live sessions: <account>/sessions/<pid>.json
	sessDir := filepath.Join(acctPath, "sessions")
	if entries, err := os.ReadDir(sessDir); err == nil {
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			b, err := os.ReadFile(filepath.Join(sessDir, e.Name()))
			if err != nil {
				continue
			}
			var rs struct {
				Pid       int    `json:"pid"`
				Status    string `json:"status"`
				UpdatedAt int64  `json:"updatedAt"`
				Cwd       string `json:"cwd"`
			}
			if json.Unmarshal(b, &rs) != nil {
				continue
			}
			if !pidAlive(rs.Pid) {
				continue
			}
			stats.ActiveSessions++
			if rs.Cwd != "" {
				stats.ActiveCwds = append(stats.ActiveCwds, rs.Cwd)
			}
		}
	}
	return stats
}

// looksLikeClaudeDir is permissive on purpose: a freshly authenticated
// account may not yet have a projects/ subdir, but we still want it
// listed on the dashboard so the user sees zero-usage accounts.
func looksLikeClaudeDir(path string) bool {
	for _, marker := range []string{".claude.json", "projects", "sessions"} {
		if _, err := os.Stat(filepath.Join(path, marker)); err == nil {
			return true
		}
	}
	return false
}

// pidAlive returns true if the given pid corresponds to a running process.
// Sending signal 0 doesn't deliver anything but surfaces ESRCH if the
// process is gone, which is the cheapest cross-platform liveness check.
func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	return err == nil
}
