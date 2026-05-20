---
name: pi-holdpty
description: Manage detached PTY sessions with ownership, stale detection, and regex watchers. Fork of holdpty with watchexec-style event streams.
---

# pi-holdpty

Detached PTY session manager with single-writer ownership, stale detection, and watchexec-style regex watchers.

## Commands

| Command | Description |
|---------|-------------|
| `holdpty launch --bg [--name <n>] [--stale-after <dur>] -- <cmd>` | Launch a new PTY session (detached) |
| `holdpty attach <session>` | Attach to a session (owner only) |
| `holdpty view <session>` | View session output (read-only, anyone) |
| `holdpty logs <session> [--follow]` | Dump session buffer |
| `holdpty send <session> <text>` | Send input to session (owner only) |
| `holdpty watch <session> --pattern <regex>` | Watch for regex matches (NDJSON events) |
| `holdpty wait <session>` | Block until session exits |
| `holdpty tail-events <session\|--all>` | Unified NDJSON event stream |
| `holdpty claim <session> [--force]` | Claim ownership of a stale/released session |
| `holdpty release <session>` | Release ownership |
| `holdpty ls [--json]` | List active sessions |
| `holdpty info <session>` | Show session details + ownership |
| `holdpty stop <session> [--force]` | Stop a session (owner only unless --force) |

## Ownership Rules

- 1 session = 1 PTY owner at a time
- `attach`, `send`, `stop` require ownership (exit code 3 if not owner)
- `view`, `logs`, `tail-events`, `ls`, `info` are read-only (no ownership check)
- `claim` works on stale/released sessions; `--force` always works but is audited
- `--force-claim` is a foot-gun: use only when explicitly instructed or in emergency

## Stale Detection

Sessions are stale when:
- Owner PID is dead (orphaned)
- No interaction for > threshold (default 4h, configurable via `--stale-after`)

## Event Types (NDJSON)

- `match` — regex pattern matched a line
- `exit` — session child process exited
- `dropped` — lines dropped due to buffer overflow
- `claim_change` — ownership changed
- `stale_warning` — session crossed stale threshold
