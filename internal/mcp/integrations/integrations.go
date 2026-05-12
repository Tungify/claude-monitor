// Package integrations manages claude-monitor's per-service MCP
// integrations (Slack today, more services later). Mirrors the
// `connections` package's shape: each integration is a named, typed
// record persisted in ~/.claude-monitor/mcp.json under the
// `integrations` top-level key and spliced into every managed
// account's .claude.json mcpServers map plus orchestrator-spawned SDK
// sessions.
//
// `name` is the *MCP server name* the model sees — tool calls surface
// as `mcp__<name>__<upstream_tool>`. Validated to the same lowercase
// charset as connections so the SDK's `mcp__<name>__<tool>` flattening
// never produces an ambiguous tool name.
//
// Why a separate package from `connections`: DB connections enforce
// read-only at the upstream MCP layer; integrations are full-fidelity
// service clients with per-service auth shapes (tokens, OAuth cookies,
// API keys). Sharing one Connection struct would balloon driver
// branches across the wire format and the test surface; better to
// keep them parallel and share only the on-disk envelope helper in
// `store`.
package integrations

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"

	"claude-monitor/internal/mcp/store"
)

// mu serializes load-modify-write on the integrations envelope. Same
// rationale as connections: a single global mutex is the right
// granularity for O(10) entries per user.
var mu sync.Mutex

// Service enumerates supported integrations. New services require: a
// Stanza branch, a Validate branch, a UI form, and (where applicable)
// a sessions.ts injection mapping.
type Service string

const (
	ServiceSlack Service = "slack"
)

// Integration is one user-configured service. Field set is the union
// of all services' configs; per-service Validate enforces which
// fields apply.
type Integration struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Service Service `json:"service"`

	// Slack — user pastes a single token. We auto-detect xoxp/xoxb
	// from the prefix and map to the matching SLACK_MCP_*_TOKEN env
	// var the upstream server reads. Browser-token mode (xoxc + xoxd)
	// is a planned follow-up; the upstream supports it but the UX
	// requires a guided cookie-extraction flow we haven't built yet.
	SlackToken string `json:"slack_token,omitempty"`
	// SlackAddMessageTool opts into the upstream's
	// conversations_add_message tool. Off by default to match the
	// upstream's default (read-only). Channel-scoped allowlist is a
	// follow-up — for now this is a binary toggle that sets the env
	// var to "true" (= every channel the token can post to).
	SlackAddMessageTool bool `json:"slack_add_message_tool,omitempty"`
}

// driverKey is the top-level key in mcp.json. Sibling to "connections".
const driverKey = "integrations"

// nameRe matches connections.nameRe — same constraints because the
// resulting tool FQN passes through the same SDK flattening.
var nameRe = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// MaxNameLen caps the user-supplied name. Long names crowd the chat
// UI's tool-call header and inflate every mcpServers stanza we inject.
const MaxNameLen = 48

// Validate runs name + per-service field checks. UniqueName-against-
// siblings is the caller's job (see CreateAndApply).
func (i Integration) Validate() error {
	if i.Name == "" {
		return errors.New("name is required")
	}
	if len(i.Name) > MaxNameLen {
		return fmt.Errorf("name too long (max %d)", MaxNameLen)
	}
	if !nameRe.MatchString(i.Name) {
		return errors.New("name must match [a-z][a-z0-9_]* (lowercase, no spaces or hyphens)")
	}
	switch i.Service {
	case ServiceSlack:
		return validateSlack(i)
	default:
		return fmt.Errorf("unknown service: %q", i.Service)
	}
}

func validateSlack(i Integration) error {
	tok := strings.TrimSpace(i.SlackToken)
	if tok == "" {
		return errors.New("slack_token is required")
	}
	if !strings.HasPrefix(tok, "xoxp-") && !strings.HasPrefix(tok, "xoxb-") {
		return errors.New("slack_token must start with xoxp- (user OAuth) or xoxb- (bot)")
	}
	// Bare prefix with no body is a typo, not a real token.
	if len(tok) < 12 {
		return errors.New("slack_token looks too short to be valid")
	}
	return nil
}

// Stanza emits the mcpServers entry for this integration. Returns nil
// when the integration isn't materially configured — callers treat
// nil as "skip this entry / strip any existing".
func (i Integration) Stanza() map[string]any {
	switch i.Service {
	case ServiceSlack:
		return slackStanza(i)
	}
	return nil
}

// slackStanza wires up korotovsky/slack-mcp-server. Stdio transport
// is explicit (--transport stdio) because the upstream's npx entry
// point requires it. The token env var is selected from the token's
// prefix so the same UI field covers both bot and user OAuth modes.
//
// Token lives in env (not args) so `ps` doesn't echo it.
func slackStanza(i Integration) map[string]any {
	tok := strings.TrimSpace(i.SlackToken)
	if tok == "" {
		return nil
	}
	env := map[string]string{}
	switch {
	case strings.HasPrefix(tok, "xoxp-"):
		env["SLACK_MCP_XOXP_TOKEN"] = tok
	case strings.HasPrefix(tok, "xoxb-"):
		env["SLACK_MCP_XOXB_TOKEN"] = tok
	default:
		return nil
	}
	if i.SlackAddMessageTool {
		// "true" enables the tool for every channel the token can
		// reach. The upstream also accepts a CSV channel allowlist
		// here; expose that knob if/when users ask.
		env["SLACK_MCP_ADD_MESSAGE_TOOL"] = "true"
	}
	return map[string]any{
		"type":    "stdio",
		"command": "npx",
		"args": []string{
			"-y",
			"slack-mcp-server@latest",
			"--transport",
			"stdio",
		},
		"env": env,
	}
}

// Redacted returns a copy with secret token replaced by "***". Used
// by the listing API so the web UI can render "yes, configured"
// without exposing the secret.
func (i Integration) Redacted() Integration {
	out := i
	if out.SlackToken != "" {
		out.SlackToken = redactToken(out.SlackToken)
	}
	return out
}

// redactToken keeps the first 5 chars (xoxp-/xoxb-) so the UI can
// still show the user "which kind of token is set". The rest goes to
// "***". Empty stays empty so the form can render placeholder copy.
func redactToken(t string) string {
	if t == "" {
		return ""
	}
	if len(t) <= 5 {
		return "***"
	}
	return t[:5] + "***"
}

// --- Storage -----------------------------------------------------------

type envelope struct {
	Integrations []Integration `json:"integrations"`
}

// LoadAll returns every persisted integration, sorted by Name. Missing
// file or missing key → empty slice (no error).
func LoadAll() ([]Integration, error) {
	var env envelope
	if err := store.ReadInto(driverKey, &env); err != nil {
		return nil, fmt.Errorf("load integrations: %w", err)
	}
	sortByName(env.Integrations)
	return env.Integrations, nil
}

// FindByID returns the integration with matching id, or false.
func FindByID(id string) (Integration, bool, error) {
	all, err := LoadAll()
	if err != nil {
		return Integration{}, false, err
	}
	for _, i := range all {
		if i.ID == id {
			return i, true, nil
		}
	}
	return Integration{}, false, nil
}

// FindByName returns the integration whose Name matches, or false.
func FindByName(name string) (Integration, bool, error) {
	all, err := LoadAll()
	if err != nil {
		return Integration{}, false, err
	}
	for _, i := range all {
		if i.Name == name {
			return i, true, nil
		}
	}
	return Integration{}, false, nil
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func sortByName(s []Integration) {
	sort.SliceStable(s, func(i, j int) bool { return s[i].Name < s[j].Name })
}

// --- Account injection ------------------------------------------------

// ApplyAllToAccounts splices the current integration set into every
// managed account's .claude.json. Names in `previousNames` but not in
// the current set are stripped — this is how renames/deletes
// propagate. Prefer CreateAndApply / UpdateAndApply / DeleteAndApply
// over this raw entry point: those serialize snapshot + mutate +
// apply under one lock.
func ApplyAllToAccounts(rootSpec string, previousNames []string) error {
	all, err := LoadAll()
	if err != nil {
		return err
	}
	current := map[string]struct{}{}
	for _, i := range all {
		current[i.Name] = struct{}{}
	}

	var errs []error
	for _, n := range previousNames {
		if _, kept := current[n]; kept {
			continue
		}
		if err := store.ApplyStanzaToAllAccounts(rootSpec, n, nil); err != nil {
			errs = append(errs, err)
		}
	}
	for _, i := range all {
		stanza := i.Stanza()
		if err := store.ApplyStanzaToAllAccounts(rootSpec, i.Name, stanza); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}

// CreateAndApply, UpdateAndApply, DeleteAndApply combine the
// snapshot-prev → mutate → apply pipeline under a single lock. Same
// pattern as connections.go — eliminates the race window where two
// handlers could compute their `previousNames` against the same
// baseline and produce divergent applies. The returned `applyErr` is
// non-fatal — the mutation already landed on disk; the caller
// surfaces this as a UI warning.
func CreateAndApply(rootSpec string, in Integration) (saved Integration, applyErr error, mutateErr error) {
	if err := in.Validate(); err != nil {
		return Integration{}, nil, err
	}
	mu.Lock()
	defer mu.Unlock()
	prev, err := loadAllLocked()
	if err != nil {
		return Integration{}, nil, err
	}
	for _, existing := range prev {
		if existing.Name == in.Name {
			return Integration{}, nil, fmt.Errorf("an integration named %q already exists", in.Name)
		}
	}
	in.ID = newID()
	next := append(prev, in)
	if err := store.Write(driverKey, envelope{Integrations: next}); err != nil {
		return Integration{}, nil, fmt.Errorf("write integrations: %w", err)
	}
	return in, applyLocked(rootSpec, namesOf(prev)), nil
}

func UpdateAndApply(rootSpec, id string, in Integration) (saved Integration, applyErr error, mutateErr error) {
	mu.Lock()
	defer mu.Unlock()
	prev, err := loadAllLocked()
	if err != nil {
		return Integration{}, nil, err
	}
	idx := -1
	for i, existing := range prev {
		if existing.ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return Integration{}, nil, fmt.Errorf("integration %q not found", id)
	}
	// Preserve secret sentinel: empty token in the body means "keep
	// the existing one" — UI sends "" for unchanged fields so a
	// rename or toggle-only edit doesn't require re-pasting the
	// token.
	if in.Service == ServiceSlack && strings.TrimSpace(in.SlackToken) == "" {
		in.SlackToken = prev[idx].SlackToken
	}
	in.ID = id
	if err := in.Validate(); err != nil {
		return Integration{}, nil, err
	}
	for i, existing := range prev {
		if i == idx {
			continue
		}
		if existing.Name == in.Name {
			return Integration{}, nil, fmt.Errorf("an integration named %q already exists", in.Name)
		}
	}
	next := make([]Integration, len(prev))
	copy(next, prev)
	next[idx] = in
	if err := store.Write(driverKey, envelope{Integrations: next}); err != nil {
		return Integration{}, nil, fmt.Errorf("write integrations: %w", err)
	}
	return in, applyLocked(rootSpec, namesOf(prev)), nil
}

func DeleteAndApply(rootSpec, id string) (removed Integration, ok bool, applyErr error, mutateErr error) {
	mu.Lock()
	defer mu.Unlock()
	prev, err := loadAllLocked()
	if err != nil {
		return Integration{}, false, nil, err
	}
	for i, existing := range prev {
		if existing.ID != id {
			continue
		}
		next := append(prev[:i:i], prev[i+1:]...)
		if len(next) == 0 {
			if err := store.Delete(driverKey); err != nil {
				return Integration{}, false, nil, fmt.Errorf("delete integrations: %w", err)
			}
		} else {
			if err := store.Write(driverKey, envelope{Integrations: next}); err != nil {
				return Integration{}, false, nil, fmt.Errorf("write integrations: %w", err)
			}
		}
		return existing, true, applyLocked(rootSpec, namesOf(prev)), nil
	}
	return Integration{}, false, nil, nil
}

func loadAllLocked() ([]Integration, error) {
	var env envelope
	if err := store.ReadInto(driverKey, &env); err != nil {
		return nil, fmt.Errorf("load integrations: %w", err)
	}
	sortByName(env.Integrations)
	return env.Integrations, nil
}

func applyLocked(rootSpec string, previousNames []string) error {
	return ApplyAllToAccounts(rootSpec, previousNames)
}

func namesOf(is []Integration) []string {
	return NamesOf(is)
}

// NamesOf returns the names of the given integrations — utility for
// computing the `previousNames` argument of ApplyAllToAccounts.
func NamesOf(is []Integration) []string {
	out := make([]string, 0, len(is))
	for _, i := range is {
		out = append(out, i.Name)
	}
	return out
}
