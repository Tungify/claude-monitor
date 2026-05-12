// Package connections manages claude-monitor's DB MCP connection
// registry. The user adds named, driver-typed connections (postgres
// or clickhouse) and each one becomes an entry in every managed
// account's .claude.json mcpServers map plus a stanza spread into
// orchestrator-spawned Claude Agent SDK sessions.
//
// `name` is the *MCP server name* the model sees — tools surface as
// `mcp__<name>__execute_sql` (postgres) or `mcp__<name>__run_query`
// (clickhouse). Validated to a strict charset so the SDK's
// double-underscore FQN flattening never produces an ambiguous tool
// name.
//
// Read-only is delegated to the upstream MCP servers:
//   - postgres-mcp runs with --access-mode=restricted (READ ONLY tx +
//     pglast AST guard against ROLLBACK/DROP injection),
//   - mcp-clickhouse defaults CLICKHOUSE_ALLOW_WRITE_ACCESS=false and
//     rejects DML/DDL at the tool layer. We never set the flag.
package connections

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"claude-monitor/internal/mcp/store"
)

// mu serializes the entire load-modify-write cycle for connections.
// Without it, two concurrent /api/mcp/connections POSTs would both
// read the same baseline, append their own entry, and the second
// writer would clobber the first. The mutation surface is small
// (O(10) entries per user, a handful of writes per session) so a
// single global mutex is the right granularity.
var mu sync.Mutex

// Driver enumerates the supported upstream MCP servers. New drivers
// require: a Stanza branch, a Validate branch, a test-spawn branch
// in the server handler, and a chat-UI tool-name suffix recogniser.
type Driver string

const (
	DriverPostgres   Driver = "postgres"
	DriverClickHouse Driver = "clickhouse"
	DriverRedis      Driver = "redis"
)

// Connection is one user-configured DB MCP server. Field set is the
// union of both drivers' configs; per-driver Validate enforces which
// fields apply.
type Connection struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Driver Driver `json:"driver"`

	// Disabled lets the user park a connection without deleting it
	// — keeps the URI/password on disk for re-enable while stripping
	// the stanza from every account's .claude.json and skipping it
	// in SDK-spawned sessions. omitempty so legacy records load as
	// enabled by default.
	Disabled bool `json:"disabled,omitempty"`

	// Postgres
	URI string `json:"uri,omitempty"`

	// ClickHouse + Redis (overlapping shape — host/port/user/pwd map
	// cleanly to both protocols).
	Host     string `json:"host,omitempty"`
	Port     int    `json:"port,omitempty"`
	User     string `json:"user,omitempty"`
	Password string `json:"password,omitempty"`
	Database string `json:"database,omitempty"`
	// Secure defaults to true when nil. Pointer so the JSON round-trip
	// preserves "user explicitly disabled". For ClickHouse this is
	// HTTPS; for Redis it's TLS (rediss://).
	Secure *bool `json:"secure,omitempty"`

	// Redis-only: integer DB index (0-15 by default). 0 is the default
	// database and a valid choice, so we use a pointer to distinguish
	// "unset" from "0". When nil, REDIS_DB is omitted from the spawn
	// env and the upstream server falls back to its own default.
	RedisDB *int `json:"redis_db,omitempty"`
}

// driverKey is the top-level key in mcp.json. The legacy single-tier
// shape (`postgres: {...}` / `clickhouse: {...}`) is gone — this is
// a brand-new feature with no users to migrate.
const driverKey = "connections"

// nameRe enforces what the upstream MCP servers + the Agent SDK both
// accept: lowercase letter start, then [a-z0-9_]. Hyphens are
// forbidden because they collide with the SDK's `mcp__<name>__<tool>`
// flattening (hyphens become problematic in some downstream parsers).
var nameRe = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// MaxNameLen caps the user-supplied name. Long names crowd the chat
// UI's tool-call header and inflate every mcpServers stanza we
// inject into accounts.
const MaxNameLen = 48

// Validate performs name + per-driver field checks. Caller should
// also run UniqueName against the existing list to catch duplicates
// (Validate has no view of siblings).
func (c Connection) Validate() error {
	if c.Name == "" {
		return errors.New("name is required")
	}
	if len(c.Name) > MaxNameLen {
		return fmt.Errorf("name too long (max %d)", MaxNameLen)
	}
	if !nameRe.MatchString(c.Name) {
		return errors.New("name must match [a-z][a-z0-9_]* (lowercase, no spaces or hyphens)")
	}
	switch c.Driver {
	case DriverPostgres:
		return validatePostgres(c)
	case DriverClickHouse:
		return validateClickHouse(c)
	case DriverRedis:
		return validateRedis(c)
	default:
		return fmt.Errorf("unknown driver: %q", c.Driver)
	}
}

func validatePostgres(c Connection) error {
	uri := strings.TrimSpace(c.URI)
	if uri == "" {
		return errors.New("uri is required for postgres connections")
	}
	u, err := url.Parse(uri)
	if err != nil {
		return fmt.Errorf("parse uri: %w", err)
	}
	switch u.Scheme {
	case "postgres", "postgresql":
	default:
		return fmt.Errorf("uri scheme must be postgres:// or postgresql://, got %q", u.Scheme)
	}
	if u.Host == "" {
		return errors.New("uri is missing host")
	}
	return nil
}

func validateRedis(c Connection) error {
	if strings.TrimSpace(c.Host) == "" {
		return errors.New("host is required for redis connections")
	}
	if _, _, err := net.SplitHostPort(c.Host + ":0"); err != nil {
		return fmt.Errorf("host: %w", err)
	}
	if c.Port != 0 && (c.Port < 1 || c.Port > 65535) {
		return fmt.Errorf("port out of range: %d", c.Port)
	}
	// Redis DB index: typical max is 15 but the upstream can be
	// configured for more. Cap generously to catch obvious typos
	// without locking out unusual configurations.
	if c.RedisDB != nil && (*c.RedisDB < 0 || *c.RedisDB > 65535) {
		return fmt.Errorf("redis_db out of range: %d", *c.RedisDB)
	}
	return nil
}

func validateClickHouse(c Connection) error {
	if strings.TrimSpace(c.Host) == "" {
		return errors.New("host is required for clickhouse connections")
	}
	if _, _, err := net.SplitHostPort(c.Host + ":0"); err != nil {
		return fmt.Errorf("host: %w", err)
	}
	if strings.TrimSpace(c.User) == "" {
		return errors.New("user is required for clickhouse connections")
	}
	if c.Port != 0 && (c.Port < 1 || c.Port > 65535) {
		return fmt.Errorf("port out of range: %d", c.Port)
	}
	return nil
}

// Stanza emits the mcpServers entry for this connection. Returns nil
// when the connection isn't materially configured — callers should
// treat nil as "skip this entry / strip any existing".
func (c Connection) Stanza() map[string]any {
	switch c.Driver {
	case DriverPostgres:
		return postgresStanza(c)
	case DriverClickHouse:
		return clickhouseStanza(c)
	case DriverRedis:
		return redisStanza(c)
	}
	return nil
}

func postgresStanza(c Connection) map[string]any {
	if strings.TrimSpace(c.URI) == "" {
		return nil
	}
	// DATABASE_URI lives in env (not args) so `ps` doesn't echo the
	// password.
	return map[string]any{
		"type":    "stdio",
		"command": "uvx",
		"args":    []string{"postgres-mcp", "--access-mode=restricted"},
		"env": map[string]string{
			"DATABASE_URI": c.URI,
		},
	}
}

func clickhouseStanza(c Connection) map[string]any {
	if strings.TrimSpace(c.Host) == "" {
		return nil
	}
	env := map[string]string{
		"CLICKHOUSE_HOST":   c.Host,
		"CLICKHOUSE_USER":   c.User,
		"CLICKHOUSE_SECURE": strconv.FormatBool(secureOrDefault(c.Secure)),
	}
	if c.Password != "" {
		env["CLICKHOUSE_PASSWORD"] = c.Password
	}
	if c.Port != 0 {
		env["CLICKHOUSE_PORT"] = strconv.Itoa(c.Port)
	}
	if c.Database != "" {
		env["CLICKHOUSE_DATABASE"] = c.Database
	}
	return map[string]any{
		"type":    "stdio",
		"command": "uvx",
		"args":    []string{"mcp-clickhouse"},
		"env":     env,
	}
}

// redisStanza emits the mcpServers entry for the canonical
// modelcontextprotocol/server-redis MCP server, spawned via npx.
// Unlike postgres/clickhouse, the upstream server takes its
// connection as a single redis:// URL positional argument — which
// means the password is briefly visible in `ps` while the spawn is
// alive. Acceptable trade-off given the daemon binds loopback-only
// and the same exposure exists for every other consumer of this
// npm package; the alternative (env-var-config Python server) is
// not published to PyPI under a known name.
//
// scheme is `rediss://` when Secure is true (default), `redis://`
// otherwise. The DB index appears as the URL path.
func redisStanza(c Connection) map[string]any {
	if strings.TrimSpace(c.Host) == "" {
		return nil
	}
	return map[string]any{
		"type":    "stdio",
		"command": "npx",
		"args": []string{
			"-y",
			"@modelcontextprotocol/server-redis",
			c.RedisURL(),
		},
		"env": map[string]string{},
	}
}

// RedisURL renders the Connection's Redis params as a redis:// URL
// suitable for the modelcontextprotocol/server-redis CLI. Exposed
// so the test-connection handler can reuse the exact same string
// without re-implementing escaping.
func (c Connection) RedisURL() string {
	scheme := "redis"
	if secureOrDefault(c.Secure) {
		scheme = "rediss"
	}
	u := url.URL{Scheme: scheme}
	if c.Port != 0 {
		u.Host = c.Host + ":" + strconv.Itoa(c.Port)
	} else {
		u.Host = c.Host
	}
	// url.UserPassword handles escaping of `:` and `@` in the
	// password. Empty username + non-empty password yields
	// `:password@host` which is the AUTH-only form Redis treats as
	// `AUTH <password>` (legacy requirepass).
	if c.Password != "" {
		u.User = url.UserPassword(c.User, c.Password)
	} else if c.User != "" {
		u.User = url.User(c.User)
	}
	if c.RedisDB != nil {
		u.Path = "/" + strconv.Itoa(*c.RedisDB)
	}
	return u.String()
}

func secureOrDefault(p *bool) bool {
	if p == nil {
		return true
	}
	return *p
}

// Redacted returns a copy with secrets replaced by "***". Used by
// the listing API so the web UI can show "yes, configured" without
// exposing the secret.
func (c Connection) Redacted() Connection {
	out := c
	if out.Password != "" {
		out.Password = "***"
	}
	if out.URI != "" {
		out.URI = redactURI(out.URI)
	}
	return out
}

func redactURI(uri string) string {
	uri = strings.TrimSpace(uri)
	if uri == "" {
		return ""
	}
	u, err := url.Parse(uri)
	if err != nil {
		return uri
	}
	if u.User == nil {
		return uri
	}
	pass, hasPass := u.User.Password()
	if !hasPass || pass == "" {
		return uri
	}
	at := strings.Index(uri, "@")
	schemeEnd := strings.Index(uri, "://")
	if at < 0 || schemeEnd < 0 || at < schemeEnd {
		return uri
	}
	userStart := schemeEnd + len("://")
	return uri[:userStart] + u.User.Username() + ":***" + uri[at:]
}

// --- Storage -----------------------------------------------------------

type envelope struct {
	Connections []Connection `json:"connections"`
}

// LoadAll returns every persisted connection, sorted by Name (stable
// for UI rendering and account injection diffs). Missing file →
// empty slice (no error).
func LoadAll() ([]Connection, error) {
	var env envelope
	if err := store.ReadInto(driverKey, &env); err != nil {
		return nil, fmt.Errorf("load connections: %w", err)
	}
	sortByName(env.Connections)
	return env.Connections, nil
}

// FindByID returns the connection with matching id, or false.
func FindByID(id string) (Connection, bool, error) {
	all, err := LoadAll()
	if err != nil {
		return Connection{}, false, err
	}
	for _, c := range all {
		if c.ID == id {
			return c, true, nil
		}
	}
	return Connection{}, false, nil
}

// FindByName returns the connection whose Name matches, or false.
// Used by the chat UI's re-run endpoint: the tool FQN names the
// connection, not the id.
func FindByName(name string) (Connection, bool, error) {
	all, err := LoadAll()
	if err != nil {
		return Connection{}, false, err
	}
	for _, c := range all {
		if c.Name == name {
			return c, true, nil
		}
	}
	return Connection{}, false, nil
}

// Create persists a new connection with a fresh ID and returns the
// stored record. Validates name + uniqueness before write.
func Create(c Connection) (Connection, error) {
	if err := c.Validate(); err != nil {
		return Connection{}, err
	}
	mu.Lock()
	defer mu.Unlock()
	all, err := LoadAll()
	if err != nil {
		return Connection{}, err
	}
	for _, existing := range all {
		if existing.Name == c.Name {
			return Connection{}, fmt.Errorf("a connection named %q already exists", c.Name)
		}
	}
	c.ID = newID()
	all = append(all, c)
	if err := store.Write(driverKey, envelope{Connections: all}); err != nil {
		return Connection{}, fmt.Errorf("write connections: %w", err)
	}
	return c, nil
}

// Update overwrites the connection identified by `id`. If `c.Password`
// is empty AND the driver is clickhouse, the existing password is
// preserved (the UI uses "" as a sentinel for "unchanged"). Same
// for URI on postgres — empty input means "keep existing".
func Update(id string, c Connection) (Connection, error) {
	mu.Lock()
	defer mu.Unlock()
	all, err := LoadAll()
	if err != nil {
		return Connection{}, err
	}
	var idx = -1
	for i, existing := range all {
		if existing.ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return Connection{}, fmt.Errorf("connection %q not found", id)
	}
	// Preserve sentinels: empty secret in body == "keep existing".
	if c.Driver == DriverPostgres && c.URI == "" {
		c.URI = all[idx].URI
	}
	if c.Driver == DriverClickHouse && c.Password == "" {
		c.Password = all[idx].Password
	}
	if c.Driver == DriverRedis && c.Password == "" {
		c.Password = all[idx].Password
	}
	c.ID = id
	if err := c.Validate(); err != nil {
		return Connection{}, err
	}
	for i, existing := range all {
		if i == idx {
			continue
		}
		if existing.Name == c.Name {
			return Connection{}, fmt.Errorf("a connection named %q already exists", c.Name)
		}
	}
	all[idx] = c
	if err := store.Write(driverKey, envelope{Connections: all}); err != nil {
		return Connection{}, fmt.Errorf("write connections: %w", err)
	}
	return c, nil
}

// Delete removes the connection identified by `id`. Returns the
// removed record so the caller can strip its stanza by name. Returns
// (zero, false) if no match.
func Delete(id string) (Connection, bool, error) {
	mu.Lock()
	defer mu.Unlock()
	all, err := LoadAll()
	if err != nil {
		return Connection{}, false, err
	}
	for i, c := range all {
		if c.ID != id {
			continue
		}
		next := append(all[:i:i], all[i+1:]...)
		if len(next) == 0 {
			if err := store.Delete(driverKey); err != nil {
				return Connection{}, false, fmt.Errorf("delete connections: %w", err)
			}
			return c, true, nil
		}
		if err := store.Write(driverKey, envelope{Connections: next}); err != nil {
			return Connection{}, false, fmt.Errorf("write connections: %w", err)
		}
		return c, true, nil
	}
	return Connection{}, false, nil
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	// We don't need a strict UUIDv4 — collision is uninteresting in a
	// per-user mcp.json with O(10) entries. A 32-hex string keys the
	// store and the UI; that's it.
	return hex.EncodeToString(b[:])
}

func sortByName(s []Connection) {
	sort.SliceStable(s, func(i, j int) bool { return s[i].Name < s[j].Name })
}

// --- Account injection ------------------------------------------------

// ApplyAllToAccounts splices the current connection set into every
// managed account's .claude.json. Compares against the previous set
// to know which names to strip when a connection is renamed or
// removed.
//
// `previousNames` is the snapshot of names that existed BEFORE the
// mutation that triggered this apply. Names in previousNames but not
// in the current set are stripped from each account.
//
// Prefer the higher-level CreateAndApply / UpdateAndApply /
// DeleteAndApply wrappers when possible — they snapshot + mutate +
// apply under a single lock and produce a tighter race window.
func ApplyAllToAccounts(rootSpec string, previousNames []string) error {
	all, err := LoadAll()
	if err != nil {
		return err
	}
	currentNames := map[string]struct{}{}
	for _, c := range all {
		currentNames[c.Name] = struct{}{}
	}

	var errs []error
	// Strip removed/renamed.
	for _, n := range previousNames {
		if _, kept := currentNames[n]; kept {
			continue
		}
		if err := store.ApplyStanzaToAllAccounts(rootSpec, n, nil); err != nil {
			errs = append(errs, err)
		}
	}
	// Add/refresh current. Disabled = strip from every account; the
	// record stays on disk so re-enable doesn't require re-entering
	// the password / URI.
	for _, c := range all {
		var stanza map[string]any
		if !c.Disabled {
			stanza = c.Stanza()
		}
		if err := store.ApplyStanzaToAllAccounts(rootSpec, c.Name, stanza); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}

// CreateAndApply, UpdateAndApply, DeleteAndApply combine the
// snapshot-prev → mutate → apply pipeline under a single lock. This
// eliminates the race window where two handlers could compute their
// `previousNames` against the same baseline and produce divergent
// applies. The returned `applyErr` is non-fatal — the mutation
// already landed on disk; the caller surfaces this as a UI warning.
func CreateAndApply(rootSpec string, c Connection) (saved Connection, applyErr error, mutateErr error) {
	if err := c.Validate(); err != nil {
		return Connection{}, nil, err
	}
	mu.Lock()
	defer mu.Unlock()
	prev, err := loadAllLocked()
	if err != nil {
		return Connection{}, nil, err
	}
	for _, existing := range prev {
		if existing.Name == c.Name {
			return Connection{}, nil, fmt.Errorf("a connection named %q already exists", c.Name)
		}
	}
	c.ID = newID()
	next := append(prev, c)
	if err := store.Write(driverKey, envelope{Connections: next}); err != nil {
		return Connection{}, nil, fmt.Errorf("write connections: %w", err)
	}
	return c, applyLocked(rootSpec, namesOf(prev)), nil
}

func UpdateAndApply(rootSpec, id string, c Connection) (saved Connection, applyErr error, mutateErr error) {
	mu.Lock()
	defer mu.Unlock()
	prev, err := loadAllLocked()
	if err != nil {
		return Connection{}, nil, err
	}
	idx := -1
	for i, existing := range prev {
		if existing.ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return Connection{}, nil, fmt.Errorf("connection %q not found", id)
	}
	if c.Driver == DriverPostgres && c.URI == "" {
		c.URI = prev[idx].URI
	}
	if c.Driver == DriverClickHouse && c.Password == "" {
		c.Password = prev[idx].Password
	}
	if c.Driver == DriverRedis && c.Password == "" {
		c.Password = prev[idx].Password
	}
	c.ID = id
	if err := c.Validate(); err != nil {
		return Connection{}, nil, err
	}
	for i, existing := range prev {
		if i == idx {
			continue
		}
		if existing.Name == c.Name {
			return Connection{}, nil, fmt.Errorf("a connection named %q already exists", c.Name)
		}
	}
	next := make([]Connection, len(prev))
	copy(next, prev)
	next[idx] = c
	if err := store.Write(driverKey, envelope{Connections: next}); err != nil {
		return Connection{}, nil, fmt.Errorf("write connections: %w", err)
	}
	return c, applyLocked(rootSpec, namesOf(prev)), nil
}

func DeleteAndApply(rootSpec, id string) (removed Connection, ok bool, applyErr error, mutateErr error) {
	mu.Lock()
	defer mu.Unlock()
	prev, err := loadAllLocked()
	if err != nil {
		return Connection{}, false, nil, err
	}
	for i, c := range prev {
		if c.ID != id {
			continue
		}
		next := append(prev[:i:i], prev[i+1:]...)
		if len(next) == 0 {
			if err := store.Delete(driverKey); err != nil {
				return Connection{}, false, nil, fmt.Errorf("delete connections: %w", err)
			}
		} else {
			if err := store.Write(driverKey, envelope{Connections: next}); err != nil {
				return Connection{}, false, nil, fmt.Errorf("write connections: %w", err)
			}
		}
		return c, true, applyLocked(rootSpec, namesOf(prev)), nil
	}
	return Connection{}, false, nil, nil
}

// ToggleAndApply flips the Disabled flag on the connection with the
// given id and re-applies the full set to every managed account.
// Same lock + non-fatal applyErr semantics as the other *AndApply
// helpers.
func ToggleAndApply(rootSpec, id string) (saved Connection, applyErr error, mutateErr error) {
	mu.Lock()
	defer mu.Unlock()
	prev, err := loadAllLocked()
	if err != nil {
		return Connection{}, nil, err
	}
	idx := -1
	for i, existing := range prev {
		if existing.ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		return Connection{}, nil, fmt.Errorf("connection %q not found", id)
	}
	next := make([]Connection, len(prev))
	copy(next, prev)
	next[idx].Disabled = !next[idx].Disabled
	if err := store.Write(driverKey, envelope{Connections: next}); err != nil {
		return Connection{}, nil, fmt.Errorf("write connections: %w", err)
	}
	return next[idx], applyLocked(rootSpec, namesOf(prev)), nil
}

// loadAllLocked is the mutex-naive read used by *AndApply helpers
// (they hold `mu` already). External callers use LoadAll().
func loadAllLocked() ([]Connection, error) {
	var env envelope
	if err := store.ReadInto(driverKey, &env); err != nil {
		return nil, fmt.Errorf("load connections: %w", err)
	}
	sortByName(env.Connections)
	return env.Connections, nil
}

func applyLocked(rootSpec string, previousNames []string) error {
	return ApplyAllToAccounts(rootSpec, previousNames)
}

func namesOf(cs []Connection) []string {
	return NamesOf(cs)
}

// NamesOf returns the names of the given connections — utility for
// computing the `previousNames` argument of ApplyAllToAccounts.
func NamesOf(cs []Connection) []string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.Name)
	}
	return out
}
