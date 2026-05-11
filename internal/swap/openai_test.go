package swap

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"claude-monitor/internal/account"
	"claude-monitor/internal/api"
	"claude-monitor/internal/codex"
)

// codexAuthFixture writes a minimal but realistic auth.json into dir.
// accountID and exp let callers vary the identity / expiry so the swap
// + detect-active paths can be tested against multiple accounts.
func codexAuthFixture(t *testing.T, dir, accountID string, exp time.Time) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	body, _ := json.Marshal(map[string]any{
		"sub":   "user_" + accountID,
		"email": accountID + "@example.com",
		"exp":   exp.Unix(),
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": accountID,
			"chatgpt_plan_type":  "pro",
		},
	})
	payload := base64.RawURLEncoding.EncodeToString(body)
	idToken := header + "." + payload + ".sig"
	auth := &codex.AuthJSON{
		Tokens: &codex.Tokens{
			IDToken:      idToken,
			AccessToken:  "access-" + accountID,
			RefreshToken: "refresh-" + accountID,
			AccountID:    accountID,
		},
		AuthMode:    "ChatGPT",
		LastRefresh: time.Now().UTC().Format(time.RFC3339),
	}
	if err := codex.Save(dir, auth); err != nil {
		t.Fatalf("Save: %v", err)
	}
}

func TestExecuteOpenAI_NonDefaultToNonDefault(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	codexDefault := filepath.Join(home, ".codex")
	accFoo := filepath.Join(home, ".codex-foo")
	accBar := filepath.Join(home, ".codex-bar")

	codexAuthFixture(t, codexDefault, "acct_foo", time.Now().Add(time.Hour))
	codexAuthFixture(t, accFoo, "acct_foo", time.Now().Add(time.Hour))
	codexAuthFixture(t, accBar, "acct_bar", time.Now().Add(time.Hour))

	rows := []account.Row{
		{Name: "codex", ConfigDir: codexDefault, Provider: account.ProviderOpenAI, AccountUUID: "acct_foo"},
		{Name: "codex-foo", ConfigDir: accFoo, Provider: account.ProviderOpenAI, AccountUUID: "acct_foo"},
		{Name: "codex-bar", ConfigDir: accBar, Provider: account.ProviderOpenAI, AccountUUID: "acct_bar"},
	}

	if err := Execute(rows, accFoo, accBar); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	// ~/.codex/auth.json should now hold acct_bar's tokens.
	loaded, err := codex.LoadFile(filepath.Join(codexDefault, codex.AuthFileName))
	if err != nil {
		t.Fatalf("Load after swap: %v", err)
	}
	if loaded.Tokens.AccountID != "acct_bar" {
		t.Errorf("AccountID after swap = %q, want acct_bar", loaded.Tokens.AccountID)
	}
	// We didn't park (active wasn't the default ~/.codex dir), so the
	// parking file mustn't exist.
	if _, err := os.Stat(filepath.Join(codexDefault, codexParkedFileName)); err == nil {
		t.Errorf("parking file created for non-default swap")
	}
}

func TestExecuteOpenAI_ParkAndRestoreDefault(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	codexDefault := filepath.Join(home, ".codex")
	accFoo := filepath.Join(home, ".codex-foo")

	// Default starts as acct_default.
	codexAuthFixture(t, codexDefault, "acct_default", time.Now().Add(time.Hour))
	codexAuthFixture(t, accFoo, "acct_foo", time.Now().Add(time.Hour))

	rows := []account.Row{
		{Name: "codex", ConfigDir: codexDefault, Provider: account.ProviderOpenAI, AccountUUID: "acct_default"},
		{Name: "codex-foo", ConfigDir: accFoo, Provider: account.ProviderOpenAI, AccountUUID: "acct_foo"},
	}

	// Swap default → foo. Park file should be written.
	if err := Execute(rows, codexDefault, accFoo); err != nil {
		t.Fatalf("Execute default→foo: %v", err)
	}
	loaded, err := codex.LoadFile(filepath.Join(codexDefault, codex.AuthFileName))
	if err != nil {
		t.Fatalf("Load after first swap: %v", err)
	}
	if loaded.Tokens.AccountID != "acct_foo" {
		t.Errorf("after default→foo, AccountID = %q, want acct_foo", loaded.Tokens.AccountID)
	}
	parkedPath := filepath.Join(codexDefault, codexParkedFileName)
	parked, err := codex.LoadFile(parkedPath)
	if err != nil {
		t.Fatalf("Load parked: %v", err)
	}
	if parked.Tokens.AccountID != "acct_default" {
		t.Errorf("parked AccountID = %q, want acct_default", parked.Tokens.AccountID)
	}

	// Swap foo → default. Should restore from parked and remove the
	// parking file.
	if err := Execute(rows, accFoo, codexDefault); err != nil {
		t.Fatalf("Execute foo→default: %v", err)
	}
	restored, err := codex.LoadFile(filepath.Join(codexDefault, codex.AuthFileName))
	if err != nil {
		t.Fatalf("Load after restore: %v", err)
	}
	if restored.Tokens.AccountID != "acct_default" {
		t.Errorf("after foo→default, AccountID = %q, want acct_default", restored.Tokens.AccountID)
	}
	if _, err := os.Stat(parkedPath); err == nil {
		t.Errorf("parking file should be removed after restore, but it still exists")
	}
}

func TestExecuteOpenAI_CrossProviderRejected(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	codexDir := filepath.Join(home, ".codex-foo")
	codexAuthFixture(t, codexDir, "acct_foo", time.Now().Add(time.Hour))

	rows := []account.Row{
		{Name: "claude", ConfigDir: filepath.Join(home, ".claude"), Provider: account.ProviderAnthropic, RefreshToken: "anth-rt"},
		{Name: "codex-foo", ConfigDir: codexDir, Provider: account.ProviderOpenAI},
	}
	// Active is Claude, target is Codex — Execute must reject.
	err := Execute(rows, filepath.Join(home, ".claude"), codexDir)
	if err == nil {
		t.Fatalf("cross-provider swap unexpectedly succeeded")
	}
}

// TestFetchOneOpenAI_PopulatesUsage exercises the auto-poll path:
// fresh token + happy /wham/usage → row.Usage is populated end-to-end
// without the caller having to ask. This is the contract the dashboard
// depends on for the 60-second refresh tick.
func TestFetchOneOpenAI_PopulatesUsage(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".codex-foo")
	codexAuthFixture(t, dir, "acct_foo", time.Now().Add(time.Hour))

	resetAt := time.Now().Add(2 * time.Hour)
	origFetch := fetchCodexUsage
	fetchCodexUsage = func(ctx context.Context, token, accountID string) (*api.Usage, error) {
		if token != "access-acct_foo" {
			t.Errorf("fetchCodexUsage token = %q, want access-acct_foo", token)
		}
		if accountID != "acct_foo" {
			t.Errorf("fetchCodexUsage accountID = %q, want acct_foo", accountID)
		}
		return &api.Usage{
			FiveHour: &api.Window{Utilization: 28, ResetsAt: &resetAt},
			SevenDay: &api.Window{Utilization: 4},
		}, nil
	}
	t.Cleanup(func() { fetchCodexUsage = origFetch })

	row := fetchOneOpenAI(context.Background(), account.Account{
		Name:        "codex-foo",
		ConfigDir:   dir,
		Provider:    account.ProviderOpenAI,
		AccountUUID: "acct_foo",
	})
	if row.Err != nil {
		t.Fatalf("row.Err = %v, want nil", row.Err)
	}
	if row.Usage == nil || row.Usage.FiveHour == nil {
		t.Fatalf("row.Usage = %+v, want FiveHour populated", row.Usage)
	}
	if row.Usage.FiveHour.Utilization != 28 {
		t.Errorf("FiveHour.Utilization = %v, want 28", row.Usage.FiveHour.Utilization)
	}
	if row.PlanType != "pro" {
		t.Errorf("PlanType = %q, want pro (from JWT)", row.PlanType)
	}
}

// TestFetchOneOpenAI_UsageRateLimitedSetsErr confirms that a 429 from
// /wham/usage surfaces as row.Err with *api.RateLimitError{Source:"usage"},
// which is the shape the TUI's m.backoff map keys off to arm the
// "retry in Xs" countdown.
func TestFetchOneOpenAI_UsageRateLimitedSetsErr(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".codex-foo")
	codexAuthFixture(t, dir, "acct_foo", time.Now().Add(time.Hour))

	origFetch := fetchCodexUsage
	fetchCodexUsage = func(ctx context.Context, token, accountID string) (*api.Usage, error) {
		return nil, &api.RateLimitError{RetryAfter: 30 * time.Second, Source: "usage"}
	}
	t.Cleanup(func() { fetchCodexUsage = origFetch })

	row := fetchOneOpenAI(context.Background(), account.Account{
		Name: "codex-foo", ConfigDir: dir, Provider: account.ProviderOpenAI, AccountUUID: "acct_foo",
	})
	var rl *api.RateLimitError
	if !errors.As(row.Err, &rl) {
		t.Fatalf("row.Err = %v, want *api.RateLimitError", row.Err)
	}
	if rl.Source != "usage" {
		t.Errorf("Source = %q, want usage", rl.Source)
	}
}

func TestDetectActiveCodexDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	codexDefault := filepath.Join(home, ".codex")
	accFoo := filepath.Join(home, ".codex-foo")

	codexAuthFixture(t, codexDefault, "acct_foo", time.Now().Add(time.Hour))
	codexAuthFixture(t, accFoo, "acct_foo", time.Now().Add(time.Hour))

	rows := []account.Row{
		{Name: "codex", ConfigDir: codexDefault, Provider: account.ProviderOpenAI, AccountUUID: "acct_default"},
		{Name: "codex-foo", ConfigDir: accFoo, Provider: account.ProviderOpenAI, AccountUUID: "acct_foo"},
	}
	got := detectActiveCodexDir(rows)
	if got != accFoo {
		t.Errorf("detectActiveCodexDir = %q, want %q", got, accFoo)
	}

	// No codex rows at all → empty active dir.
	gotEmpty := detectActiveCodexDir([]account.Row{
		{Name: "claude", ConfigDir: filepath.Join(home, ".claude"), Provider: account.ProviderAnthropic},
	})
	if gotEmpty != "" {
		t.Errorf("no codex rows: got %q, want empty", gotEmpty)
	}
}
