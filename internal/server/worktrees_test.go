package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// stubWorktreeOps replaces the package-level git wrappers so tests can
// drive validation, sequencing, and rollback without real git. Returns
// a teardown to restore originals.
func stubWorktreeOps(t *testing.T, addFn func(repo, path, branch string) error) (added, removed *[]string, restore func()) {
	t.Helper()
	var (
		mu       sync.Mutex
		addList  []string
		remList  []string
		origAdd  = addWorktree
		origRem  = removeWorktree
	)
	addWorktree = func(repo, path, branch string) error {
		mu.Lock()
		addList = append(addList, path)
		mu.Unlock()
		return addFn(repo, path, branch)
	}
	removeWorktree = func(repo, path string) error {
		mu.Lock()
		remList = append(remList, path)
		mu.Unlock()
		return nil
	}
	return &addList, &remList, func() {
		addWorktree = origAdd
		removeWorktree = origRem
	}
}

func postWorktrees(t *testing.T, s *Server, body any) *httptest.ResponseRecorder {
	t.Helper()
	buf, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/worktrees", bytes.NewReader(buf))
	s.handleCreateWorktrees(rec, req)
	return rec
}

func TestCreateWorktrees_Validates(t *testing.T) {
	s := newTestServer(t)
	cases := []struct {
		name string
		body CreateWorktreesRequest
	}{
		{"empty plan_id", CreateWorktreesRequest{RepoPath: "/x", Phases: []WorktreePhase{{Slug: "a", Branch: "b"}}}},
		{"plan_id traversal", CreateWorktreesRequest{PlanID: "../etc", RepoPath: "/x", Phases: []WorktreePhase{{Slug: "a", Branch: "b"}}}},
		{"plan_id slash", CreateWorktreesRequest{PlanID: "a/b", RepoPath: "/x", Phases: []WorktreePhase{{Slug: "a", Branch: "b"}}}},
		{"empty repo_path", CreateWorktreesRequest{PlanID: "p1", Phases: []WorktreePhase{{Slug: "a", Branch: "b"}}}},
		{"relative repo_path", CreateWorktreesRequest{PlanID: "p1", RepoPath: "relative", Phases: []WorktreePhase{{Slug: "a", Branch: "b"}}}},
		{"no phases", CreateWorktreesRequest{PlanID: "p1", RepoPath: "/x"}},
		{"slug traversal", CreateWorktreesRequest{PlanID: "p1", RepoPath: "/x", Phases: []WorktreePhase{{Slug: "../bad", Branch: "b"}}}},
		{"empty branch", CreateWorktreesRequest{PlanID: "p1", RepoPath: "/x", Phases: []WorktreePhase{{Slug: "a", Branch: ""}}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := postWorktrees(t, s, c.body)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status: got %d want %d (body: %s)", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
		})
	}
}

func TestCreateWorktrees_HappyPath(t *testing.T) {
	added, removed, restore := stubWorktreeOps(t, func(_, _, _ string) error { return nil })
	defer restore()

	s := newTestServer(t)
	rec := postWorktrees(t, s, CreateWorktreesRequest{
		PlanID:   "plan-xyz",
		RepoPath: "/repo",
		Phases: []WorktreePhase{
			{Slug: "schema", Branch: "wo/plan-xyz/schema"},
			{Slug: "api", Branch: "wo/plan-xyz/api"},
		},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d want 200 (body: %s)", rec.Code, rec.Body.String())
	}

	var resp CreateWorktreesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Worktrees) != 2 {
		t.Fatalf("worktrees: got %d want 2", len(resp.Worktrees))
	}
	for _, w := range resp.Worktrees {
		if !filepath.IsAbs(w.Path) {
			t.Errorf("path not absolute: %s", w.Path)
		}
		if !strings.Contains(w.Path, "claude-worktrees") || !strings.Contains(w.Path, "plan-xyz") {
			t.Errorf("path missing expected segments: %s", w.Path)
		}
		if !strings.HasSuffix(w.Path, "/"+w.PhaseSlug) {
			t.Errorf("path %s does not end with slug %s", w.Path, w.PhaseSlug)
		}
	}
	if len(*added) != 2 {
		t.Errorf("addWorktree call count: got %d want 2", len(*added))
	}
	if len(*removed) != 0 {
		t.Errorf("removeWorktree should not run on success: got %d", len(*removed))
	}
}

func TestCreateWorktrees_RollsBackOnFailure(t *testing.T) {
	var calls int
	added, removed, restore := stubWorktreeOps(t, func(_, _, _ string) error {
		calls++
		if calls == 2 {
			return errors.New("branch already exists")
		}
		return nil
	})
	defer restore()

	s := newTestServer(t)
	rec := postWorktrees(t, s, CreateWorktreesRequest{
		PlanID:   "plan-rb",
		RepoPath: "/repo",
		Phases: []WorktreePhase{
			{Slug: "first", Branch: "wo/rb/first"},
			{Slug: "second", Branch: "wo/rb/second"},
			{Slug: "third", Branch: "wo/rb/third"},
		},
	})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status: got %d want 422 (body: %s)", rec.Code, rec.Body.String())
	}
	// Second add failed; only the first one was successful, so we should
	// have rolled back exactly that one — not the failed one, not the
	// untried third.
	if len(*added) != 2 {
		t.Errorf("add calls: got %d want 2", len(*added))
	}
	if len(*removed) != 1 {
		t.Fatalf("remove calls: got %d want 1 (paths: %v)", len(*removed), *removed)
	}
	if !strings.HasSuffix((*removed)[0], "/first") {
		t.Errorf("rollback removed wrong path: %s", (*removed)[0])
	}
}

func TestCreateWorktrees_InvalidJSON(t *testing.T) {
	s := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/worktrees", bytes.NewReader([]byte("not json")))
	s.handleCreateWorktrees(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: got %d want 400", rec.Code)
	}
}
