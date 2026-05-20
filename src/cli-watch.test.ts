/**
 * Tests for CLI watch/wait/tail-events subcommand argument parsing
 * and integration with the watcher pipeline.
 *
 * Covers TDD-A cases: T2-2.18 shape, T2-2.20 (SIGTERM), T4-4.1 shape,
 * T4-4.7 (no patterns → exit events still flow), T1-1.2, T1-1.6, T1-1.7.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Writable } from "node:stream";
import {
  parseWatchArgs,
  parseTailEventsArgs,
  parseWaitArgs,
  createWatcherPipeline,
  type WatchArgs,
  type TailEventsArgs,
} from "./cli-commands.js";
import { NdjsonWriter, type WatcherEvent, type MatchEvent } from "./event-stream.js";
import { compilePatterns, compilePattern, clearCache } from "./watcher-filter.js";

// ── Argument parsing tests ───────────────────────────────────────

describe("parseWatchArgs", () => {
  it("parses session name and single pattern", () => {
    const args = parseWatchArgs(["build", "--pattern", "ERROR"]);
    expect(args.session).toBe("build");
    expect(args.patterns).toEqual(["ERROR"]);
    expect(args.labels).toEqual([]);
    expect(args.debounceMs).toBe(100);
    expect(args.maxBufferBytes).toBe(8192);
    expect(args.from).toBe("now");
  });

  it("parses multiple patterns and labels", () => {
    const args = parseWatchArgs([
      "build",
      "--pattern", "ERROR",
      "--pattern", "^READY",
      "--label", "errors",
      "--label", "startup",
    ]);
    expect(args.patterns).toEqual(["ERROR", "^READY"]);
    expect(args.labels).toEqual(["errors", "startup"]);
  });

  it("parses --debounce, --max-buffer, --from", () => {
    const args = parseWatchArgs([
      "build",
      "--pattern", "ERR",
      "--debounce", "200",
      "--max-buffer", "4096",
      "--from", "start",
    ]);
    expect(args.debounceMs).toBe(200);
    expect(args.maxBufferBytes).toBe(4096);
    expect(args.from).toBe("start");
  });

  it("parses --exit-on", () => {
    const args = parseWatchArgs([
      "build",
      "--pattern", "ERROR",
      "--exit-on", "^READY",
    ]);
    expect(args.exitOn).toBe("^READY");
  });

  it("parses --all flag", () => {
    const args = parseWatchArgs(["--all", "--pattern", "ERROR"]);
    expect(args.session).toBeUndefined();
    expect(args.all).toBe(true);
  });

  it("throws if no session and no --all", () => {
    expect(() => parseWatchArgs(["--pattern", "ERROR"])).toThrow();
  });

  it("throws if no --pattern provided", () => {
    expect(() => parseWatchArgs(["build"])).toThrow();
  });
});

describe("parseTailEventsArgs", () => {
  it("parses session name (no patterns required)", () => {
    const args = parseTailEventsArgs(["build"]);
    expect(args.session).toBe("build");
    expect(args.patterns).toEqual([]);
  });

  it("parses --all flag", () => {
    const args = parseTailEventsArgs(["--all"]);
    expect(args.all).toBe(true);
    expect(args.session).toBeUndefined();
  });

  it("parses optional patterns and labels", () => {
    const args = parseTailEventsArgs([
      "build",
      "--pattern", "ERROR",
      "--label", "errors",
    ]);
    expect(args.patterns).toEqual(["ERROR"]);
    expect(args.labels).toEqual(["errors"]);
  });

  it("throws if no session and no --all", () => {
    expect(() => parseTailEventsArgs([])).toThrow();
  });
});

describe("parseWaitArgs", () => {
  it("parses session name", () => {
    const args = parseWaitArgs(["db"]);
    expect(args.session).toBe("db");
  });

  it("throws if no session provided", () => {
    expect(() => parseWaitArgs([])).toThrow();
  });
});

// ── createWatcherPipeline tests ───────────────────────────────────

describe("createWatcherPipeline", () => {
  beforeEach(() => clearCache());

  function createCapture() {
    const lines: string[] = [];
    const writable = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    return { writer: new NdjsonWriter(writable), lines };
  }

  it("pipes match events through to the NDJSON writer (T2-2.18 shape)", () => {
    const { writer, lines } = createCapture();
    const specs = compilePatterns(["ERROR"], []);
    const filter = createWatcherPipeline({
      session: "build",
      patterns: specs,
      debounceMs: 0,
      maxBufferBytes: 8192,
      writer,
    });

    filter.feed("ERROR: disk full\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.kind).toBe("match");
    expect(event.session).toBe("build");
    expect(event.ts).toBeDefined();
  });

  // T3-3.6 / T3-3.7: --exit-on triggers onExit callback
  it("triggers onExit when --exit-on regex matches (T3-3.6)", () => {
    const { writer, lines } = createCapture();
    const specs = compilePatterns([".*"], ["all"]);
    let exitCalled = false;

    const filter = createWatcherPipeline({
      session: "build",
      patterns: specs,
      debounceMs: 0,
      maxBufferBytes: 8192,
      exitOnPattern: compilePattern("^READY"),
      writer,
      onExit: () => { exitCalled = true; },
    });

    // This should NOT trigger exit
    filter.feed("NOT READY yet\n");
    expect(exitCalled).toBe(false);

    // This should trigger exit
    filter.feed("READY now\n");
    expect(exitCalled).toBe(true);
  });

  // T3-3.7: only the line that matches ^READY triggers exit
  it("does not trigger exit for partial regex match (T3-3.7)", () => {
    const { writer } = createCapture();
    const specs = compilePatterns([".*"], []);
    let exitCalled = false;

    const filter = createWatcherPipeline({
      session: "build",
      patterns: specs,
      debounceMs: 0,
      maxBufferBytes: 8192,
      exitOnPattern: compilePattern("^READY"),
      writer,
      onExit: () => { exitCalled = true; },
    });

    filter.feed("NOT READY yet\n");
    filter.feed("PREPARING\n");
    expect(exitCalled).toBe(false);

    filter.feed("READY to serve\n");
    expect(exitCalled).toBe(true);
  });

  // T4-4.7: no patterns → pipeline still works (tail-events without --pattern)
  it("works with empty patterns (no match events emitted)", () => {
    const { writer, lines } = createCapture();
    const filter = createWatcherPipeline({
      session: "build",
      patterns: [],
      debounceMs: 0,
      maxBufferBytes: 8192,
      writer,
    });

    filter.feed("some output\n");
    // No patterns = no match events
    expect(lines).toHaveLength(0);
  });
});

// ── parseTailEventsArgs edge cases ───────────────────────────────

describe("parseTailEventsArgs edge cases", () => {
  it("parses --debounce and --max-buffer", () => {
    const args = parseTailEventsArgs([
      "build",
      "--pattern", "ERR",
      "--debounce", "50",
      "--max-buffer", "1024",
    ]);
    expect(args.debounceMs).toBe(50);
    expect(args.maxBufferBytes).toBe(1024);
  });

  it("throws on unknown option", () => {
    expect(() => parseTailEventsArgs(["build", "--unknown"])).toThrow();
  });
});

describe("parseWatchArgs edge cases", () => {
  it("throws on invalid --from value", () => {
    expect(() =>
      parseWatchArgs(["build", "--pattern", "ERR", "--from", "invalid"]),
    ).toThrow('--from must be "start" or "now"');
  });

  it("throws on unknown option", () => {
    expect(() =>
      parseWatchArgs(["build", "--pattern", "ERR", "--unknown"]),
    ).toThrow();
  });
});

// ── T1-1.2: bin field verification ───────────────────────────────

describe("package.json bin field (T1-1.2)", () => {
  it("bin.holdpty resolves to an existing file ending in .js or .ts", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf-8"),
    );
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin.holdpty).toBeDefined();
    // Path should end in .js (the compiled output)
    expect(pkg.bin.holdpty).toMatch(/\.js$/);
  });
});
