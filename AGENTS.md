# holdpty — Agent Configuration

## Project Overview

Minimal cross-platform detached PTY tool. Spiritual successor to dtach/abduco for Node.js + Windows.

- **Stack**: TypeScript, Node.js, node-pty
- **Package manager**: npm
- **Testing**: Vitest
- **Build**: `tsc` (ESM, Node16 module resolution)
- **License**: MIT

## Design Documents

Read these before making architectural changes:

- `docs/DESIGN.md` — full architecture, protocol spec, and design decisions
- `docs/PROTOCOL.md` — wire protocol reference
- `README.md` — user-facing documentation

## Code Conventions

- TypeScript strict mode, no `any`
- ESM (`"type": "module"`)
- File naming: `kebab-case.ts`
- Types: `PascalCase`, functions: `camelCase`, constants: `UPPER_SNAKE`
- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`

## Commands

| Command | Description |
|---------|-------------|
| `launch --bg` | Start session detached, return immediately |
| `launch --fg` | Start session in foreground (blocks until child exits) |
| `launch --wait` | Detached launch but blocks caller until child exits (returns exit code) |
| `attach <session>` | Interactive connection (single-writer) |
| `view <session>` | Read-only live stream (multiple viewers) |
| `logs <session>` | Dump output buffer to stdout (`--tail`, `--follow`, `--no-replay`) |
| `ls [--json]` | List active sessions (auto-cleans stale) |
| `stop <session>` | Send SIGTERM to child process |
| `info <session>` | Show session metadata as JSON |
| `wait <session>` | Block until session's child exits, return its exit code |

## Key Architecture Rules

1. **One holder process per session** — no central daemon, no shared state
2. **Raw byte relay** — no terminal state machine, no ANSI parsing. Store what the PTY emits, replay verbatim.
3. **Binary length-prefixed protocol** — `[1B type][4B length BE][payload]`. No JSON-lines, no escape framing.
4. **Filesystem is the registry** — session directory has `.sock` + `.json` per session. No database.
5. **Not a process manager** — lifecycle is the caller's problem (pm2, nohup, shell)
6. **Stdout discipline** — `view` and `logs` output PTY data ONLY on stdout. Status/errors to stderr always.
7. **Four connection modes** — `attach` (r/w, single writer), `view` (r/o, multi), `logs` (replay then close), `wait` (no data, blocks until EXIT). See `docs/PROTOCOL.md`.

## Testing

Cross-platform tests are critical. Test on Windows + Linux. Key areas:
- Socket lifecycle (create, connect, stale detection, cleanup)
- Ring buffer (write, replay, overflow)
- Protocol framing (encode/decode, partial reads)
- PTY spawn + data relay (node-pty integration)
- E2E tests (`src/e2e.test.ts`) — launch, attach, logs, wait, info, stop across platforms

## Common Pitfalls

- **Windows UDS path length**: max ~108 chars. Session dir uses short paths (`%TEMP%\dt\`).
- **node-pty onExit fires before last onData**: drain with small delay after child exit.
- **node-pty resize throws if process exited**: wrap in try/catch.
- **ConPTY ghost processes**: track child PID explicitly for cleanup.
- **Socket file locked on Windows**: close all connections before unlinking.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **pi-holdpty** (1094 symbols, 2348 relationships, 95 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/pi-holdpty/context` | Codebase overview, check index freshness |
| `gitnexus://repo/pi-holdpty/clusters` | All functional areas |
| `gitnexus://repo/pi-holdpty/processes` | All execution flows |
| `gitnexus://repo/pi-holdpty/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
