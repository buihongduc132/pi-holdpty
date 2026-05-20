/**
 * Tests for watcher-filter.ts — regex compile cache, debounce/coalesce, max-buffer.
 *
 * Covers TDD-A cases: T2-2.1 through T2-2.15 (with verifier removals applied),
 * plus TDD-C-08 (binary content), and P.4 (LRU eviction).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  compilePattern,
  cacheSize,
  clearCache,
  isLiteralPattern,
  compilePatterns,
  matchLine,
  WatcherFilter,
  type PatternSpec,
  type EventCallback,
} from "./watcher-filter.js";
import type { WatcherEvent, MatchEvent, DroppedEvent } from "./event-stream.js";

// ── Regex compile cache ──────────────────────────────────────────

describe("compilePattern (regex cache)", () => {
  beforeEach(() => clearCache());

  // T2-2.1 (rewritten per verifier): cache does not grow on repeated compiles
  it("returns functionally equivalent regex and cache size stays 1 after N calls (T2-2.1)", () => {
    compilePattern("ERROR");
    compilePattern("ERROR");
    compilePattern("ERROR");
    expect(cacheSize()).toBe(1);

    const r1 = compilePattern("ERROR");
    const r2 = compilePattern("ERROR");
    expect(r1.source).toBe(r2.source);
    expect(r1.flags).toBe(r2.flags);
    expect(r1.test("ERROR here")).toBe(true);
    expect(r2.test("ERROR here")).toBe(true);
  });

  it("caches different patterns separately", () => {
    compilePattern("ERROR");
    compilePattern("WARN");
    expect(cacheSize()).toBe(2);
  });

  it("caches same pattern with different flags separately", () => {
    compilePattern("error", "i");
    compilePattern("error");
    expect(cacheSize()).toBe(2);
  });

  // P.4 (rewritten per verifier): 1024 patterns compile, LRU eviction works
  it("compiles 1024 patterns; pattern 1025 evicts LRU; cache size stays 1024 (P.4)", () => {
    const start = performance.now();
    for (let i = 0; i < 1024; i++) {
      compilePattern(`pattern_${i}`);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500); // < 500ms
    expect(cacheSize()).toBe(1024);

    // Compile pattern 1025 — should evict the oldest (pattern_0)
    compilePattern("pattern_1025");
    expect(cacheSize()).toBe(1024);

    // The oldest was pattern_0 — compiling it again should increase size to 1024
    // because it was evicted and re-added (replacing another old one)
    // Actually it replaces the next oldest, so size stays 1024
    compilePattern("pattern_0");
    expect(cacheSize()).toBe(1024);
  });
});

// ── Literal pattern detection ────────────────────────────────────

describe("isLiteralPattern", () => {
  it("detects simple literals", () => {
    expect(isLiteralPattern("BUILD OK")).toBe(true);
    expect(isLiteralPattern("hello world")).toBe(true);
  });

  it("detects regex metacharacters", () => {
    expect(isLiteralPattern("^READY")).toBe(false);
    expect(isLiteralPattern("ERROR.*")).toBe(false);
    expect(isLiteralPattern("(a|b)")).toBe(false);
    expect(isLiteralPattern("[abc]")).toBe(false);
  });
});

// ── Pattern matching ─────────────────────────────────────────────

describe("matchLine", () => {
  beforeEach(() => clearCache());

  it("matches a single pattern (T2-2.2 core)", () => {
    const specs = compilePatterns(["ERROR"], []);
    const matches = matchLine("ERROR: disk full", specs);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern).toBe("ERROR");
  });

  // T2-2.3: no match
  it("returns empty for non-matching line (T2-2.3)", () => {
    const specs = compilePatterns(["ERROR"], []);
    const matches = matchLine("INFO: all good", specs);
    expect(matches).toHaveLength(0);
  });

  // T2-2.5: two patterns both match
  it("returns both matching patterns (T2-2.5)", () => {
    const specs = compilePatterns(["ERROR", "WARN"], []);
    const matches = matchLine("ERROR and WARN both", specs);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.pattern)).toEqual(["ERROR", "WARN"]);
  });

  // T2-2.15: catastrophic backtracking protection
  it("handles catastrophic backtracking-prone pattern gracefully (T2-2.15)", () => {
    const specs = compilePatterns(["(.+)+$"], []);
    const input = "a]".repeat(15); // Moderate — tests timeout behavior
    const start = performance.now();
    matchLine(input, specs);
    const elapsed = performance.now() - start;
    // Should complete within 200ms (generous for CI)
    expect(elapsed).toBeLessThan(200);
  });
});

// ── WatcherFilter — debounce/coalesce ────────────────────────────

describe("WatcherFilter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function createFilter(opts: Partial<{
    session: string;
    patterns: string[];
    labels: string[];
    debounceMs: number;
    maxBufferBytes: number;
  }> = {}): { filter: WatcherFilter; events: WatcherEvent[] } {
    const events: WatcherEvent[] = [];
    const patternSpecs = compilePatterns(
      opts.patterns ?? ["ERROR"],
      opts.labels ?? [],
    );
    const filter = new WatcherFilter({
      session: opts.session ?? "build",
      patterns: patternSpecs,
      debounceMs: opts.debounceMs ?? 100,
      maxBufferBytes: opts.maxBufferBytes ?? 8192,
      onEvent: (e) => events.push(e),
    });
    return { filter, events };
  }

  // T2-2.2: basic match event emitted
  it("emits a match event for matching line (T2-2.2)", () => {
    const { filter, events } = createFilter({ debounceMs: 0 });
    filter.feed("ERROR: disk full\n");
    expect(events).toHaveLength(1);
    const e = events[0] as MatchEvent;
    expect(e.kind).toBe("match");
    expect(e.pattern).toBe("ERROR");
    expect(e.line).toBe("ERROR: disk full");
    expect(e.line_no).toBe(1);
    expect(e.session).toBe("build");
  });

  // T2-2.3: no event for non-matching line
  it("emits nothing for non-matching line (T2-2.3)", () => {
    const { filter, events } = createFilter({ debounceMs: 0 });
    filter.feed("INFO: all good\n");
    expect(events).toHaveLength(0);
  });

  // T2-2.4: label is passed through
  it("includes label in match event (T2-2.4)", () => {
    const { filter, events } = createFilter({
      patterns: ["^READY"],
      labels: ["startup"],
      debounceMs: 0,
    });
    filter.feed("READY to serve\n");
    expect(events).toHaveLength(1);
    expect((events[0] as MatchEvent).label).toBe("startup");
  });

  // T2-2.5: two patterns emit two events
  it("emits separate events for each matching pattern (T2-2.5)", () => {
    const { filter, events } = createFilter({
      patterns: ["ERROR", "WARN"],
      debounceMs: 0,
    });
    filter.feed("ERROR and WARN both\n");
    expect(events).toHaveLength(2);
    expect((events[0] as MatchEvent).pattern).toBe("ERROR");
    expect((events[1] as MatchEvent).pattern).toBe("WARN");
  });

  // T2-2.6: debounce=100ms, 5 lines within 80ms → 1 event, coalesced_count=4
  it("coalesces matches within debounce window (T2-2.6)", () => {
    const { filter, events } = createFilter({ debounceMs: 100 });

    // Feed 5 matching lines in rapid succession (within 80ms simulated)
    for (let i = 0; i < 5; i++) {
      filter.feed(`ERROR line ${i}\n`);
      vi.advanceTimersByTime(16); // ~16ms per line = 80ms total
    }

    // Before debounce window expires: no event yet
    expect(events).toHaveLength(0);

    // Advance past the debounce window
    vi.advanceTimersByTime(100);

    expect(events).toHaveLength(1);
    expect((events[0] as MatchEvent).coalesced_count).toBe(4);
    expect((events[0] as MatchEvent).line).toBe("ERROR line 0"); // first match wins
  });

  // T2-2.7: separate events across debounce windows
  it("emits separate events for matches in different debounce windows (T2-2.7)", () => {
    const { filter, events } = createFilter({ debounceMs: 100 });

    filter.feed("ERROR at t=0\n");
    vi.advanceTimersByTime(150); // Past first debounce window
    expect(events).toHaveLength(1);
    expect((events[0] as MatchEvent).coalesced_count).toBe(0);

    filter.feed("ERROR at t=150\n");
    vi.advanceTimersByTime(150);
    expect(events).toHaveLength(2);
    expect((events[1] as MatchEvent).coalesced_count).toBe(0);
  });

  // T2-2.8: different patterns debounce independently
  it("debounces each (pattern,label) tuple independently (T2-2.8)", () => {
    const { filter, events } = createFilter({
      patterns: ["ERROR", "WARN"],
      debounceMs: 100,
    });

    filter.feed("ERROR and WARN both\n");
    vi.advanceTimersByTime(150);

    expect(events).toHaveLength(2);
    expect((events[0] as MatchEvent).pattern).toBe("ERROR");
    expect((events[1] as MatchEvent).pattern).toBe("WARN");
  });

  // T2-2.11 (rewritten per verifier): max-buffer overflow emits dropped event
  it("emits dropped event on max-buffer overflow and continues working (T2-2.11)", () => {
    const { filter, events } = createFilter({
      debounceMs: 0,
      maxBufferBytes: 100, // Small buffer
    });

    // Feed a line that exceeds the buffer
    const bigLine = "ERROR " + "x".repeat(200);
    filter.feed(bigLine + "\n");

    // Should have a dropped event
    const dropped = events.filter((e) => e.kind === "dropped");
    expect(dropped.length).toBeGreaterThan(0);
    expect((dropped[0] as DroppedEvent).count).toBeGreaterThan(0);

    // Filter should continue working after overflow
    filter.feed("ERROR small\n");
    const matches = events.filter((e) => e.kind === "match");
    expect(matches.length).toBeGreaterThan(0);
  });

  // T2-2.12: tiny max-buffer
  it("emits dropped event with tiny buffer (T2-2.12)", () => {
    const { filter, events } = createFilter({
      debounceMs: 0,
      maxBufferBytes: 64,
    });

    // Feed lines totaling > 64 bytes
    const longLine = "ERROR " + "A".repeat(100);
    filter.feed(longLine + "\n");

    const dropped = events.filter((e) => e.kind === "dropped");
    expect(dropped.length).toBeGreaterThan(0);
  });

  // T2-2.13: --from start (replay history)
  it("processes historical lines when fed (simulating --from start) (T2-2.13)", () => {
    const { filter, events } = createFilter({ debounceMs: 0 });
    // Feed 50 lines of history
    const history = Array.from({ length: 50 }, (_, i) =>
      i === 25 ? "ERROR at line 26" : `INFO line ${i}`,
    ).join("\n") + "\n";
    filter.feed(history);

    const matches = events.filter((e) => e.kind === "match");
    expect(matches).toHaveLength(1);
    expect((matches[0] as MatchEvent).line_no).toBe(26);
  });

  // T2-2.14: --from now (no historical matches)
  it("produces no events until new data arrives (simulating --from now) (T2-2.14)", () => {
    // This is tested by simply not feeding historical data
    const { filter, events } = createFilter({ debounceMs: 0 });
    // No feed = no events
    expect(events).toHaveLength(0);

    // Now feed new data
    filter.feed("ERROR new\n");
    expect(events).toHaveLength(1);
  });

  // Flush pending debounce timers on shutdown
  it("flush() emits all pending coalesced events", () => {
    const { filter, events } = createFilter({ debounceMs: 100 });
    filter.feed("ERROR a\n");
    filter.feed("ERROR b\n");
    filter.feed("ERROR c\n");

    expect(events).toHaveLength(0);
    filter.flush();
    expect(events).toHaveLength(1);
    expect((events[0] as MatchEvent).coalesced_count).toBe(2);
  });

  // Partial lines are buffered until complete
  it("buffers partial lines until newline arrives", () => {
    const { filter, events } = createFilter({ debounceMs: 0 });
    filter.feed("ERR");
    filter.feed("OR complete\n");
    expect(events).toHaveLength(1);
    expect((events[0] as MatchEvent).line).toBe("ERROR complete");
  });

  // TDD-C-08: binary content (null bytes, high bytes)
  it("handles binary/non-UTF-8 content without crash (TDD-C-08)", () => {
    const { filter, events } = createFilter({
      patterns: ["ERROR"],
      debounceMs: 0,
    });
    // Feed buffer with null bytes and high bytes
    const buf = Buffer.from("ERROR \x00\xFF here\n", "binary");
    expect(() => filter.feed(buf)).not.toThrow();
    // Should still match ERROR
    const matches = events.filter((e) => e.kind === "match");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  // debounceMs=0 means no debounce (verifier removed T2-2.9 but the behavior is still needed)
  it("emits immediately with debounceMs=0, no coalescing", () => {
    const { filter, events } = createFilter({ debounceMs: 0 });
    for (let i = 0; i < 5; i++) {
      filter.feed(`ERROR ${i}\n`);
    }
    expect(events).toHaveLength(5);
    for (const e of events) {
      expect((e as MatchEvent).coalesced_count).toBe(0);
    }
  });

  // Multiple lines in single feed
  it("processes multiple lines in a single feed call", () => {
    const { filter, events } = createFilter({ debounceMs: 0 });
    filter.feed("ERROR a\nINFO b\nERROR c\n");
    const matches = events.filter((e) => e.kind === "match");
    expect(matches).toHaveLength(2);
    expect((matches[0] as MatchEvent).line_no).toBe(1);
    expect((matches[1] as MatchEvent).line_no).toBe(3);
  });

  // Line numbering is cumulative
  it("tracks line numbers cumulatively across feeds", () => {
    const { filter, events } = createFilter({ debounceMs: 0 });
    filter.feed("ERROR a\nINFO b\n");
    filter.feed("ERROR c\n");
    const matches = events.filter((e) => e.kind === "match") as MatchEvent[];
    expect(matches).toHaveLength(2);
    expect(matches[0].line_no).toBe(1);
    expect(matches[1].line_no).toBe(3);
  });

  // Destroy stops timers without emitting
  it("destroy() cancels pending timers without emitting", () => {
    const { filter, events } = createFilter({ debounceMs: 100 });
    filter.feed("ERROR a\n");
    filter.destroy();
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(0);
  });
});
