# claude-monitor

Real-time terminal dashboard for **multiple Claude Code accounts**, backed by the same data source as `/usage` inside Claude Code (`GET /api/oauth/usage`). Refreshes on a fixed cadence, persists settings, optionally kicks a fresh 5h window when an account is at 0%, and optionally rotates the OAuth slot a default `claude` tab reads from so the active account stays under quota.

```
 claude-monitor   refreshed 4s ago   next in 56s   accounts: 8

 ACCOUNT             5H                              RESETS      WEEKLY                          RESETS      SONNET WK  OPUS WK
 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ★ acc-be-1          92% ███████████████████████░░  in 1h37m     8% ██░░░░░░░░░░░░░░░░░░░░░░░  in 2d10h     0%        —
   acc-be-2          96% ████████████████████████░  in 1h07m    14% ███░░░░░░░░░░░░░░░░░░░░░░  in 3d1h      —         —
   acc-be-3         100% █████████████████████████  in 1h07m    14% ███░░░░░░░░░░░░░░░░░░░░░░  in 5d9h      —         —
   acc-data          41% ██████████░░░░░░░░░░░░░░░  in 47m      20% █████░░░░░░░░░░░░░░░░░░░░  in 5d16h     —         —
   acc-fe-1           0% ░░░░░░░░░░░░░░░░░░░░░░░░░  —            6% █░░░░░░░░░░░░░░░░░░░░░░░░  in 1d19h     0%        —    [kicked]
   acc-tester        51% ████████████░░░░░░░░░░░░░  in 2h07m     7% █░░░░░░░░░░░░░░░░░░░░░░░░  in 4d5h      —         —
   acc-shared        rate limited (retry in 3m12s)
   acc-personal      token expired (run `claude` once to refresh)
 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 PEAK across 6 account(s):  5h 100%   weekly  20%

 [k] auto-kick: ON   [s] auto-swap: ON   [e] edit   [r] refresh   [?] toggle help   [q] quit
```

## Requirements

claude-monitor reads OAuth tokens from the same OS credential store Claude Code writes them to via [keytar](https://github.com/atom/node-keytar):

| OS          | Backend                                                                              | Extra deps                                                             |
|-------------|--------------------------------------------------------------------------------------|------------------------------------------------------------------------|
| **macOS**   | Keychain Services (via the `security` CLI)                                           | none                                                                   |
| **Linux**   | Secret Service API / libsecret (via `secret-tool`)                                   | `libsecret-tools` + a running keyring (gnome-keyring on most desktops) |
| **Windows** | Windows Credential Manager (via [`wincred`](https://github.com/danieljoos/wincred))  | none                                                                   |

Each account must have logged in once (`CLAUDE_CONFIG_DIR=… claude`) so its OAuth token is stored — claude-monitor only reads.

## Install

**macOS / Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/Tungify/claude-monitor/main/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Tungify/claude-monitor/main/install.ps1 | iex
```

Both installers download the latest pre-built binary, drop it into `~/.local/bin/claude-monitor` (or `$HOME\.local\bin\claude-monitor.exe` on Windows), and prepend that directory to your shell's `PATH`. Override with env vars:

```sh
INSTALL_DIR=/usr/local/bin SHELL_RC=~/.bashrc \
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/Tungify/claude-monitor/main/install.sh)"
```

```powershell
$env:INSTALL_DIR = 'C:\tools\claude-monitor'
irm https://raw.githubusercontent.com/Tungify/claude-monitor/main/install.ps1 | iex
```

### Build from source

Go 1.22+ required.

```sh
git clone https://github.com/Tungify/claude-monitor && cd claude-monitor
make install              # -> $HOME/bin/claude-monitor
make install INSTALL_DIR=/usr/local/bin
```

### Upgrades

The TUI hits the GitHub Releases API once on launch (async — never blocks startup). When a newer tag exists you'll see a `⬆ vX.Y.Z available — press [u]` banner in the header; pressing `u` downloads the binary for the current OS/arch, codesigns it on macOS, and replaces the running executable. From the shell:

```sh
claude-monitor --upgrade   # same flow without the TUI
```

## Run

```sh
claude-monitor                                  # auto-discover ~/.claude* in $HOME
claude-monitor --root ~/.claude-account         # parent dir holding sub-accounts
claude-monitor --root ~/.claude,~/.claude-gem   # comma-separated list
claude-monitor --list-accounts                  # print accounts and exit (CLI mode)
claude-monitor --swap-to acc-be-2               # rewrite the keychain slot and exit
claude-monitor --keychain-setup                 # macOS: silence per-swap password prompts
claude-monitor --version
```

Every other option is toggled in-app and persisted to `~/.claude-monitor/config.json`.

## Account discovery

Two layouts are supported and auto-detected:

```sh
# A — top-level dirs in $HOME (auto-discovered, no flag needed)
~/.claude/  ~/.claude-gem/  ~/.claude-work/

# B — one parent dir whose subdirectories are accounts
~/.claude-account/be-1/  ~/.claude-account/be-2/  …
```

| `--root` value             | Behaviour                                                                          |
|----------------------------|------------------------------------------------------------------------------------|
| _(omitted)_                | Auto-discover every `~/.claude*` directory in `$HOME`.                             |
| `~/.claude-account`        | Treat as a parent; each subdir that looks like a Claude config dir is one account. |
| `~/.claude,~/.claude-gem`  | Comma-separated. Each item can be a single config dir OR a parent.                 |

Paths are deduped by canonical (symlink-resolved) absolute path.

## Hotkeys

| Key | Action                                                                   |
|-----|--------------------------------------------------------------------------|
| `r` | Refresh now (interrupts an in-flight refresh; feels instant)             |
| `k` | Toggle **auto-kick** — start the 5h window when an account is at 0%      |
| `s` | Toggle **auto-swap** — rotate the OAuth slot among accounts              |
| `m` | **Manual switch** — pick an account to swap to, pin until next threshold |
| `e` | Open the settings editor (swap thresholds, pick order, rebalance)        |
| `u` | Upgrade to the latest release *(only shown when an update is available)* |
| `?` | Show / hide the help bar                                                 |
| `q` | Quit (also `Esc`, `Ctrl+C`)                                              |

## Output

- `5H` / `WEEKLY`: utilization % + colored bar (green < 70, yellow 70–89, red ≥ 90)
- `RESETS`: time remaining until the window resets (yellow when < 1h)
- `SONNET WK` / `OPUS WK`: per-model weekly % (`—` if the plan doesn't track them)
- `★`: account currently behind the plain `claude` keychain slot (the one a default `claude` tab will hit)
- `PEAK`: max 5h / weekly across successful rows
- Per-account errors render inline:
  - `token expired …` — run `claude` once to refresh
  - `HTTP 403 …` — org disallows OAuth (use an API key for that account)
  - `no token …` — never logged in for that account
  - `rate limited (retry in …)` — backoff applied; the countdown ticks live

## Auto-kick

Anthropic's 5h window only starts counting **after the first message** following a reset. With auto-kick on, every refresh tick fires a 1-token request to `/v1/messages` (Haiku 4.5, `max_tokens=1`) at any account whose `five_hour.utilization == 0`. The row gets a green `[kicked]`; on failure, a red `[kick failed: …]`.

Costs ~a fraction of a cent per kick — leave it off if you don't want predictable window starts.

## Auto-swap

When you run `claude` without `CLAUDE_CONFIG_DIR`, it reads OAuth creds from one fixed keychain slot (`Claude Code-credentials`). Auto-swap rewrites that slot in place, rotating it among your discovered accounts so a long-running `claude` tab transparently picks up a fresh quota when the active account is near its 5h limit.

Configurable in the `[e]` settings editor:

- **Thresholds** — ascending cascade (default `90, 99, 100`). At each tier, swap when the active account ≥ tier and any candidate is below tier.
- **Pick order** — `lowest` (default, spreads load) or `highest` (drains accounts one at a time).
- **Rebalance on reset** — when on, swap to any account whose 5h window just reset, even when the active account is well below threshold.

Tabs invoked with an explicit `CLAUDE_CONFIG_DIR=…` bypass the plain slot and are intentionally left alone.

## Manual switch

Press `[m]` in the dashboard to override auto-swap and pick an account yourself:

- `↑/↓` (or `j/k`, or number keys `1-9`) move the cursor
- `enter` swaps the plain slot to the highlighted row — the next API call from any default-flow `claude` tab uses the new account immediately, no restart
- `esc`/`m`/`q` cancels

The picked account becomes a **pin** (`★` turns blue, `📌 pin: <name>` shows in the help bar). While pinned:

- `RebalanceOnReset` is suppressed — the dashboard won't auto-swap off your pick when some other account's window resets.
- The threshold cascade still applies — when the pinned account hits 90% (or whatever your lowest threshold is), auto-swap takes over and rotates to a fresh candidate. The pin clears the moment auto-swap moves the active dir.

In other words: "use this account until the next threshold."

### macOS keychain setup (silence the password prompt)

On macOS 10.13+, every keychain modification prompts for your user password unless the calling binary's code-signing identity is in the entry's *partition list*. claude-monitor is ad-hoc signed (no team ID), so without setup it triggers a dialog on every swap.

The first time you run claude-monitor it prompts once for your macOS user password and registers itself in each Claude Code keychain entry's partition list. After that all swaps stay silent. Skip with Enter; rerun later via:

```sh
claude-monitor --keychain-setup
```

The password is passed to the system `security` CLI via the `-k` flag (so each `set-generic-password-partition-list` call doesn't itself prompt) and is never stored. It's visible in `ps aux` for the few milliseconds the command runs — fine on a single-user laptop, weak on a shared host.

If you add a new account later, that account's hashed entry won't be in the partition list yet. Rerun `--keychain-setup` to register it.

### From a `claude` slash command

Two CLI entry points let you drive the swap from outside the TUI — useful for a `/switch-account` slash command:

```sh
claude-monitor --list-accounts            # name, email, 5h util, active marker
claude-monitor --swap-to acc-be-2         # by short name
claude-monitor --swap-to alice@corp.com   # or by email
```

A sample slash command lives in [`commands/switch-account.md`](commands/switch-account.md). Drop it into your Claude Code commands dir:

```sh
mkdir -p ~/.claude/commands
cp commands/switch-account.md ~/.claude/commands/
```

Then in any Claude Code tab:

- `/switch-account` — Claude lists accounts and asks which to pick.
- `/switch-account acc-be-2` — Claude swaps directly.

The next API call from that session picks up the new bearer token because Claude Code re-reads the keychain on each request.

## How it works

```
~/.claude-account/<name>/
└─ .claude.json (account email → row label)

macOS Keychain:
├─ "Claude Code-credentials"                       (plain slot — what default `claude` reads)
└─ "Claude Code-credentials-<sha256(abs_path)[:8]>"  (per-account slot)
   { "claudeAiOauth": { "accessToken": "sk-ant-oat01-…", "expiresAt": <ms> } }

~/.claude-monitor/config.json    (auto-kick, auto-swap, thresholds, …)
```

Each tick:

1. Resolve account dirs from `--root` (or auto-discovery).
2. For each account in parallel, read the OAuth token from the Keychain via `security find-generic-password`, then `GET /api/oauth/usage` with `Authorization: Bearer …` + `anthropic-beta: oauth-2025-04-20`.
3. If auto-kick is on, fire a 1-token Haiku message at every account with 5h util == 0.
4. If auto-swap is on, evaluate the threshold cascade + reset-rebalance and, if a swap is warranted, park the previous active creds into its hashed slot and copy the target's creds into the plain slot.
5. Render the table and schedule the next tick.

Refresh interval is fixed at 60s (the safe lower bound against rate-limiting on the undocumented endpoint).

## Source layout

```
main.go              flag parsing, bubbletea bootstrap
tui.go               Model / Update / View, lipgloss styles, hotkeys
editor.go            [e] settings form
config.go            ~/.claude-monitor/config.json load/save
snapshot.go          account discovery + parallel fetch + auto-kick pass
swap.go              threshold cascade, reset rebalance, keychain-slot rotation
api.go               /api/oauth/usage HTTP client + decoder
update.go            GitHub Releases check + atomic self-replace
keychain.go          cross-platform: service-name hashing, candidate ordering
keychain_darwin.go   macOS: shell out to `security`
keychain_linux.go    Linux: shell out to `secret-tool` (libsecret)
keychain_windows.go  Windows: wincred (Credential Manager) via syscall
kick.go              POST /v1/messages with the account's OAuth token
format.go            string helpers (truncate, padRight, visibleLen)
```

## Make targets

| Target                 | Description                                                                        |
|------------------------|------------------------------------------------------------------------------------|
| `build`                | Build the binary into `./bin/claude-monitor` (ad-hoc codesigned on darwin)         |
| `run`                  | Build and launch the TUI                                                           |
| `install`              | Copy the binary to `$INSTALL_DIR` (default `~/bin`)                                |
| `release`              | Cross-compile darwin/linux × amd64/arm64                                           |
| `fmt` / `vet` / `tidy` | gofmt / go vet / go mod tidy                                                       |
| `clean`                | Remove `./bin/`                                                                    |

## Security

Tokens are read from the OS credential store on every refresh and sent only over HTTPS to `api.anthropic.com`. Nothing is logged, cached, or transmitted elsewhere. The first read may surface a system prompt: Touch ID / "always allow" on macOS, the keyring unlock dialog on Linux, or a UAC banner on Windows depending on policy.

`/api/oauth/usage` is internal to Claude Code (not in Anthropic's public docs); its format may change without notice. To debug if it breaks: `claude --debug api 2> log && grep oauth/usage log`.

## Limitations

- **Undocumented endpoint** — `/api/oauth/usage` may change without notice.
- **No automatic OAuth refresh** — when a token expires, run `CLAUDE_CONFIG_DIR=… claude` once.
- **OAuth disabled for org** — returns 403; that account must use an API key.
- **Linux**: requires libsecret + a running keyring daemon. Headless servers without a Secret Service don't work yet.
