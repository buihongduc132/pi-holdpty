/**
 * CLI argument parsing and subcommand logic for new pi-holdpty commands:
 * watch, wait (extended), tail-events.
 *
 * These are extracted from cli.ts for testability.
 */
import { WatcherFilter, } from "./watcher-filter.js";
// ── Argument parsers ─────────────────────────────────────────────
export function parseWatchArgs(args) {
    const result = {
        patterns: [],
        labels: [],
        debounceMs: 100,
        maxBufferBytes: 8192,
        from: "now",
    };
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "--all") {
            result.all = true;
            i++;
        }
        else if (arg === "--pattern" && i + 1 < args.length) {
            result.patterns.push(args[++i]);
            i++;
        }
        else if (arg === "--label" && i + 1 < args.length) {
            result.labels.push(args[++i]);
            i++;
        }
        else if (arg === "--debounce" && i + 1 < args.length) {
            result.debounceMs = parseInt(args[++i], 10);
            i++;
        }
        else if (arg === "--max-buffer" && i + 1 < args.length) {
            result.maxBufferBytes = parseInt(args[++i], 10);
            i++;
        }
        else if (arg === "--from" && i + 1 < args.length) {
            const val = args[++i];
            if (val !== "start" && val !== "now") {
                throw new Error(`--from must be "start" or "now", got "${val}"`);
            }
            result.from = val;
            i++;
        }
        else if (arg === "--exit-on" && i + 1 < args.length) {
            result.exitOn = args[++i];
            i++;
        }
        else if (!arg.startsWith("-") && !result.session) {
            result.session = arg;
            i++;
        }
        else {
            throw new Error(`Unknown watch option: ${arg}`);
        }
    }
    if (!result.session && !result.all) {
        throw new Error("watch requires a session name or --all");
    }
    if (result.patterns.length === 0) {
        throw new Error("watch requires at least one --pattern");
    }
    return result;
}
export function parseTailEventsArgs(args) {
    const result = {
        patterns: [],
        labels: [],
        debounceMs: 100,
        maxBufferBytes: 8192,
    };
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "--all") {
            result.all = true;
            i++;
        }
        else if (arg === "--pattern" && i + 1 < args.length) {
            result.patterns.push(args[++i]);
            i++;
        }
        else if (arg === "--label" && i + 1 < args.length) {
            result.labels.push(args[++i]);
            i++;
        }
        else if (arg === "--debounce" && i + 1 < args.length) {
            result.debounceMs = parseInt(args[++i], 10);
            i++;
        }
        else if (arg === "--max-buffer" && i + 1 < args.length) {
            result.maxBufferBytes = parseInt(args[++i], 10);
            i++;
        }
        else if (!arg.startsWith("-") && !result.session) {
            result.session = arg;
            i++;
        }
        else {
            throw new Error(`Unknown tail-events option: ${arg}`);
        }
    }
    if (!result.session && !result.all) {
        throw new Error("tail-events requires a session name or --all");
    }
    return result;
}
export function parseWaitArgs(args) {
    const session = args[0];
    if (!session) {
        throw new Error("wait requires a session name");
    }
    return { session };
}
/**
 * Creates a watcher filter that pipes events to an NDJSON writer.
 * Returns the filter so callers can feed data to it.
 */
export function createWatcherPipeline(opts) {
    const { session, patterns, debounceMs, maxBufferBytes, writer, exitOnPattern, onExit } = opts;
    // Guard against re-entrant flush: flush() triggers onEvent for buffered
    // entries, which may match exitOnPattern and call flush() again.
    let exitTriggered = false;
    const filter = new WatcherFilter({
        session,
        patterns,
        debounceMs,
        maxBufferBytes,
        onEvent: (event) => {
            writer.write(event);
            // Check --exit-on: if a match event's line matches the exitOn regex
            if (exitOnPattern &&
                !exitTriggered &&
                event.kind === "match" &&
                exitOnPattern.test(event.line)) {
                exitTriggered = true;
                // Flush remaining buffered events and signal exit
                filter.flush();
                onExit?.();
            }
        },
    });
    return filter;
}
//# sourceMappingURL=cli-commands.js.map