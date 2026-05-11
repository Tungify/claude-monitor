package account

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"claude-monitor/internal/codex"
)

// Provider tags which subscription backend an account belongs to. The
// monitor was originally Anthropic-only; OpenAI/Codex support was added
// in a way that lets both kinds of account coexist in the same table
// and share most of the lifecycle (discovery, refresh, swap), with
// provider-specific branches only where the providers actually differ
// (keychain vs file storage, distinct OAuth endpoints, presence/absence
// of a free usage probe).
type Provider string

const (
	// ProviderAnthropic is the default for backwards compatibility:
	// any account discovered via ~/.claude* or explicitly resolved
	// without a Provider override is treated as an Anthropic account.
	ProviderAnthropic Provider = "anthropic"
	// ProviderOpenAI tags accounts discovered via ~/.codex* — Codex
	// CLI's ChatGPT-subscription credential layout.
	ProviderOpenAI Provider = "openai"
)

// Account is one discovered config dir, with the metadata cheap to
// derive without a network call. The richer per-refresh state (live
// API usage, active marker, etc.) lives on Row, populated by package
// swap.
type Account struct {
	Name        string
	ConfigDir   string
	Email       string
	AccountUUID string
	Provider    Provider
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
			out = append(out, buildAccount(abs))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		// Group by provider first (anthropic before openai) so the
		// table reads top-to-bottom as "Claude rows, then Codex rows".
		// Mixed-provider auto-discovery is the common case; this
		// keeps the visual grouping stable.
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// buildAccount fills an Account record from a config dir, detecting
// which provider owns it. Provider detection is marker-based and runs
// before the read-email/read-uuid helpers, so we don't try to parse
// Anthropic-shaped .claude.json out of a Codex dir.
func buildAccount(abs string) Account {
	prov := DetectProvider(abs)
	a := Account{
		Name:      nameFor(abs),
		ConfigDir: abs,
		Provider:  prov,
	}
	switch prov {
	case ProviderOpenAI:
		if auth, err := codex.Load(abs); err == nil && auth.Tokens != nil {
			if claims, perr := codex.ParseIDToken(auth.Tokens.IDToken); perr == nil {
				a.Email = claims.Email
				if claims.ChatGPTAccountID != "" {
					a.AccountUUID = claims.ChatGPTAccountID
				}
			}
		}
	default:
		a.Email = ReadEmail(abs)
		a.AccountUUID = ReadAccountUUID(abs)
	}
	return a
}

// DetectProvider returns which provider owns this config dir, based on
// the on-disk marker files. A Codex marker takes priority because the
// directory name alone (~/.codex* vs ~/.claude*) isn't authoritative —
// a user could legitimately have ~/.codex symlinked into a Claude
// account layout, etc. Falls back to Anthropic so any pre-existing
// caller that didn't set Provider keeps working unchanged.
func DetectProvider(configDir string) Provider {
	if codex.LooksLikeCodexDir(configDir) {
		return ProviderOpenAI
	}
	return ProviderAnthropic
}

// expandRootPath turns one user-supplied path into the list of actual
// account config dirs it represents. If the path itself looks like a
// supported account dir (Claude OR Codex), it's returned as-is.
// Otherwise it's treated as a parent and its immediate subdirectories
// are scanned for either marker.
func expandRootPath(path string) []string {
	if !dirExists(path) {
		return nil
	}
	if looksLikeAccountDir(path) {
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
		if looksLikeAccountDir(sub) {
			out = append(out, sub)
		}
	}
	return out
}

// looksLikeAccountDir is the provider-agnostic disjunction used by
// discovery: any directory that looks like a Claude OR Codex config
// dir qualifies as an account. Provider tagging happens later, in
// buildAccount, via DetectProvider.
func looksLikeAccountDir(path string) bool {
	return looksLikeClaudeDir(path) || codex.LooksLikeCodexDir(path)
}

// autoDiscoverPaths returns every ~/.claude* and ~/.codex* entry in
// $HOME that's a directory. The caller decides whether each entry is a
// single account or a parent — autoDiscover doesn't second-guess that.
//
// Both prefixes are scanned in one pass: a multi-account power user
// typically has both `~/.claude*` (Claude Code subscription) and
// `~/.codex*` (OpenAI ChatGPT subscription) dirs side by side, and
// requiring two separate flags for that would be friction the tool
// shouldn't add.
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
		if !strings.HasPrefix(name, ".claude") && !strings.HasPrefix(name, ".codex") {
			continue
		}
		if !e.IsDir() {
			// Skip files like .claude.json / .claude.json.backup, or a
			// stray ~/.codex.json some integrations write.
			continue
		}
		// Skip our own state directory. ~/.claude-monitor holds this
		// app's persisted sessions (under sessions/), settings, and
		// other internal state — not a Claude account config dir. It
		// otherwise sneaks in because (a) the name starts with
		// ".claude" and (b) the sessions/ subdir trips
		// looksLikeClaudeDir's marker check, leaving a phantom
		// "claude-monitor" row in the Accounts modal.
		if isOwnStateDir(name) {
			continue
		}
		out = append(out, filepath.Join(home, name))
	}
	return out, nil
}

// isOwnStateDir reports whether `name` (a basename under $HOME) is a
// directory this app uses for its own state and must therefore not
// surface as a Claude account. Currently just `.claude-monitor`, but
// kept as a function so future siblings (e.g. `.claude-monitor-cache`)
// can be added in one place.
func isOwnStateDir(name string) bool {
	return name == ".claude-monitor" || strings.HasPrefix(name, ".claude-monitor-")
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
