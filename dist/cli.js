#!/usr/bin/env node
/**
 * holdpty CLI entry point.
 *
 * Minimal argument parsing — no framework needed for 8 commands.
 */
import { Holder } from "./holder.js";
import { attach, view, logs, send, waitForExit, connect } from "./client.js";
import { listSessions, readMetadata, removeSession, isSessionActive } from "./session.js";
import { getSessionDir } from "./platform.js";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseWatchArgs, parseTailEventsArgs, createWatcherPipeline } from "./cli-commands.js";
import { NdjsonWriter, makeExitEvent } from "./event-stream.js";
import { compilePatterns, compilePattern } from "./watcher-filter.js";
import { FrameDecoder, MSG, decodeExit } from "./protocol.js";
import { readFullMetadata, writeFullMetadata, enforceOwnership, touchInteraction, resolveSessionId, lockedClaim, lockedRelease, OwnershipError, } from "./ownership.js";
import { checkStaleness } from "./staleness.js";
// Read version from package.json at build time — keep in sync
const VERSION = "0.5.0";
// ── Argument parsing ───────────────────────────────────────────────
function usage() {
    return `holdpty v${VERSION} — Pi-flavored detached PTY (fork of marcfargas/holdpty)

Usage:
  holdpty launch --bg|--fg|--wait [--name <name>] [--cols N] [--rows N] [--stale-after <dur>] [--] <command> [args...]
  holdpty attach <session>
  holdpty view <session>
  holdpty logs <session> [--tail N] [--follow] [--no-replay]
  holdpty send <session> [--] <text>
  holdpty send <session> --stdin
  holdpty wait <session>
  holdpty watch <session> --pattern <regex> [--pattern <regex>]... [--label <name>]... [--debounce <ms>] [--max-buffer <bytes>] [--from <start|now>] [--exit-on <regex>]
  holdpty tail-events <session|--all> [--pattern <regex> --label <name>]...
  holdpty claim <session> [--force]
  holdpty release <session> [--force]
  holdpty ls [--json]
  holdpty stop <session> [--force]
  holdpty info <session>
  holdpty --help | --version`;
}
function die(msg) {
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
}
// ── Commands ───────────────────────────────────────────────────────
async function cmdLaunch(args) {
    let fg = false;
    let bg = false;
    let wait = false;
    let name;
    let cols;
    let rows;
    let staleAfter;
    let cmdStart = -1;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--fg") {
            fg = true;
        }
        else if (arg === "--bg") {
            bg = true;
        }
        else if (arg === "--wait") {
            wait = true;
        }
        else if (arg === "--name" && i + 1 < args.length) {
            name = args[++i];
        }
        else if (arg === "--stale-after" && i + 1 < args.length) {
            staleAfter = args[++i];
        }
        else if (arg === "--cols" && i + 1 < args.length) {
            cols = parseInt(args[++i], 10);
            if (isNaN(cols) || cols < 1)
                die("--cols requires a positive integer");
        }
        else if (arg === "--rows" && i + 1 < args.length) {
            rows = parseInt(args[++i], 10);
            if (isNaN(rows) || rows < 1)
                die("--rows requires a positive integer");
        }
        else if (arg === "--") {
            cmdStart = i + 1;
            break;
        }
        else if (arg.startsWith("-")) {
            die(`Unknown launch option: ${arg}`);
        }
        else {
            // Non-flag argument: treat as command start (-- is optional).
            // PowerShell strips bare `--` before it reaches process.argv,
            // so we must support: holdpty launch --bg sleep 30
            cmdStart = i;
            break;
        }
    }
    if (fg && wait)
        die("--wait cannot be used with --fg (--fg already waits for exit)");
    if (!fg && !bg && !wait)
        die("launch requires --fg or --bg");
    if (fg && bg)
        die("launch cannot use both --fg and --bg");
    if (cmdStart < 0 || cmdStart >= args.length)
        die("launch requires a command after the flags");
    const command = args.slice(cmdStart);
    if (command.length === 0)
        die("launch requires a command");
    if (bg || wait) {
        // Spawn the holder as a detached child process.
        // Use a ready-file to signal that the holder has started.
        const thisFile = fileURLToPath(import.meta.url);
        const readyFile = resolve(getSessionDir(), `.ready-${process.pid}-${Date.now()}`);
        const child = spawn(process.execPath, [
            thisFile, "__holder",
            ...(name ? ["--name", name] : []),
            ...(cols != null ? ["--cols", String(cols)] : []),
            ...(rows != null ? ["--rows", String(rows)] : []),
            "--ready-file", readyFile,
            "--", ...command,
        ], {
            detached: true,
            stdio: "ignore",
        });
        child.unref();
        // Poll for the ready file (contains the session name)
        const deadline = Date.now() + 5000;
        let sessionName = "";
        while (Date.now() < deadline) {
            try {
                sessionName = readFileSync(readyFile, "utf-8").trim();
                unlinkSync(readyFile);
                break;
            }
            catch {
                await new Promise((r) => setTimeout(r, 50));
            }
        }
        if (!sessionName) {
            die("Holder did not start within 5s");
        }
        process.stdout.write(sessionName + "\n");
        // --wait: stay alive until the child process exits, then forward exit code
        if (wait) {
            await waitAndExit(sessionName);
        }
    }
    else {
        // Foreground: run holder in this process, bridge stdin/stdout to PTY
        const holder = await Holder.start({
            command,
            name,
            cols: cols ?? (process.stdout.columns || undefined),
            rows: rows ?? (process.stdout.rows || undefined),
        });
        process.stdout.write(holder.sessionName + "\n");
        const code = await holder.pipeStdio();
        process.exit(code);
    }
}
/**
 * Internal command: run the holder process (used by --bg launch).
 */
async function cmdHolder(args) {
    let name;
    let readyFile;
    let cols;
    let rows;
    let cmdStart = -1;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--name" && i + 1 < args.length) {
            name = args[++i];
        }
        else if (args[i] === "--ready-file" && i + 1 < args.length) {
            readyFile = args[++i];
        }
        else if (args[i] === "--cols" && i + 1 < args.length) {
            cols = parseInt(args[++i], 10);
        }
        else if (args[i] === "--rows" && i + 1 < args.length) {
            rows = parseInt(args[++i], 10);
        }
        else if (args[i] === "--") {
            cmdStart = i + 1;
            break;
        }
    }
    if (cmdStart < 0)
        die("__holder requires -- <command>");
    const command = args.slice(cmdStart);
    const holder = await Holder.start({ command, name, cols, rows });
    // Signal the parent that we're ready by writing session name to the ready file
    if (readyFile) {
        writeFileSync(readyFile, holder.sessionName, "utf-8");
    }
    // Keep running until child exits
    await holder.waitForExit();
}
/**
 * Forward signals to the session's child process and wait for it to exit.
 * Exits the current process with the child's exit code.
 *
 * Used by `launch --wait` and `holdpty wait <session>`.
 */
async function waitAndExit(name) {
    // Forward SIGTERM/SIGINT to the session's child process
    const meta = readMetadata(name);
    if (meta) {
        const forward = (signal) => {
            try {
                process.kill(meta.childPid, signal);
            }
            catch { /* child may be dead */ }
        };
        process.on("SIGTERM", () => forward("SIGTERM"));
        process.on("SIGINT", () => forward("SIGINT"));
    }
    const code = await waitForExit({ name });
    process.exit(code);
}
async function cmdWait(args) {
    const name = args[0];
    if (!name)
        die("wait requires a session name");
    await waitAndExit(name);
}
async function cmdAttach(args) {
    const name = args[0];
    if (!name)
        die("attach requires a session name");
    // Ownership check (R6)
    const sessionId = resolveSessionId();
    const fullMeta = readFullMetadata(name);
    if (fullMeta) {
        try {
            enforceOwnership(fullMeta, sessionId, "attach");
            touchInteraction(fullMeta, sessionId);
            writeFullMetadata(fullMeta);
        }
        catch (err) {
            if (err instanceof OwnershipError) {
                process.stderr.write(`Error: ${err.message}\n`);
                process.exit(3);
            }
            // Non-ownership errors fall through to normal attach
        }
    }
    const code = await attach({ name });
    if (code !== null) {
        process.exit(code);
    }
    // code === null means detached
}
async function cmdView(args) {
    const name = args[0];
    if (!name)
        die("view requires a session name");
    await view({ name });
}
async function cmdLogs(args) {
    let name;
    let tail;
    let follow = false;
    let noReplay = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--tail" || arg === "-n") {
            const val = args[++i];
            if (val === undefined)
                die("--tail requires a number");
            tail = parseInt(val, 10);
            if (isNaN(tail) || tail < 1)
                die("--tail requires a positive integer");
        }
        else if (arg === "--follow" || arg === "-f") {
            follow = true;
        }
        else if (arg === "--no-replay") {
            noReplay = true;
        }
        else if (!arg.startsWith("-")) {
            name = arg;
        }
        else {
            die(`Unknown logs option: ${arg}`);
        }
    }
    if (!name)
        die("logs requires a session name");
    if (noReplay && !follow)
        die("--no-replay requires --follow");
    if (noReplay && tail != null)
        die("--no-replay and --tail are mutually exclusive");
    await logs({ name, tail, follow, noReplay });
}
async function cmdLs(args) {
    const json = args.includes("--json");
    const sessions = await listSessions({ clean: true });
    if (json) {
        // Enrich with R5 fields for each session
        const enriched = sessions.map((s) => {
            const fullMeta = readFullMetadata(s.name);
            if (fullMeta) {
                const staleness = checkStaleness(fullMeta);
                return {
                    ...s,
                    metadata: fullMeta,
                    stale: staleness.stale,
                    orphaned: staleness.orphaned,
                    idle_for_ms: staleness.idle_for_ms,
                };
            }
            return s;
        });
        process.stdout.write(JSON.stringify(enriched, null, 2) + "\n");
        return;
    }
    if (sessions.length === 0) {
        process.stderr.write("No active sessions\n");
        return;
    }
    // Table output
    const header = "NAME            PID     COMMAND                           STARTED";
    process.stdout.write(header + "\n");
    for (const s of sessions) {
        const { name, metadata: m } = s;
        const cmd = m.command.join(" ").slice(0, 35);
        const started = m.startedAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
        process.stdout.write(`${name.padEnd(16)}${String(m.childPid).padEnd(8)}${cmd.padEnd(34)}${started}\n`);
    }
}
async function cmdStop(args) {
    let name;
    let force = false;
    for (const arg of args) {
        if (arg === "--force") {
            force = true;
        }
        else if (!arg.startsWith("-") && !name) {
            name = arg;
        }
        else if (arg.startsWith("-")) {
            die(`Unknown stop option: ${arg}`);
        }
    }
    if (!name)
        die("stop requires a session name");
    const meta = readMetadata(name);
    if (!meta)
        die(`Session "${name}" not found`);
    if (!isSessionActive(name)) {
        // Clean stale files
        removeSession(name);
        process.stderr.write(`Session "${name}" is not running (cleaned stale files)\n`);
        return;
    }
    // Ownership check (R6)
    if (!force) {
        const sessionId = resolveSessionId();
        const fullMeta = readFullMetadata(name);
        if (fullMeta) {
            try {
                enforceOwnership(fullMeta, sessionId, "stop");
            }
            catch (err) {
                if (err instanceof OwnershipError) {
                    process.stderr.write(`Error: ${err.message}\nUse --force to override.\n`);
                    process.exit(3);
                }
            }
        }
    }
    try {
        // Kill the child process first (triggers holder's onExit → graceful shutdown)
        process.kill(meta.childPid, "SIGTERM");
    }
    catch {
        // Child may already be dead — try killing the holder directly
    }
    try {
        // Also kill the holder process to ensure cleanup on Windows
        // (where SIGTERM is TerminateProcess and may not propagate to the holder)
        process.kill(meta.pid, "SIGTERM");
    }
    catch {
        // Holder may already be dead
    }
    process.stderr.write(`Stopped session "${name}" (PID ${meta.childPid})\n`);
}
async function cmdSend(args) {
    let name;
    let useStdin = false;
    let textStart = -1;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--stdin") {
            useStdin = true;
        }
        else if (arg === "--") {
            textStart = i + 1;
            break;
        }
        else if (!name && arg.startsWith("-")) {
            die(`Unknown send option: ${arg}`);
        }
        else if (!name) {
            name = arg;
        }
        else {
            // First non-flag after session name — start of text
            textStart = i;
            break;
        }
    }
    if (!name)
        die("send requires a session name");
    // Ownership check (R6)
    const sessionId = resolveSessionId();
    const fullMeta = readFullMetadata(name);
    if (fullMeta) {
        try {
            enforceOwnership(fullMeta, sessionId, "send");
            touchInteraction(fullMeta, sessionId);
            writeFullMetadata(fullMeta);
        }
        catch (err) {
            if (err instanceof OwnershipError) {
                process.stderr.write(`Error: ${err.message}\n`);
                process.exit(3);
            }
        }
    }
    let data;
    if (useStdin) {
        if (textStart >= 0)
            die("--stdin and inline text are mutually exclusive");
        // Read all of stdin
        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        data = Buffer.concat(chunks);
        if (data.length === 0)
            die("no data received on stdin");
    }
    else {
        if (textStart < 0 || textStart >= args.length) {
            die("send requires text to send (or --stdin to read from pipe)");
        }
        const text = args.slice(textStart).join(" ");
        data = Buffer.from(text, "utf-8");
    }
    await send({ name, data });
}
async function cmdWatch(args) {
    let parsed;
    try {
        parsed = parseWatchArgs(args);
    }
    catch (e) {
        die(e.message);
    }
    const writer = new NdjsonWriter();
    const patternSpecs = compilePatterns(parsed.patterns, parsed.labels);
    const exitOnRegex = parsed.exitOn ? compilePattern(parsed.exitOn) : undefined;
    const sessions = parsed.all
        ? (await listSessions({ clean: true })).map((s) => s.name)
        : [parsed.session];
    if (sessions.length === 0) {
        die("No active sessions found");
    }
    let exitRequested = false;
    const filters = [];
    for (const sessionName of sessions) {
        const meta = readMetadata(sessionName);
        if (!meta)
            die(`Session "${sessionName}" not found`);
        const startedAt = Date.now();
        const filter = createWatcherPipeline({
            session: sessionName,
            patterns: patternSpecs,
            debounceMs: parsed.debounceMs,
            maxBufferBytes: parsed.maxBufferBytes,
            exitOnPattern: exitOnRegex,
            writer,
            onExit: () => {
                exitRequested = true;
                process.exit(0);
            },
        });
        filters.push(filter);
        // Connect to the session for live data
        try {
            const conn = await connect({
                name: sessionName,
                mode: parsed.from === "start" ? "view" : "view",
                onReplayData: parsed.from === "start" ? (data) => filter.feed(data) : () => { },
            });
            // Stream live data through the filter
            const decoder = new FrameDecoder();
            conn.socket.on("data", (chunk) => {
                let frames;
                try {
                    frames = decoder.decode(chunk);
                }
                catch {
                    return;
                }
                for (const frame of frames) {
                    if (frame.type === MSG.DATA_OUT) {
                        filter.feed(frame.payload);
                    }
                    else if (frame.type === MSG.EXIT) {
                        const { code } = decodeExit(frame.payload);
                        filter.flush();
                        const exitEvt = makeExitEvent({
                            session: sessionName,
                            exit_code: code,
                            duration_ms: Date.now() - startedAt,
                        });
                        writer.write(exitEvt);
                        if (!exitRequested) {
                            process.exit(code);
                        }
                    }
                }
            });
            conn.socket.on("close", () => {
                filter.flush();
            });
            conn.socket.on("error", () => {
                // Ensure the socket fd is released and we always exit, even if
                // filter.flush() throws — otherwise the fd leaks. Log the flush
                // failure to stderr first so it isn't silently swallowed by exit.
                try {
                    filter.flush();
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    process.stderr.write(`Error flushing filter on socket error: ${message}\n`);
                }
                finally {
                    conn.socket.destroy();
                    process.exit(1);
                }
            });
        }
        catch (e) {
            die(e.message);
        }
    }
    // Clean shutdown on signals
    const cleanup = () => {
        for (const f of filters)
            f.flush();
        process.exit(0);
    };
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
    // Keep alive
    await new Promise(() => { });
}
async function cmdTailEvents(args) {
    let parsed;
    try {
        parsed = parseTailEventsArgs(args);
    }
    catch (e) {
        die(e.message);
    }
    const writer = new NdjsonWriter();
    const patternSpecs = parsed.patterns.length > 0
        ? compilePatterns(parsed.patterns, parsed.labels)
        : [];
    const sessions = parsed.all
        ? (await listSessions({ clean: true })).map((s) => s.name)
        : [parsed.session];
    if (sessions.length === 0 && !parsed.all) {
        die("No session specified");
    }
    for (const sessionName of sessions) {
        const meta = readMetadata(sessionName);
        if (!meta)
            die(`Session "${sessionName}" not found`);
        const startedAt = Date.now();
        // If patterns are supplied, create a filter
        const filter = patternSpecs.length > 0
            ? createWatcherPipeline({
                session: sessionName,
                patterns: patternSpecs,
                debounceMs: parsed.debounceMs,
                maxBufferBytes: parsed.maxBufferBytes,
                writer,
            })
            : null;
        try {
            const conn = await connect({
                name: sessionName,
                mode: "view",
            });
            const decoder = new FrameDecoder();
            conn.socket.on("data", (chunk) => {
                let frames;
                try {
                    frames = decoder.decode(chunk);
                }
                catch {
                    return;
                }
                for (const frame of frames) {
                    if (frame.type === MSG.DATA_OUT && filter) {
                        filter.feed(frame.payload);
                    }
                    else if (frame.type === MSG.EXIT) {
                        const { code } = decodeExit(frame.payload);
                        if (filter)
                            filter.flush();
                        const exitEvt = makeExitEvent({
                            session: sessionName,
                            exit_code: code,
                            duration_ms: Date.now() - startedAt,
                        });
                        writer.write(exitEvt);
                    }
                }
            });
            conn.socket.on("close", () => {
                if (filter)
                    filter.flush();
            });
        }
        catch (e) {
            die(e.message);
        }
    }
    // Clean shutdown on signals
    process.on("SIGTERM", () => process.exit(0));
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGPIPE", () => process.exit(0));
    // Keep alive
    await new Promise(() => { });
}
async function cmdClaim(args) {
    let name;
    let force = false;
    for (const arg of args) {
        if (arg === "--force" || arg === "--force-claim") {
            force = true;
        }
        else if (!arg.startsWith("-") && !name) {
            name = arg;
        }
        else {
            die(`Unknown claim option: ${arg}`);
        }
    }
    if (!name)
        die("claim requires a session name");
    const sessionId = resolveSessionId();
    const meta = readFullMetadata(name);
    if (!meta)
        die(`Session "${name}" not found`);
    // Check staleness for non-force claims
    const staleness = checkStaleness(meta);
    const isStale = staleness.stale;
    const result = lockedClaim(name, sessionId, { force, isStale });
    if (!result.success) {
        process.stderr.write(`Error: Session "${name}" is actively owned by ${meta.owner_session}. Use --force to override.\n`);
        process.exit(3);
    }
    // Emit claim_change event to stdout (NDJSON)
    if (result.event) {
        const writer = new NdjsonWriter();
        writer.write({
            ts: new Date().toISOString(),
            session: name,
            kind: "claim_change",
            from: result.event.from,
            to: result.event.to,
            force: result.event.force,
        });
    }
    process.stderr.write(`Claimed session "${name}" (owner: ${sessionId}${force ? ", forced" : ""})\n`);
}
async function cmdRelease(args) {
    let name;
    let force = false;
    for (const arg of args) {
        if (arg === "--force") {
            force = true;
        }
        else if (!arg.startsWith("-") && !name) {
            name = arg;
        }
        else {
            die(`Unknown release option: ${arg}`);
        }
    }
    if (!name)
        die("release requires a session name");
    const sessionId = resolveSessionId();
    const result = lockedRelease(name, sessionId, { force });
    if (!result.success) {
        process.stderr.write(`Error: You are not the owner of session "${name}". Use --force to override.\n`);
        process.exit(3);
    }
    // Emit claim_change event
    if (result.event) {
        const writer = new NdjsonWriter();
        writer.write({
            ts: new Date().toISOString(),
            session: name,
            kind: "claim_change",
            from: result.event.from,
            to: result.event.to,
            force: result.event.force,
        });
    }
    process.stderr.write(`Released session "${name}"\n`);
}
async function cmdInfo(args) {
    const name = args[0];
    if (!name)
        die("info requires a session name");
    // Use full metadata with R5 fields
    const fullMeta = readFullMetadata(name);
    if (!fullMeta)
        die(`Session "${name}" not found`);
    const active = isSessionActive(name);
    const staleness = checkStaleness(fullMeta);
    const info = {
        ...fullMeta,
        active,
        idle_for_ms: staleness.idle_for_ms,
        stale: staleness.stale,
        orphaned: staleness.orphaned,
    };
    process.stdout.write(JSON.stringify(info, null, 2) + "\n");
}
// ── Main ───────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        process.stdout.write(usage() + "\n");
        return;
    }
    if (args[0] === "--version" || args[0] === "-V") {
        process.stdout.write(`holdpty v${VERSION}\n`);
        return;
    }
    const cmd = args[0];
    const rest = args.slice(1);
    switch (cmd) {
        case "launch":
            await cmdLaunch(rest);
            break;
        case "__holder":
            await cmdHolder(rest);
            break;
        case "wait":
            await cmdWait(rest);
            break;
        case "attach":
            await cmdAttach(rest);
            break;
        case "view":
            await cmdView(rest);
            break;
        case "logs":
            await cmdLogs(rest);
            break;
        case "send":
            await cmdSend(rest);
            break;
        case "ls":
            await cmdLs(rest);
            break;
        case "stop":
            await cmdStop(rest);
            break;
        case "info":
            await cmdInfo(rest);
            break;
        case "watch":
            await cmdWatch(rest);
            break;
        case "tail-events":
            await cmdTailEvents(rest);
            break;
        case "claim":
            await cmdClaim(rest);
            break;
        case "release":
            await cmdRelease(rest);
            break;
        default:
            die(`Unknown command: ${cmd}\nRun 'holdpty --help' for usage`);
    }
}
main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map