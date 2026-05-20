/**
 * TDD-B Phase 2: T8-B (Context rendering)
 * RED → GREEN
 */

import { describe, it, expect } from "vitest";
import { renderContext, formatDuration, type SessionForRender } from "./context-render.js";
import { DEFAULTS, type HoldptyContextConfig } from "./config.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeCfg(overrides: Partial<HoldptyContextConfig> = {}): HoldptyContextConfig {
  return { ...DEFAULTS, ...overrides };
}

function makeSession(overrides: Partial<SessionForRender> = {}): SessionForRender {
  const now = Date.now();
  return {
    name: "test-session",
    created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    owner_session: "s_abc123",
    owner_pid: process.pid,
    owner_alive: true,
    origin_session: "s_abc123",
    last_interaction_at: new Date(now - 4 * 60 * 1000).toISOString(), // 4m ago
    last_interaction_by: "s_abc123",
    stale: false,
    orphaned: false,
    idle_for_ms: 4 * 60 * 1000,
    ...overrides,
  };
}

// ── Duration Formatting ──────────────────────────────────────────

describe("formatDuration", () => {
  it("formats hours and minutes", () => expect(formatDuration(2 * 3600000 + 13 * 60000)).toBe("2h13m"));
  it("formats minutes only", () => expect(formatDuration(18 * 60000)).toBe("18m"));
  it("formats days and hours", () => expect(formatDuration(2 * 86400000 + 3 * 3600000)).toBe("2d3h"));
  it("formats 'just now' for <60s", () => expect(formatDuration(30000)).toBe("just now"));
  it("handles 0", () => expect(formatDuration(0)).toBe("just now"));
  it("handles negative (clamps to 0)", () => expect(formatDuration(-5000)).toBe("just now"));
});

// ── T8-B — Context Rendering ─────────────────────────────────────

describe("T8-B — Context Rendering", () => {
  const now = Date.now();

  // T8-05: 3 sessions: healthy, stale-orphaned, different-origin
  it("T8-05: renders 3 sessions with stale warning and different origin", () => {
    const sessions: SessionForRender[] = [
      makeSession({ name: "build-server" }),
      makeSession({
        name: "log-tail",
        owner_session: "s_xyz999",
        owner_alive: false,
        stale: true,
        orphaned: true,
        idle_for_ms: 4 * 60 * 60 * 1000 + 12 * 60 * 1000,
        last_interaction_by: "s_xyz999",
      }),
      makeSession({
        name: "migration-run",
        owner_session: "s_def456",
        origin_session: "s_orig000",
        created_at: new Date(now - 18 * 60 * 1000).toISOString(),
        idle_for_ms: 18 * 60 * 1000,
        last_interaction_by: "s_def456",
      }),
    ];

    const output = renderContext(sessions, makeCfg(), now);
    // All 3 names present
    expect(output).toContain("build-server");
    expect(output).toContain("log-tail");
    expect(output).toContain("migration-run");
    // Stale has warning + claim hint
    expect(output).toContain("STALE");
    expect(output).toContain("holdpty claim log-tail");
    // Different-origin shows origin
    expect(output).toContain("(origin s_orig000)");
  });

  // T8-06: 0 sessions
  it("T8-06: 0 sessions returns empty string", () => {
    const output = renderContext([], makeCfg(), now);
    expect(output).toBe("");
  });

  // T8-07: maxSessions cap
  it("T8-07: 25 sessions with maxSessions=20 shows 20 + ellipsis", () => {
    const sessions = Array.from({ length: 25 }, (_, i) =>
      makeSession({ name: `session-${i}` }),
    );
    const output = renderContext(sessions, makeCfg({ maxSessions: 20 }), now);
    expect(output).toContain("... and 5 more");
    // Count session lines (lines starting with "- ")
    const sessionLines = output.split("\n").filter((l) => l.startsWith("- "));
    expect(sessionLines.length).toBe(20);
  });

  // T8-08: origin suppressed when same as owner
  it("T8-08: origin suppressed when same as owner with includeOriginOnlyIfDifferent=true", () => {
    const sessions = [
      makeSession({ name: "same-origin", owner_session: "s_A", origin_session: "s_A" }),
    ];
    const output = renderContext(sessions, makeCfg({ includeOriginOnlyIfDifferent: true }), now);
    expect(output).not.toContain("(origin s_A)");
  });

  // T8-09: quietBelowAgeMs filters young sessions
  it("T8-09: session younger than quietBelowAgeMs is excluded", () => {
    const sessions = [
      makeSession({
        name: "young-session",
        created_at: new Date(now - 30 * 1000).toISOString(), // 30s ago
      }),
    ];
    const output = renderContext(sessions, makeCfg({ quietBelowAgeMs: 60000 }), now);
    expect(output).toBe("");
  });

  // T8-10: warnOnOrphaned=false suppresses orphan warning
  it("T8-10: warnOnOrphaned=false suppresses orphan warning line", () => {
    const sessions = [
      makeSession({
        name: "orphaned-session",
        orphaned: true,
        stale: false,
        owner_alive: false,
      }),
    ];
    const output = renderContext(sessions, makeCfg({ warnOnOrphaned: false }), now);
    expect(output).not.toContain("STALE");
  });

  // C-11: maxSessions=0 → only ellipsis
  it("C-11: maxSessions=0 shows only ellipsis line, no sessions", () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      makeSession({ name: `s-${i}` }),
    );
    const output = renderContext(sessions, makeCfg({ maxSessions: 0 }), now);
    expect(output).toContain("... and 5 more");
    const sessionLines = output.split("\n").filter((l) => l.startsWith("- "));
    expect(sessionLines.length).toBe(0);
  });

  // D-18: PID alive but recycled — display says "[PID alive]" or "[running]", not "[confirmed]"
  it("D-18: owner_alive=true says [running], acceptable wording for PID-recycle case", () => {
    const sessions = [
      makeSession({ name: "recycled", owner_alive: true }),
    ];
    const output = renderContext(sessions, makeCfg(), now);
    expect(output).toContain("[running]");
    // Should NOT contain "[confirmed]" or "[verified]"
    expect(output).not.toContain("[confirmed]");
    expect(output).not.toContain("[verified]");
  });

  // Header shows count
  it("header shows correct session count", () => {
    const sessions = [makeSession({ name: "s1" }), makeSession({ name: "s2" })];
    const output = renderContext(sessions, makeCfg(), now);
    expect(output).toContain("[pi-holdpty — 2 active PTYs]");
  });

  // Rules footer present
  it("includes rules footer about ownership", () => {
    const sessions = [makeSession()];
    const output = renderContext(sessions, makeCfg(), now);
    expect(output).toContain("1 session = 1 PTY owner");
    expect(output).toContain("--force-claim");
  });
});
