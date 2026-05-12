package connections

import (
	"runtime"
	"strings"
	"testing"
)

func setupHome(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", dir)
	}
}

func ptrBool(b bool) *bool { return &b }

func TestValidate_NameRules(t *testing.T) {
	cases := []struct {
		name    string
		conn    Connection
		wantErr bool
	}{
		{"empty name", Connection{Driver: DriverPostgres, URI: "postgres://h"}, true},
		{"uppercase forbidden", Connection{Name: "Prod", Driver: DriverPostgres, URI: "postgres://h"}, true},
		{"hyphen forbidden", Connection{Name: "prod-db", Driver: DriverPostgres, URI: "postgres://h"}, true},
		{"leading digit forbidden", Connection{Name: "1prod", Driver: DriverPostgres, URI: "postgres://h"}, true},
		{"underscore ok", Connection{Name: "prod_db", Driver: DriverPostgres, URI: "postgres://h"}, false},
		{"trailing digits ok", Connection{Name: "prod1", Driver: DriverPostgres, URI: "postgres://h"}, false},
		{"unknown driver", Connection{Name: "ok", Driver: "mysql"}, true},
		{"too long", Connection{Name: strings.Repeat("a", MaxNameLen+1), Driver: DriverPostgres, URI: "postgres://h"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.conn.Validate()
			if (err != nil) != tc.wantErr {
				t.Fatalf("Validate err=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestValidate_DriverFields(t *testing.T) {
	t.Run("postgres needs uri", func(t *testing.T) {
		if err := (Connection{Name: "p", Driver: DriverPostgres}).Validate(); err == nil {
			t.Fatalf("expected error for missing URI")
		}
	})
	t.Run("postgres bad scheme", func(t *testing.T) {
		if err := (Connection{Name: "p", Driver: DriverPostgres, URI: "http://h/d"}).Validate(); err == nil {
			t.Fatalf("expected error for http scheme")
		}
	})
	t.Run("clickhouse needs host+user", func(t *testing.T) {
		if err := (Connection{Name: "c", Driver: DriverClickHouse, Host: "h"}).Validate(); err == nil {
			t.Fatalf("expected error for missing user")
		}
		if err := (Connection{Name: "c", Driver: DriverClickHouse, User: "u"}).Validate(); err == nil {
			t.Fatalf("expected error for missing host")
		}
	})
	t.Run("clickhouse port range", func(t *testing.T) {
		if err := (Connection{Name: "c", Driver: DriverClickHouse, Host: "h", User: "u", Port: 70000}).Validate(); err == nil {
			t.Fatalf("expected error for port out of range")
		}
	})
}

func TestStanza_Postgres(t *testing.T) {
	c := Connection{Name: "warehouse", Driver: DriverPostgres, URI: "postgres://alice:pw@h:5432/db"}
	s := c.Stanza()
	if s["command"] != "uvx" {
		t.Fatalf("command: %v", s["command"])
	}
	args, _ := s["args"].([]string)
	if len(args) < 2 || args[0] != "postgres-mcp" || !strings.Contains(args[1], "restricted") {
		t.Fatalf("unexpected args: %v", args)
	}
	env, _ := s["env"].(map[string]string)
	if env["DATABASE_URI"] != c.URI {
		t.Fatalf("DATABASE_URI: %q", env["DATABASE_URI"])
	}
}

func TestStanza_ClickHouse(t *testing.T) {
	c := Connection{
		Name: "analytics", Driver: DriverClickHouse,
		Host: "h.example", Port: 8443, User: "default", Password: "secret",
		Database: "app", Secure: ptrBool(true),
	}
	s := c.Stanza()
	env, _ := s["env"].(map[string]string)
	for k, want := range map[string]string{
		"CLICKHOUSE_HOST":     "h.example",
		"CLICKHOUSE_USER":     "default",
		"CLICKHOUSE_PASSWORD": "secret",
		"CLICKHOUSE_PORT":     "8443",
		"CLICKHOUSE_DATABASE": "app",
		"CLICKHOUSE_SECURE":   "true",
	} {
		if env[k] != want {
			t.Errorf("env[%s]=%q want %q", k, env[k], want)
		}
	}
}

func TestStanza_ClickHouseSecureDefault(t *testing.T) {
	c := Connection{Name: "a", Driver: DriverClickHouse, Host: "h", User: "u"}
	s := c.Stanza()
	env := s["env"].(map[string]string)
	if env["CLICKHOUSE_SECURE"] != "true" {
		t.Fatalf("nil Secure should default to true, got %q", env["CLICKHOUSE_SECURE"])
	}
}

func TestRedacted_StripsSecrets(t *testing.T) {
	c := Connection{
		Name: "n", Driver: DriverPostgres,
		URI: "postgres://alice:hunter2@h:5432/db",
	}
	r := c.Redacted()
	if strings.Contains(r.URI, "hunter2") {
		t.Fatalf("redacted leaked password: %q", r.URI)
	}
	if !strings.Contains(r.URI, "alice") {
		t.Fatalf("redacted lost username: %q", r.URI)
	}
	if !strings.Contains(r.URI, "***") {
		t.Fatalf("redacted didn't mask: %q", r.URI)
	}

	ch := Connection{Name: "c", Driver: DriverClickHouse, Host: "h", User: "u", Password: "p"}
	rr := ch.Redacted()
	if rr.Password != "***" {
		t.Fatalf("expected ***, got %q", rr.Password)
	}
}

func TestCreateUpdateDeleteRoundTrip(t *testing.T) {
	setupHome(t)

	a, err := Create(Connection{Name: "warehouse", Driver: DriverPostgres, URI: "postgres://u:p@h/db"})
	if err != nil {
		t.Fatalf("create a: %v", err)
	}
	if a.ID == "" {
		t.Fatalf("expected id assigned")
	}
	b, err := Create(Connection{Name: "analytics", Driver: DriverClickHouse, Host: "h", User: "u", Password: "pw"})
	if err != nil {
		t.Fatalf("create b: %v", err)
	}

	all, err := LoadAll()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("expected 2, got %d", len(all))
	}
	// Sort-by-name: analytics before warehouse.
	if all[0].Name != "analytics" || all[1].Name != "warehouse" {
		t.Fatalf("unexpected sort order: %+v", all)
	}

	// Rename a, change URI, secret preserved via empty sentinel.
	a.Name = "warehouse_v2"
	updated, err := Update(a.ID, Connection{
		ID: a.ID, Name: a.Name, Driver: DriverPostgres, URI: a.URI,
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.URI != a.URI {
		t.Fatalf("URI changed unexpectedly: %q", updated.URI)
	}

	// Duplicate-name guard.
	if _, err := Update(a.ID, Connection{Name: "analytics", Driver: DriverPostgres, URI: a.URI}); err == nil {
		t.Fatalf("expected duplicate-name error")
	}

	// FindByName resolves the renamed entry.
	if got, ok, err := FindByName("warehouse_v2"); err != nil || !ok || got.ID != a.ID {
		t.Fatalf("FindByName: ok=%v err=%v got=%+v", ok, err, got)
	}

	// Delete b, file still has a; delete a, file gone.
	if _, _, err := Delete(b.ID); err != nil {
		t.Fatalf("delete b: %v", err)
	}
	left, _ := LoadAll()
	if len(left) != 1 || left[0].Name != "warehouse_v2" {
		t.Fatalf("after delete b: %+v", left)
	}
	if _, _, err := Delete(a.ID); err != nil {
		t.Fatalf("delete a: %v", err)
	}
	final, _ := LoadAll()
	if len(final) != 0 {
		t.Fatalf("expected empty, got %+v", final)
	}
}

func TestUpdate_PreservesSecretsOnEmpty(t *testing.T) {
	setupHome(t)

	pg, err := Create(Connection{Name: "p", Driver: DriverPostgres, URI: "postgres://u:secret@h/db"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Empty URI on update == keep the existing one.
	updated, err := Update(pg.ID, Connection{Name: "p", Driver: DriverPostgres, URI: ""})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if !strings.Contains(updated.URI, "secret") {
		t.Fatalf("expected URI preserved, got %q", updated.URI)
	}

	ch, err := Create(Connection{Name: "c", Driver: DriverClickHouse, Host: "h", User: "u", Password: "shh"})
	if err != nil {
		t.Fatalf("create ch: %v", err)
	}
	chUpd, err := Update(ch.ID, Connection{Name: "c", Driver: DriverClickHouse, Host: "h2", User: "u", Password: ""})
	if err != nil {
		t.Fatalf("update ch: %v", err)
	}
	if chUpd.Password != "shh" {
		t.Fatalf("expected password preserved, got %q", chUpd.Password)
	}
	if chUpd.Host != "h2" {
		t.Fatalf("host should update: %q", chUpd.Host)
	}
}

func TestCreate_DuplicateName(t *testing.T) {
	setupHome(t)
	if _, err := Create(Connection{Name: "p", Driver: DriverPostgres, URI: "postgres://h"}); err != nil {
		t.Fatalf("create 1: %v", err)
	}
	if _, err := Create(Connection{Name: "p", Driver: DriverPostgres, URI: "postgres://h"}); err == nil {
		t.Fatalf("expected duplicate-name error")
	}
}

func TestToggle_FlipsDisabledFlag(t *testing.T) {
	setupHome(t)
	saved, applyErr, mErr := CreateAndApply("", Connection{
		Name:   "p",
		Driver: DriverPostgres,
		URI:    "postgres://u:p@h:5432/db",
	})
	if mErr != nil {
		t.Fatalf("create: %v", mErr)
	}
	_ = applyErr
	if saved.Disabled {
		t.Fatalf("new connection should not start disabled")
	}
	flipped, _, mErr := ToggleAndApply("", saved.ID)
	if mErr != nil {
		t.Fatalf("toggle: %v", mErr)
	}
	if !flipped.Disabled {
		t.Fatalf("expected disabled=true after first toggle")
	}
	if flipped.URI != "postgres://u:p@h:5432/db" {
		t.Fatalf("toggle clobbered secret URI: %q", flipped.URI)
	}
	flippedBack, _, mErr := ToggleAndApply("", saved.ID)
	if mErr != nil {
		t.Fatalf("toggle back: %v", mErr)
	}
	if flippedBack.Disabled {
		t.Fatalf("expected disabled=false after second toggle")
	}
}

func TestLoadAllMissingFile(t *testing.T) {
	setupHome(t)
	all, err := LoadAll()
	if err != nil {
		t.Fatalf("LoadAll on missing: %v", err)
	}
	if len(all) != 0 {
		t.Fatalf("expected empty, got %+v", all)
	}
}

func TestValidate_Redis(t *testing.T) {
	cases := []struct {
		name    string
		conn    Connection
		wantErr bool
	}{
		{"missing host", Connection{Name: "r", Driver: DriverRedis}, true},
		{"host only ok", Connection{Name: "r", Driver: DriverRedis, Host: "h"}, false},
		{"port out of range", Connection{Name: "r", Driver: DriverRedis, Host: "h", Port: 70000}, true},
		{"db negative", Connection{Name: "r", Driver: DriverRedis, Host: "h", RedisDB: intPtr(-1)}, true},
		{"db ok", Connection{Name: "r", Driver: DriverRedis, Host: "h", RedisDB: intPtr(0)}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.conn.Validate()
			if (err != nil) != tc.wantErr {
				t.Fatalf("Validate err=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestStanza_Redis(t *testing.T) {
	c := Connection{
		Name: "cache", Driver: DriverRedis,
		Host: "r.example", Port: 6380, User: "default", Password: "shh",
		RedisDB: intPtr(2), Secure: ptrBool(true),
	}
	s := c.Stanza()
	if s["command"] != "npx" {
		t.Fatalf("command: %v", s["command"])
	}
	args, _ := s["args"].([]string)
	if len(args) != 3 || args[0] != "-y" || args[1] != "@modelcontextprotocol/server-redis" {
		t.Fatalf("unexpected args: %v", args)
	}
	if args[2] != "rediss://default:shh@r.example:6380/2" {
		t.Fatalf("redis url: %q", args[2])
	}
}

func TestRedisURL_Variants(t *testing.T) {
	cases := []struct {
		name string
		conn Connection
		want string
	}{
		{
			"insecure no auth",
			Connection{Driver: DriverRedis, Host: "h", Secure: ptrBool(false)},
			"redis://h",
		},
		{
			"password-only legacy",
			Connection{Driver: DriverRedis, Host: "h", Password: "pw", Secure: ptrBool(false)},
			"redis://:pw@h",
		},
		{
			"user only",
			Connection{Driver: DriverRedis, Host: "h", User: "alice", Secure: ptrBool(false)},
			"redis://alice@h",
		},
		{
			"with db index zero",
			Connection{Driver: DriverRedis, Host: "h", RedisDB: intPtr(0), Secure: ptrBool(false)},
			"redis://h/0",
		},
		{
			"port + tls default",
			Connection{Driver: DriverRedis, Host: "r.cloud", Port: 6380, User: "u", Password: "p"},
			"rediss://u:p@r.cloud:6380",
		},
		{
			"password with special chars",
			Connection{Driver: DriverRedis, Host: "h", Password: "p@ss:1/2", Secure: ptrBool(false)},
			"redis://:p%40ss%3A1%2F2@h",
		},
		{
			// Subset matters: !*'() are RFC 3986 sub-delims that
			// encodeURIComponent leaves alone but Go's net/url escapes.
			// The TS-side buildRedisURL has a hand-rolled encoder that
			// MUST match this output byte-for-byte.
			"password with sub-delims",
			Connection{Driver: DriverRedis, Host: "h", Password: "p!*'()", Secure: ptrBool(false)},
			"redis://:p%21%2A%27%28%29@h",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.conn.RedisURL()
			if got != tc.want {
				t.Fatalf("RedisURL: got %q want %q", got, tc.want)
			}
		})
	}
}

func TestRedis_PreservesPasswordOnUpdate(t *testing.T) {
	setupHome(t)
	r, err := Create(Connection{Name: "r", Driver: DriverRedis, Host: "h", Password: "secret"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	upd, err := Update(r.ID, Connection{Name: "r", Driver: DriverRedis, Host: "h2", Password: ""})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if upd.Password != "secret" {
		t.Fatalf("password not preserved: %q", upd.Password)
	}
	if upd.Host != "h2" {
		t.Fatalf("host should update: %q", upd.Host)
	}
}

func intPtr(i int) *int { return &i }

func TestNamesOf(t *testing.T) {
	cs := []Connection{{Name: "a"}, {Name: "b"}, {Name: "c"}}
	got := NamesOf(cs)
	if len(got) != 3 || got[0] != "a" || got[2] != "c" {
		t.Fatalf("NamesOf: %v", got)
	}
}
