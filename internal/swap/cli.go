package swap

import (
	"context"
	"fmt"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/config"
	"claude-monitor/internal/format"
	"claude-monitor/internal/keychain"
)

// snapshotAccountsLite resolves accounts and loads their per-dir
// keychain creds, without making any network calls. Used by the CLI
// helpers (--list-accounts, --swap-to) that don't need live
// /api/oauth/usage data — only the credentials needed to identify the
// active account and to write the plain slot.
//
// Rows that fail to load creds are still returned (with RefreshToken
// empty) so listing shows them as "not authenticated" rather than
// silently dropping them.
func snapshotAccountsLite(rootSpec string) ([]account.Row, error) {
	accts, err := account.ResolveDirs(rootSpec)
	if err != nil {
		return nil, err
	}
	if len(accts) == 0 {
		if rootSpec == "" {
			return nil, fmt.Errorf("no Claude config dirs found in $HOME (looked for ~/.claude*)")
		}
		return nil, fmt.Errorf("no accounts found under %s", rootSpec)
	}
	rows := make([]account.Row, len(accts))
	for i, a := range accts {
		rows[i] = account.Row{Name: a.Name, ConfigDir: a.ConfigDir, Email: a.Email, AccountUUID: a.AccountUUID}
		// Hashed-first because after a swap the plain entry no longer
		// represents the default account; only the hashed entries are
		// reliable per-account identities.
		if creds, err := keychain.LoadCredentialsHashedFirst(a.ConfigDir); err == nil {
			rows[i].RefreshToken = creds.RefreshToken
		}
	}
	return rows, nil
}

// To is the non-TUI entry point that a slash command (or any shell
// caller) hits via `claude-monitor --swap-to <ident>`. It writes the
// plain keychain slot to point at the named account so the next API
// call from any default-flow `claude` tab transparently picks up the
// new bearer token.
//
// ident may be the account's short name ("acc-be-1"), its email, or
// its absolute config dir.
func To(rootSpec, ident string) error {
	rows, err := snapshotAccountsLite(rootSpec)
	if err != nil {
		return err
	}
	target := account.FindRowByIdent(rows, ident)
	if target == nil {
		return fmt.Errorf("account %q not found (try --list-accounts)", ident)
	}
	if target.RefreshToken == "" {
		return fmt.Errorf("account %q has no stored credentials (run `claude` once for that account)", ident)
	}
	activeDir := detectActiveDir(rows)
	if activeDir == target.ConfigDir {
		fmt.Printf("already active: %s\n", account.DisplayIdent(target))
		return nil
	}
	fromName := "?"
	if active := account.FindRow(rows, activeDir); active != nil {
		fromName = account.DisplayIdent(active)
	}
	if err := Execute(rows, activeDir, target.ConfigDir); err != nil {
		return err
	}
	fmt.Printf("swapped: %s → %s\n", fromName, account.DisplayIdent(target))
	return nil
}

// ListAccounts prints a table of discovered accounts with live 5h
// utilization (so a slash command can show the user which account is
// least loaded). The active account is marked with a trailing "(active)".
//
// Network errors per row render inline as the row's status, mirroring
// the TUI behavior; an account that hasn't been authenticated yet
// shows "not authenticated" instead of a percentage.
func ListAccounts(rootSpec string) error {
	cfg, _ := config.Load()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := FetchAll(ctx, rootSpec, cfg, nil, nil, "", 0)
	if err != nil {
		return err
	}
	maxName, maxEmail := len("NAME"), len("EMAIL")
	for _, r := range res.Rows {
		if n := len(r.Name); n > maxName {
			maxName = n
		}
		if n := len(r.Email); n > maxEmail {
			maxEmail = n
		}
	}
	fmt.Printf("%-*s  %-*s  %-9s  %6s  %s\n",
		maxName, "NAME", maxEmail, "EMAIL", "PROVIDER", "5H", "STATUS")
	for _, r := range res.Rows {
		util := "—"
		status := ""
		provider := "anthropic"
		if r.Provider == account.ProviderOpenAI {
			provider = "openai"
		}
		switch {
		case r.RefreshToken == "" && r.Err == nil:
			status = "not authenticated"
		case r.Err != nil:
			status = format.Truncate(r.Err.Error(), 60)
		case r.Provider == account.ProviderOpenAI:
			// Codex rows have no usage probe — show plan instead in
			// the util column so the CLI snapshot is useful for
			// scripts that want to filter by plan type.
			if r.PlanType != "" {
				util = r.PlanType
			} else {
				util = "chatgpt"
			}
		case r.Usage != nil:
			util = fmt.Sprintf("%3.0f%%", account.FiveHourUtil(r.Usage))
		}
		// Provider-aware active comparison: an Anthropic row is
		// active when its dir owns the plain keychain slot; an
		// OpenAI row is active when its dir owns ~/.codex/auth.json.
		isActive := r.ConfigDir == res.ActiveDir
		if r.Provider == account.ProviderOpenAI {
			isActive = r.ConfigDir == res.CodexActiveDir
		}
		if isActive {
			if status != "" {
				status = "active — " + status
			} else {
				status = "active"
			}
		}
		fmt.Printf("%-*s  %-*s  %-9s  %6s  %s\n",
			maxName, r.Name, maxEmail, r.Email, provider, util, status)
	}
	return nil
}
