/**
 * TDD-B Phase 2: T7 (Stale Detection + Orphan-PID + stale_warning)
 * RED → GREEN
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseDuration,
  checkStaleness,
  resolveStaleThreshold,
  checkAndEmitStaleWarning,
  resetStaleWarnings,
  clearStaleWarning,
  DEFAULT_STALE_AFTER_MS,
} from "./staleness.js";
import type { FullSessionMetadata } from "./ownership.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeMeta(overrides: Partial<FullSessionMetadata> = {}): FullSessionMetadata {
  return {
    name: "test-session",
    pid: process.pid,
    childPid: process.pid,
    command: ["echo", "hello"],
    cols: 120,
    rows: 40,
    startedAt: new Date().toISOString(),
    origin_session: "s_A",
    origin_pid: process.pid,
    owner_session: "s_A",
    owner_pid: process.pid,
    created_at: new Date().toISOString(),
    last_interaction_at: new Date().toISOString(),
    last_interaction_by: "s_A",
    claim_history: [],
    ...overrides,
  };
}

// ── Duration Parsing ─────────────────────────────────────────────

describe("Duration parsing", () => {
  it("parses hours", () => expect(parseDuration("4h")).toBe(14400000));
  it("parses minutes", () => expect(parseDuration("30m")).toBe(1800000));
  it("parses days", () => expect(parseDuration("2d")).toBe(172800000));
  it("parses milliseconds", () => expect(parseDuration("500ms")).toBe(500));
  it("parses seconds", () => expect(parseDuration("10s")).toBe(10000));
  it("parses plain number as ms", () => expect(parseDuration("14400000")).toBe(14400000));
  it("parses numeric input", () => expect(parseDuration(5000)).toBe(5000));
  it("throws on invalid format", () => expect(() => parseDuration("banana")).toThrow());
});

// ── T7 — Stale Detection ────────────────────────────────────────

describe("T7 — Stale Detection + Orphan-PID + stale_warning", () => {
  beforeEach(() => {
    resetStaleWarnings();
  });

  // T7-01: stale when idle > threshold
  it("T7-01: idle 4h01m with 4h threshold → stale:true", () => {
    const now = Date.now();
    const fourHoursOneMinuteAgo = new Date(now - (4 * 60 + 1) * 60 * 1000).toISOString();
    const meta = makeMeta({ last_interaction_at: fourHoursOneMinuteAgo });
    const result = checkStaleness(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(result.stale).toBe(true);
    expect(result.idle_for_ms).toBeGreaterThanOrEqual((4 * 60 + 1) * 60 * 1000 - 100);
    expect(result.orphaned).toBe(false);
  });

  // T7-02: not stale when idle < threshold
  it("T7-02: idle 3h59m with 4h threshold → stale:false", () => {
    const now = Date.now();
    const threeHours59MinAgo = new Date(now - (3 * 60 + 59) * 60 * 1000).toISOString();
    const meta = makeMeta({ last_interaction_at: threeHours59MinAgo });
    const result = checkStaleness(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(result.stale).toBe(false);
  });

  // T7-03: per-session --stale-after override
  it("T7-03: per-session --stale-after 30m honored; idle 31m → stale", () => {
    const now = Date.now();
    const thirtyOneMinAgo = new Date(now - 31 * 60 * 1000).toISOString();
    const meta = makeMeta({
      last_interaction_at: thirtyOneMinAgo,
      stale_after_ms: 30 * 60 * 1000,
    });
    const result = checkStaleness(meta, { now, thresholdMs: resolveStaleThreshold(meta) });
    expect(result.stale).toBe(true);
  });

  // T7-04: per-session wins over env
  it("T7-04: per-session 1h beats HOLDPTY_STALE_AFTER=2h; idle 1h30m → stale", () => {
    const now = Date.now();
    const oneHour30MinAgo = new Date(now - 90 * 60 * 1000).toISOString();
    const meta = makeMeta({
      last_interaction_at: oneHour30MinAgo,
      stale_after_ms: 60 * 60 * 1000, // 1h per-session
    });
    const threshold = resolveStaleThreshold(meta, "7200000"); // env = 2h
    expect(threshold).toBe(60 * 60 * 1000); // per-session wins
    const result = checkStaleness(meta, { now, thresholdMs: threshold });
    expect(result.stale).toBe(true);
  });

  // T7-05: orphaned PID dead, within time threshold → stale + orphaned
  it("T7-05: owner_pid dead but idle only 5m → stale + orphaned", () => {
    const now = Date.now();
    const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
    const meta = makeMeta({
      last_interaction_at: fiveMinAgo,
      owner_pid: 99999999, // dead PID
    });
    const result = checkStaleness(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(result.stale).toBe(true);
    expect(result.orphaned).toBe(true);
  });

  // T7-06: stale_warning event with all R8 required fields
  it("T7-06: stale_warning emitted with all R8 fields", () => {
    const now = Date.now();
    const fiveHoursAgo = new Date(now - 5 * 60 * 60 * 1000).toISOString();
    const meta = makeMeta({
      name: "stale-session",
      last_interaction_at: fiveHoursAgo,
      owner_session: "s_dead",
      owner_pid: 99999999,
    });
    const event = checkAndEmitStaleWarning(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(event).not.toBeNull();
    expect(event!.kind).toBe("stale_warning");
    expect(event!.session).toBe("stale-session");
    expect(event!.owner_session).toBe("s_dead");
    expect(event!.idle_for_ms).toBeGreaterThan(0);
    expect(typeof event!.orphaned).toBe("boolean");
    expect(["claim", "force-claim", "close"]).toContain(event!.suggest);
  });

  // T7-07: no re-emit on subsequent poll (once per crossing)
  it("T7-07: stale_warning not re-emitted on subsequent check", () => {
    const now = Date.now();
    const fiveHoursAgo = new Date(now - 5 * 60 * 60 * 1000).toISOString();
    const meta = makeMeta({
      name: "once-session",
      last_interaction_at: fiveHoursAgo,
      owner_pid: 99999999,
    });
    const first = checkAndEmitStaleWarning(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(first).not.toBeNull();
    const second = checkAndEmitStaleWarning(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(second).toBeNull();
  });

  // T7-08: stale → recovered → stale again → new warning
  it("T7-08: recovered then stale again → new stale_warning emitted", () => {
    const now = Date.now();
    const fiveHoursAgo = new Date(now - 5 * 60 * 60 * 1000).toISOString();
    const meta = makeMeta({
      name: "recover-session",
      last_interaction_at: fiveHoursAgo,
      owner_pid: 99999999,
    });
    // First crossing
    const first = checkAndEmitStaleWarning(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(first).not.toBeNull();

    // Recover (recent interaction)
    meta.last_interaction_at = new Date(now - 1000).toISOString();
    meta.owner_pid = process.pid; // alive
    const recovered = checkAndEmitStaleWarning(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(recovered).toBeNull(); // not stale

    // Go stale again
    meta.last_interaction_at = new Date(now - 5 * 60 * 60 * 1000).toISOString();
    meta.owner_pid = 99999999;
    const second = checkAndEmitStaleWarning(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(second).not.toBeNull(); // new crossing
  });

  // T7-09: suggest is "claim", never "force-claim" in automatic warnings
  it("T7-09: suggest is always 'claim' in automatic stale_warning, never 'force-claim'", () => {
    const now = Date.now();
    const fiveHoursAgo = new Date(now - 5 * 60 * 60 * 1000).toISOString();
    const meta = makeMeta({
      name: "suggest-session",
      last_interaction_at: fiveHoursAgo,
      owner_pid: 99999999,
    });
    const event = checkAndEmitStaleWarning(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(event).not.toBeNull();
    expect(event!.suggest).toBe("claim");
    expect(event!.suggest).not.toBe("force-claim");
  });

  // T7-10: clock skew — no crash or negative idle_for_ms
  it("T7-10: clock skew (future interaction) clamps idle_for_ms to 0", () => {
    const now = Date.now();
    const futureTime = new Date(now + 2 * 60 * 60 * 1000).toISOString(); // 2h in future
    const meta = makeMeta({ last_interaction_at: futureTime });
    const result = checkStaleness(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(result.idle_for_ms).toBeGreaterThanOrEqual(0);
    expect(result.stale).toBe(false);
  });

  // C-09: staleAfterMs=0 makes everything immediately stale
  it("C-09: threshold 0 makes 1ms-old session stale", () => {
    const now = Date.now();
    const justNow = new Date(now - 1).toISOString();
    const meta = makeMeta({ last_interaction_at: justNow });
    const result = checkStaleness(meta, { now, thresholdMs: 0 });
    expect(result.stale).toBe(true);
  });

  // D-08: negative idle_for_ms from clock skew renders gracefully
  it("D-08: negative clock drift handled gracefully (clamped to 0)", () => {
    const now = Date.now();
    // Reader's clock 5 minutes behind the writer
    const futureInteraction = new Date(now + 5 * 60 * 1000).toISOString();
    const meta = makeMeta({ last_interaction_at: futureInteraction });
    const result = checkStaleness(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(result.idle_for_ms).toBe(0);
    expect(result.stale).toBe(false);
  });

  // resolveStaleThreshold: env fallback
  it("resolveStaleThreshold uses HOLDPTY_STALE_AFTER env when no per-session override", () => {
    const meta = makeMeta({ stale_after_ms: undefined });
    const threshold = resolveStaleThreshold(meta, "1800000");
    expect(threshold).toBe(1800000);
  });

  it("resolveStaleThreshold uses default when env is invalid", () => {
    const meta = makeMeta({ stale_after_ms: undefined });
    const threshold = resolveStaleThreshold(meta, "banana");
    expect(threshold).toBe(DEFAULT_STALE_AFTER_MS);
  });

  it("resolveStaleThreshold uses per-session even with valid env", () => {
    const meta = makeMeta({ stale_after_ms: 60000 });
    const threshold = resolveStaleThreshold(meta, "1800000");
    expect(threshold).toBe(60000);
  });

  it("clearStaleWarning allows re-emission", () => {
    const now = Date.now();
    const fiveHoursAgo = new Date(now - 5 * 60 * 60 * 1000).toISOString();
    const meta = makeMeta({
      name: "clear-test",
      last_interaction_at: fiveHoursAgo,
      owner_pid: 99999999,
    });
    const first = checkAndEmitStaleWarning(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(first).not.toBeNull();
    const second = checkAndEmitStaleWarning(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(second).toBeNull(); // suppressed
    clearStaleWarning("clear-test");
    const third = checkAndEmitStaleWarning(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(third).not.toBeNull(); // re-emitted after clear
  });

  it("checkStaleness with null owner_pid is not orphaned", () => {
    const meta = makeMeta({ owner_pid: null });
    const result = checkStaleness(meta, { now: Date.now(), thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(result.orphaned).toBe(false);
  });

  it("checkStaleness falls back to created_at when last_interaction_at is null", () => {
    const now = Date.now();
    const fiveHoursAgo = new Date(now - 5 * 60 * 60 * 1000).toISOString();
    const meta = makeMeta({
      last_interaction_at: null,
      created_at: fiveHoursAgo,
    });
    const result = checkStaleness(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(result.stale).toBe(true);
    expect(result.idle_for_ms).toBeGreaterThanOrEqual(5 * 60 * 60 * 1000 - 100);
  });

  // D-07: DST-safe UTC computation
  it("D-07: UTC arithmetic is DST-proof (1h difference stays 1h)", () => {
    // DST fall-back: 2026-11-03T01:30:00Z → 2026-11-03T02:30:00Z = exactly 1h
    const created = new Date("2026-11-03T01:30:00Z").getTime();
    const now = new Date("2026-11-03T02:30:00Z").getTime();
    const meta = makeMeta({
      last_interaction_at: "2026-11-03T01:30:00Z",
      created_at: "2026-11-03T01:30:00Z",
    });
    const result = checkStaleness(meta, { now, thresholdMs: DEFAULT_STALE_AFTER_MS });
    expect(result.idle_for_ms).toBe(3600000); // exactly 1h
  });
});
