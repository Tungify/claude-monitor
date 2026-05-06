# claude-analytic

A Go CLI that reports exact usage % (5h / weekly / Sonnet weekly) for **multiple Claude Code accounts in parallel** on a single screen — same data source as `/usage` inside Claude Code (calls `GET /api/oauth/usage`).

```
claude-analytic /usage  —  2026-05-06 13:32:41

ACCOUNT             5H USAGE                       RESETS    WEEK                          RESETS   SONNET WK  OPUS WK
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
acc-be-1            92% ███████████████████████░░  in 1h37m   8% ██░░░░░░░░░░░░░░░░░░░░░░░  in 2d10h   0%        —
acc-be-2            96% ████████████████████████░  in 1h07m  14% ███░░░░░░░░░░░░░░░░░░░░░░  in 3d1h    —         —
acc-be-3           100% █████████████████████████  in 1h07m  14% ███░░░░░░░░░░░░░░░░░░░░░░  in 5d9h    —         —
acc-data            41% ██████████░░░░░░░░░░░░░░░  in 47m    20% █████░░░░░░░░░░░░░░░░░░░░  in 5d16h   —         —
acc-fe-1             8% ██░░░░░░░░░░░░░░░░░░░░░░░  in 27m     6% █░░░░░░░░░░░░░░░░░░░░░░░░  in 1d19h   0%        —
acc-tester          51% ████████████░░░░░░░░░░░░░  in 2h07m   7% █░░░░░░░░░░░░░░░░░░░░░░░░  in 4d5h    —         —
acc-shared          HTTP 403: OAuth not allowed for org…
acc-personal        token expired (run `claude` once to refresh)
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
PEAK across 6 account(s):  5h 100%   weekly  20%
```

## Use case

You run multiple Claude Code accounts in parallel via aliases:

```sh
alias claude-acc-be-1="CLAUDE_CONFIG_DIR=~/.claude-account/acc-be-1 claude"
alias claude-acc-be-2="CLAUDE_CONFIG_DIR=~/.claude-account/acc-be-2 claude"
# ...
```

The tool scans every `~/.claude-account/*`, pulls each account's OAuth token from the macOS Keychain, calls Anthropic's `/api/oauth/usage` endpoint, and prints usage % plus reset times for every account — no tokens spent, no re-login required.

## Requirements

- macOS (needs the `security` CLI to read the Keychain — Linux/Windows not supported yet)
- Go 1.22+
- `make` (optional)
- Logged in at least once per account (`CLAUDE_CONFIG_DIR=... claude`) — Claude Code stores the token in the Keychain automatically

## Build & install

```sh
make build              # -> ./bin/claude-analytic (ad-hoc codesigned)
make install            # -> $HOME/bin/claude-analytic
make install INSTALL_DIR=/usr/local/bin
```

## Usage

### Snapshot mode (default)

```sh
claude-analytic                      # print exact usage % per account, then exit
claude-analytic --no-color           # disable ANSI color (for pipe / log)
claude-analytic --bar 35             # change bar width (default 25)
claude-analytic --root ~/.cfg-dir    # change root (default ~/.claude-account)
```

Output:
- `5H USAGE` / `WEEK` columns: % with a colored bar (green < 70%, yellow 70-89%, red ≥ 90%)
- `RESETS` column: time remaining until the window resets (yellow if < 1 hour)
- `SONNET WK` / `OPUS WK` columns: per-model weekly % (null when the plan doesn't track them separately)
- `PEAK` row: max 5h / weekly across all successfully fetched accounts
- Per-account errors: `token expired` → re-login; `HTTP 403` → org disallows OAuth (use an API key)

### Live mode (legacy)

Tracks cumulative tokens from local JSONL transcripts, continuously refreshing — does not call the API, costs no tokens.

```sh
claude-analytic --live               # refresh every 2s, includes estimated $ column
claude-analytic --live --interval 5s
claude-analytic --live --no-cost
claude-analytic --live --max-cwd 60
```

Press `Ctrl-C` to exit live mode.

## How it works

### Snapshot mode

```
~/.claude-account/<name>/
└─ .claude.json (contains the account email for display)

macOS Keychain:
└─ "Claude Code-credentials-<sha256(abs_path)[:8]>"
   { "claudeAiOauth": { "accessToken": "sk-ant-oat01-…", "expiresAt": <ms> } }
```

1. Scan `~/.claude-account/*` → list of accounts
2. For each account: compute `sha256(absolute_path_no_trailing_slash)[:8]` → service name in the Keychain
3. Read the token via `security find-generic-password`, check `expiresAt`
4. Call `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`
5. Parse JSON `{five_hour, seven_day, seven_day_sonnet, seven_day_opus, ...}` and render the table

All requests run in parallel → 9 accounts complete in < 1s.

### Live mode (legacy)

Parses `projects/*/<sid>.jsonl` (incremental, cached by mtime/offset) and aggregates tokens over sliding 5h/24h/7d windows. Detects active sessions via `sessions/<pid>.json` + signal-0 PID liveness.

## Source layout

```
main.go             cli flags, dispatch between snapshot and --live
snapshot.go         discover accounts, parallel fetch, build rows
snapshot_render.go  ANSI table for snapshot mode
keychain.go         sha256[:8] hash -> service name -> security CLI -> OAuth creds
api.go              HTTP client + decoder for /api/oauth/usage response

monitor.go          (live mode) discover + aggregate stats
parse.go            (live mode) JSONL parser with mtime/offset cache
pricing.go          (live mode) per-1M-token rates for opus/sonnet/haiku
render.go           (live mode) ANSI table
format.go           shared helpers: token formatting K/M/B, relative time
```

No dependencies outside the standard library.

## Security

The tool does not store, log, or send tokens anywhere except over HTTPS to `api.anthropic.com`. Tokens are read directly from the Keychain via the `security` CLI on every run (Touch ID / password may be required depending on the entry's ACL).

The `/api/oauth/usage` endpoint is internal to Claude Code (not in Anthropic's public docs). Its format/URL may change in future releases — if it breaks, debug with `claude --debug api 2> log` and then `grep oauth/usage log`.

## Make targets

```sh
make help
```

| Target | Description |
|---|---|
| `build` | Build the binary into `./bin/claude-analytic` (ad-hoc codesigned on darwin) |
| `run` | Build + run snapshot |
| `install` | Copy the binary to `$INSTALL_DIR` (default `~/bin`) |
| `release` | Cross-compile darwin/linux × amd64/arm64 |
| `fmt` / `vet` / `tidy` | gofmt / go vet / go mod tidy |
| `clean` | Remove `./bin/` |

## Limitations

- **macOS only**: the code depends on the `security` CLI to read the Keychain. Linux would need libsecret or D-Bus — not implemented yet.
- **Undocumented endpoint**: `/api/oauth/usage` may change without notice. When it does, debug with `claude --debug api`.
- **Token expiry**: the tool does not refresh tokens. When expired, run `CLAUDE_CONFIG_DIR=... claude` once to refresh, or implement the refresh flow (token endpoint: `/v1/oauth/token` with `grant_type=refresh_token`).
- **OAuth disabled for org**: returns 403 with `"OAuth authentication is currently not allowed for this organization"`. That account must use an API key instead of OAuth — not a tool bug.
