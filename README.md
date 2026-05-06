# claude-monitor

A real-time terminal dashboard for **multiple Claude Code accounts at once**, sharing the same data source as `/usage` inside Claude Code (`GET /api/oauth/usage`). Refreshes itself, persists settings, and can auto-kick a fresh 5h window when an account hits 0%.

```
 claude-monitor   refreshed 4s ago   next in 56s   accounts: 8

 ACCOUNT             5H                              RESETS      WEEKLY                          RESETS      SONNET WK  OPUS WK
 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 acc-be-1            92% ███████████████████████░░  in 1h37m     8% ██░░░░░░░░░░░░░░░░░░░░░░░  in 2d10h     0%        —
 acc-be-2            96% ████████████████████████░  in 1h07m    14% ███░░░░░░░░░░░░░░░░░░░░░░  in 3d1h      —         —
 acc-be-3           100% █████████████████████████  in 1h07m    14% ███░░░░░░░░░░░░░░░░░░░░░░  in 5d9h      —         —
 acc-data            41% ██████████░░░░░░░░░░░░░░░  in 47m      20% █████░░░░░░░░░░░░░░░░░░░░  in 5d16h     —         —
 acc-fe-1             0% ░░░░░░░░░░░░░░░░░░░░░░░░░  —            6% █░░░░░░░░░░░░░░░░░░░░░░░░  in 1d19h     0%        —    [kicked]
 acc-tester          51% ████████████░░░░░░░░░░░░░  in 2h07m     7% █░░░░░░░░░░░░░░░░░░░░░░░░  in 4d5h      —         —
 acc-shared          HTTP 403: OAuth not allowed for org…
 acc-personal        token expired (run `claude` once to refresh)
 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 PEAK across 6 account(s):  5h 100%   weekly  20%

 [k] auto-kick: ON   [c] color: ON   [+/-] interval: 1m0s   [r] refresh   [?] toggle help   [q] quit
```

## Use case

You run multiple Claude Code accounts in parallel via aliases:

```sh
alias claude-acc-be-1="CLAUDE_CONFIG_DIR=~/.claude-account/acc-be-1 claude"
alias claude-acc-be-2="CLAUDE_CONFIG_DIR=~/.claude-account/acc-be-2 claude"
# ...
```

`claude-monitor` scans every `~/.claude-account/*`, pulls each account's OAuth token from the macOS Keychain, calls Anthropic's `/api/oauth/usage` for each in parallel, and keeps a live dashboard updated on a tunable interval (default 60s).

## Requirements

- macOS (uses the `security` CLI to read the Keychain — Linux/Windows not supported yet)
- Go 1.22+ (we use Go 1.24 toolchain features)
- `make` (optional)
- Logged in at least once per account (`CLAUDE_CONFIG_DIR=... claude`) — Claude Code stores the OAuth token in the Keychain automatically

## Build & install

```sh
make build              # -> ./bin/claude-monitor (ad-hoc codesigned)
make install            # -> $HOME/bin/claude-monitor
make install INSTALL_DIR=/usr/local/bin
```

## Run

```sh
claude-monitor                       # full TUI, default settings
claude-monitor --root ~/.cfg-dir     # different account root
claude-monitor --version
```

That's it for flags — every other option is toggled in-app.

## Hotkeys

| Key      | Action                                                 |
|----------|--------------------------------------------------------|
| `q`      | quit                                                   |
| `r`      | refresh now (skipped if a refresh is already in flight) |
| `k`      | toggle auto-kick (start the next 5h window when 0%)    |
| `c`      | toggle color                                           |
| `+` / `-`| cycle refresh interval: 1m → 2m → 5m → 10m             |
| `?`      | show / hide the help bar                               |

Every toggle is persisted immediately to `~/.claude-monitor/config.json`, so the next launch comes up with the same settings.

## Auto-kick

Anthropic's 5h usage window only starts counting **after the first message** sent following a reset. With auto-kick on (`[k]`), every refresh tick checks each account: if `5h_utilization == 0`, the tool sends a 1-token request to `/v1/messages` (Haiku, `max_tokens=1`) using that account's OAuth token. The row gets a green `[kicked]` annotation; on failure, a red `[kick failed: …]`.

This is opt-in because it costs ~a fraction of a cent per kick — cheap, but not free. Keep it off if you don't want predictable window starts.

## Output

- `5H` / `WEEKLY` columns: % with a colored bar (green < 70%, yellow 70-89%, red ≥ 90%)
- `RESETS` columns: time remaining until that window resets (yellow when < 1 hour)
- `SONNET WK` / `OPUS WK`: per-model weekly % (`—` if the plan doesn't track them separately)
- `PEAK`: max 5h / weekly across all successfully fetched accounts
- Per-account errors render inline:
  - `token expired …` → run `claude` once to refresh
  - `HTTP 403 …` → org disallows OAuth (use an API key for that account)
  - `no token …` → never logged in for that account

## How it works

```
~/.claude-account/<name>/
└─ .claude.json (account email, surfaced as the row label)

macOS Keychain:
└─ "Claude Code-credentials-<sha256(abs_path)[:8]>"
   { "claudeAiOauth": { "accessToken": "sk-ant-oat01-…", "expiresAt": <ms> } }

~/.claude-monitor/
└─ config.json     (auto-kick, intervalSeconds, color)
```

On every tick:

1. Scan `~/.claude-account/*` for directories that look like Claude Code config dirs.
2. For each account, compute `sha256(absolute_path_no_trailing_slash)[:8]` → service name in the Keychain, read the token via `security find-generic-password`.
3. Fetch `GET https://api.anthropic.com/api/oauth/usage` in parallel with `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`.
4. If auto-kick is on, fire `POST /v1/messages` (Haiku 4.5, `max_tokens=1`) at every account whose `five_hour.utilization == 0`.
5. Render the table and schedule the next tick.

## Source layout

```
main.go      flag parsing, bubbletea bootstrap
tui.go       bubbletea Model/Update/View, lipgloss styles, hotkeys
config.go    load/save ~/.claude-monitor/config.json + interval cycling
snapshot.go  account discovery + parallel fetch + auto-kick pass
api.go       HTTP client + decoder for /api/oauth/usage
keychain.go  sha256[:8] hash → service name → security CLI → OAuth creds
kick.go      POST /v1/messages with the account's OAuth token
format.go    string helpers (truncate, padRight, visibleLen)
```

## Make targets

```sh
make help
```

| Target | Description |
|---|---|
| `build` | Build the binary into `./bin/claude-monitor` (ad-hoc codesigned on darwin) |
| `run` | Build + launch the TUI |
| `install` | Copy the binary to `$INSTALL_DIR` (default `~/bin`) |
| `release` | Cross-compile darwin/linux × amd64/arm64 |
| `fmt` / `vet` / `tidy` | gofmt / go vet / go mod tidy |
| `clean` | Remove `./bin/` |

## Security

The tool does not store, log, or transmit tokens anywhere except over HTTPS to `api.anthropic.com`. Tokens are read from the Keychain via the `security` CLI on every refresh — depending on the entry's ACL, macOS may prompt for Touch ID or a password the first time.

The `/api/oauth/usage` endpoint is internal to Claude Code (not in Anthropic's public docs); its format/URL may change without notice. If it breaks, debug with `claude --debug api 2> log` and `grep oauth/usage log`.

## Limitations

- **macOS only** — depends on the `security` CLI. Linux would need libsecret/D-Bus (not implemented).
- **Undocumented endpoint** — `/api/oauth/usage` may change without notice.
- **No auto OAuth refresh** — when a token expires, run `CLAUDE_CONFIG_DIR=… claude` once to refresh.
- **OAuth disabled for org** — returns 403 (`"OAuth authentication is currently not allowed for this organization"`); that account must use an API key instead.
