package account

import (
	"fmt"
	"strings"

	"claude-monitor/internal/api"
)

// Row is one line of the dashboard — an Account joined with its live
// API state for a single refresh tick.
//
// Tokens are exported because the swap package (a separate package
// after the layout split) needs to read them: detectActiveDir matches
// the plain keychain slot's RefreshToken against each row, and
// runAutoKick uses AccessToken to fire the 1-token /v1/messages call
// without going back to the keychain.
type Row struct {
	Name      string
	ConfigDir string
	Email     string

	Usage *api.Usage // nil when fetch failed
	Err   error      // populated when Usage is nil

	// Auto-kick state. Populated only when AutoKick is on and the row
	// was eligible (5h window at 0% utilization at the moment of
	// refresh).
	Kicked  bool
	KickErr error

	AccessToken  string
	RefreshToken string
}

// Label is the human-friendly identifier used in TUI cells, log lines,
// and CLI status output. Email when known, else the short name.
func Label(r Row) string {
	if r.Email != "" {
		return r.Email
	}
	return r.Name
}

// DisplayName is a nil-safe accessor for r.Name (for swap reasons /
// flash banners that reference a row that may not exist).
func DisplayName(r *Row) string {
	if r == nil {
		return "?"
	}
	return r.Name
}

// DisplayIdent is the longer "name (email)" form used by the
// non-interactive CLI commands (--swap-to, --list-accounts) where
// horizontal real estate isn't tight.
func DisplayIdent(r *Row) string {
	if r == nil {
		return "?"
	}
	if r.Email != "" {
		return fmt.Sprintf("%s (%s)", r.Name, r.Email)
	}
	return r.Name
}

// FiveHourUtil reads `usage.five_hour.utilization` defensively — many
// callsites operate on rows that may have a nil Usage (errored fetch)
// or a nil five_hour window (no plan that exposes it).
func FiveHourUtil(u *api.Usage) float64 {
	if u == nil || u.FiveHour == nil {
		return 0
	}
	return u.FiveHour.Utilization
}

// RowFiveHourUtil is the nil-safe per-row variant: handy for callers
// that hold a *Row pointer that may be nil (e.g. when the active
// account hasn't been resolved yet).
func RowFiveHourUtil(r *Row) float64 {
	if r == nil {
		return 0
	}
	return FiveHourUtil(r.Usage)
}

// FindRow returns the row whose ConfigDir matches, or nil. Used wherever
// we look up the active account or a swap target by canonical path.
func FindRow(rows []Row, configDir string) *Row {
	for i := range rows {
		if rows[i].ConfigDir == configDir {
			return &rows[i]
		}
	}
	return nil
}

// FindRowByIdent matches an account by name, email, or absolute config
// dir — in that order, exact match only. Returns nil when no row
// matches. Used by the CLI swap entry point so the slash command can
// hand us whichever identifier is most convenient (name is the
// shortest, email is the most stable).
func FindRowByIdent(rows []Row, ident string) *Row {
	ident = strings.TrimSpace(ident)
	if ident == "" {
		return nil
	}
	for i := range rows {
		if rows[i].Name == ident {
			return &rows[i]
		}
	}
	for i := range rows {
		if rows[i].Email != "" && rows[i].Email == ident {
			return &rows[i]
		}
	}
	for i := range rows {
		if rows[i].ConfigDir == ident {
			return &rows[i]
		}
	}
	return nil
}
