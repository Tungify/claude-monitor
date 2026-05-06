---
description: Switch the active Claude Code account by rewriting the keychain slot used by this session
---

The user wants to switch the active account that this `claude` session is reading credentials from. `claude-monitor` exposes two flags for this:

- `claude-monitor --list-accounts` — print every discovered account with its current 5h utilization and which one is active.
- `claude-monitor --swap-to <name|email>` — rewrite the default keychain slot to point at the given account. The next API call from this session picks up the new bearer token without restarting.

If `$ARGUMENTS` is non-empty, run `claude-monitor --swap-to "$ARGUMENTS"` and report the result.

Otherwise, run `claude-monitor --list-accounts`, show the table to the user, ask which account they want to switch to, then run `claude-monitor --swap-to <answer>` and report the result.
