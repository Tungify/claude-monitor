package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
)

// WorktreePhase is one entry in the create-worktrees request: the phase
// the web UI wants a worktree for, plus the branch to spawn on it.
type WorktreePhase struct {
	Slug   string `json:"slug"`
	Branch string `json:"branch"`
}

// CreateWorktreesRequest groups all phases of a single plan so the
// daemon can roll back partial successes if one git command fails.
type CreateWorktreesRequest struct {
	PlanID   string          `json:"plan_id"`
	RepoPath string          `json:"repo_path"`
	Phases   []WorktreePhase `json:"phases"`
}

// WorktreeResult is what the daemon writes back per phase. Path and
// branch reflect what was actually created — the caller persists these
// into the plan record so the next session knows where to point cwd.
type WorktreeResult struct {
	PhaseSlug string `json:"phase_slug"`
	Path      string `json:"path"`
	Branch    string `json:"branch"`
}

type CreateWorktreesResponse struct {
	Worktrees []WorktreeResult `json:"worktrees"`
}

// Indirected for tests so we don't need a real git checkout to exercise
// the handler's validation, sequencing, and rollback behavior.
var (
	addWorktree    = gitWorktreeAdd
	removeWorktree = gitWorktreeRemove
)

// safeIdent matches plan ids and phase slugs we will splice into a
// filesystem path. Reject anything else to prevent path traversal.
var safeIdent = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`)

// worktreesRoot resolves to ~/claude-worktrees, the user-home anchor
// agreed in the M4 architecture so worktrees never litter the target
// repo.
func worktreesRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "claude-worktrees"), nil
}

func (s *Server) handleCreateWorktrees(w http.ResponseWriter, r *http.Request) {
	var req CreateWorktreesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
		return
	}
	if !safeIdent.MatchString(req.PlanID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "plan_id must be alphanumeric with - or _"})
		return
	}
	if req.RepoPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "repo_path is required"})
		return
	}
	if !filepath.IsAbs(req.RepoPath) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "repo_path must be absolute"})
		return
	}
	if len(req.Phases) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "phases must not be empty"})
		return
	}
	for _, p := range req.Phases {
		if !safeIdent.MatchString(p.Slug) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("phase slug %q is invalid", p.Slug)})
			return
		}
		if p.Branch == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("phase %q is missing branch", p.Slug)})
			return
		}
	}

	root, err := worktreesRoot()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot resolve home: " + err.Error()})
		return
	}
	planDir := filepath.Join(root, req.PlanID)

	// Create worktrees sequentially: `git worktree add` takes the repo's
	// index lock, so parallel calls would just contend. Track successes
	// to roll back on first failure — partial worktree creation leaves
	// half-orphan refs that confuse the next attempt.
	results := make([]WorktreeResult, 0, len(req.Phases))
	for _, p := range req.Phases {
		path := filepath.Join(planDir, p.Slug)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			rollback(req.RepoPath, results)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("mkdir %s: %v", filepath.Dir(path), err)})
			return
		}
		if err := addWorktree(req.RepoPath, path, p.Branch); err != nil {
			rollback(req.RepoPath, results)
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": fmt.Sprintf("git worktree add %s: %v", p.Slug, err)})
			return
		}
		results = append(results, WorktreeResult{PhaseSlug: p.Slug, Path: path, Branch: p.Branch})
	}

	writeJSON(w, http.StatusOK, CreateWorktreesResponse{Worktrees: results})
}

func rollback(repoPath string, created []WorktreeResult) {
	for _, r := range created {
		_ = removeWorktree(repoPath, r.Path)
	}
}

// gitWorktreeAdd runs `git -C <repo> worktree add <path> -b <branch>`,
// creating a fresh branch off the current HEAD. Caller is responsible
// for guaranteeing branch doesn't already exist; if it does, git fails
// and the error reaches the user.
func gitWorktreeAdd(repoPath, worktreePath, branch string) error {
	cmd := exec.Command("git", "-C", repoPath, "worktree", "add", worktreePath, "-b", branch)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, string(out))
	}
	return nil
}

// gitWorktreeRemove undoes a previously-added worktree. Force is on
// because rollback runs after a failure mid-creation, where the target
// may be in a half-set-up state that vanilla remove refuses to touch.
func gitWorktreeRemove(repoPath, worktreePath string) error {
	cmd := exec.Command("git", "-C", repoPath, "worktree", "remove", "--force", worktreePath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Best-effort rollback. Caller already has the original failure
		// it was undoing; this error is just for tests/logs.
		return fmt.Errorf("%w: %s", err, string(out))
	}
	return nil
}
