/**
 * CLI argument parsing and subcommand logic for new pi-holdpty commands:
 * watch, wait (extended), tail-events.
 *
 * These are extracted from cli.ts for testability.
 */

import {
  type WatcherEvent,
  NdjsonWriter,
  makeExitEvent,
  makeMatchEvent,
} from "./event-stream.js";
import {
  compilePatterns,
  WatcherFilter,
  type PatternSpec,
} from "./watcher-filter.js";

// ── Parsed argument types ────────────────────────────────────────

export interface WatchArgs {
  session?: string;
  all?: boolean;
  patterns: string[];
  labels: string[];
  debounceMs: number;
  maxBufferBytes: number;
  from: "start" | "now";
  exitOn?: string;
}

export interface TailEventsArgs {
  session?: string;
  all?: boolean;
  patterns: string[];
  labels: string[];
  debounceMs: number;
  maxBufferBytes: number;
}

export interface WaitArgs {
  session: string;
}

// ── Argument parsers ─────────────────────────────────────────────

export function parseWatchArgs(args: string[]): WatchArgs {
  const result: WatchArgs = {
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
    } else if (arg === "--pattern" && i + 1 < args.length) {
      result.patterns.push(args[++i]);
      i++;
    } else if (arg === "--label" && i + 1 < args.length) {
      result.labels.push(args[++i]);
      i++;
    } else if (arg === "--debounce" && i + 1 < args.length) {
      result.debounceMs = parseInt(args[++i], 10);
      i++;
    } else if (arg === "--max-buffer" && i + 1 < args.length) {
      result.maxBufferBytes = parseInt(args[++i], 10);
      i++;
    } else if (arg === "--from" && i + 1 < args.length) {
      const val = args[++i];
      if (val !== "start" && val !== "now") {
        throw new Error(`--from must be "start" or "now", got "${val}"`);
      }
      result.from = val;
      i++;
    } else if (arg === "--exit-on" && i + 1 < args.length) {
      result.exitOn = args[++i];
      i++;
    } else if (!arg.startsWith("-") && !result.session) {
      result.session = arg;
      i++;
    } else {
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

export function parseTailEventsArgs(args: string[]): TailEventsArgs {
  const result: TailEventsArgs = {
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
    } else if (arg === "--pattern" && i + 1 < args.length) {
      result.patterns.push(args[++i]);
      i++;
    } else if (arg === "--label" && i + 1 < args.length) {
      result.labels.push(args[++i]);
      i++;
    } else if (arg === "--debounce" && i + 1 < args.length) {
      result.debounceMs = parseInt(args[++i], 10);
      i++;
    } else if (arg === "--max-buffer" && i + 1 < args.length) {
      result.maxBufferBytes = parseInt(args[++i], 10);
      i++;
    } else if (!arg.startsWith("-") && !result.session) {
      result.session = arg;
      i++;
    } else {
      throw new Error(`Unknown tail-events option: ${arg}`);
    }
  }

  if (!result.session && !result.all) {
    throw new Error("tail-events requires a session name or --all");
  }

  return result;
}

export function parseWaitArgs(args: string[]): WaitArgs {
  const session = args[0];
  if (!session) {
    throw new Error("wait requires a session name");
  }
  return { session };
}

// ── Watcher pipeline (used by watch and tail-events) ─────────────

export interface WatcherPipelineOptions {
  session: string;
  patterns: PatternSpec[];
  debounceMs: number;
  maxBufferBytes: number;
  exitOnPattern?: RegExp;
  writer: NdjsonWriter;
  onExit?: () => void;
}

/**
 * Creates a watcher filter that pipes events to an NDJSON writer.
 * Returns the filter so callers can feed data to it.
 */
export function createWatcherPipeline(opts: WatcherPipelineOptions): WatcherFilter {
  const { session, patterns, debounceMs, maxBufferBytes, writer, exitOnPattern, onExit } = opts;

  const filter = new WatcherFilter({
    session,
    patterns,
    debounceMs,
    maxBufferBytes,
    onEvent: (event: WatcherEvent) => {
      writer.write(event);

      // Check --exit-on: if a match event's line matches the exitOn regex
      if (
        exitOnPattern &&
        event.kind === "match" &&
        exitOnPattern.test(event.line)
      ) {
        // Flush and signal exit
        filter.flush();
        onExit?.();
      }
    },
  });

  return filter;
}
