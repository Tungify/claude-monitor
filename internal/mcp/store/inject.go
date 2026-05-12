package store

import (
	"errors"
	"fmt"

	"claude-monitor/internal/account"
)

// ApplyStanzaToAllAccounts splices (or removes) a single named
// mcpServers entry in every managed account's .claude.json. Pass a
// nil stanza to delete.
//
// Errors are joined rather than short-circuited: a permission issue
// on account #3 of 5 shouldn't block accounts #4 and #5 from
// receiving the new stanza. The joined error names the failing
// account so callers can surface it.
func ApplyStanzaToAllAccounts(rootSpec, serverName string, stanza map[string]any) error {
	accounts, err := account.ResolveDirs(rootSpec)
	if err != nil {
		return fmt.Errorf("resolve accounts: %w", err)
	}
	var errs []error
	for _, a := range accounts {
		for _, p := range account.ClaudeJSONPaths(a.ConfigDir) {
			if err := account.PatchMCPServerInFile(p, serverName, stanza); err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", a.Name, err))
			}
		}
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}
