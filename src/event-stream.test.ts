/**
 * Tests for event-stream.ts — NDJSON emitter + event constructors.
 *
 * Covers TDD-A cases: T3-3.1, T3-3.2, T3-3.8, T4-4.4, and TDD-C-07.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Writable } from "node:stream";
import {
  NdjsonWriter,
  makeMatchEvent,
  makeExitEvent,
  makeDroppedEvent,
  type WatcherEvent,
} from "./event-stream.js";

/** Helper: capture NDJSON output into an array of parsed objects. */
function createCapture(): { writer: NdjsonWriter; lines: string[]; parsed: () => WatcherEvent[] } {
  const lines: string[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const writer = new NdjsonWriter(writable);
  return {
    writer,
    lines,
    parsed: () => lines.map((l) => JSON.parse(l.trimEnd())),
  };
}

describe("NdjsonWriter", () => {
  let capture: ReturnType<typeof createCapture>;

  beforeEach(() => {
    capture = createCapture();
  });

  // T4-4.4: concurrent writes produce complete JSON objects, no interleaving
  it("writes complete JSON lines with no interleaving (T4-4.4)", () => {
    const { writer, lines, parsed } = capture;
    const e1 = makeMatchEvent({
      session: "a",
      pattern: "ERR",
      line: "ERR foo",
      line_no: 1,
    });
    const e2 = makeMatchEvent({
      session: "b",
      pattern: "WARN",
      line: "WARN bar",
      line_no: 2,
    });

    writer.write(e1);
    writer.write(e2);

    expect(lines).toHaveLength(2);
    // Each line is valid JSON terminated by \n
    for (const line of lines) {
      expect(line.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const events = parsed();
    expect(events[0].session).toBe("a");
    expect(events[1].session).toBe("b");
  });

  it("tracks write count", () => {
    const { writer } = capture;
    expect(writer.writeCount).toBe(0);
    writer.write(makeMatchEvent({ session: "s", pattern: "X", line: "X", line_no: 1 }));
    expect(writer.writeCount).toBe(1);
    writer.write(makeMatchEvent({ session: "s", pattern: "Y", line: "Y", line_no: 2 }));
    expect(writer.writeCount).toBe(2);
  });
});

describe("makeMatchEvent", () => {
  // T2-2.2: match event has correct shape
  it("produces a match event with required fields (T2-2.2 shape)", () => {
    const e = makeMatchEvent({
      session: "build",
      pattern: "ERROR",
      line: "ERROR: disk full",
      line_no: 42,
      ts: "2026-05-21T00:00:00Z",
    });

    expect(e.kind).toBe("match");
    expect(e.ts).toBe("2026-05-21T00:00:00Z");
    expect(e.session).toBe("build");
    expect(e.pattern).toBe("ERROR");
    expect(e.line).toBe("ERROR: disk full");
    expect(e.line_no).toBe(42);
    expect(e.coalesced_count).toBe(0);
  });

  // T2-2.4: label is included when provided
  it("includes label when provided (T2-2.4)", () => {
    const e = makeMatchEvent({
      session: "build",
      pattern: "^READY",
      line: "READY to serve",
      line_no: 1,
      label: "startup",
    });
    expect(e.label).toBe("startup");
  });

  it("omits label when not provided", () => {
    const e = makeMatchEvent({
      session: "build",
      pattern: "ERR",
      line: "ERR",
      line_no: 1,
    });
    expect(e).not.toHaveProperty("label");
  });

  it("auto-generates ts when not provided", () => {
    const e = makeMatchEvent({
      session: "s",
      pattern: "X",
      line: "X",
      line_no: 1,
    });
    // Should be a valid ISO string
    expect(new Date(e.ts).toISOString()).toBe(e.ts);
  });
});

describe("makeExitEvent", () => {
  // T3-3.1: exit event shape for normal exit
  it("produces exit event with code=0, signal=null (T3-3.1)", () => {
    const e = makeExitEvent({
      session: "build",
      exit_code: 0,
      duration_ms: 5000,
      last_line: "done",
      ts: "2026-05-21T00:00:00Z",
    });

    expect(e.kind).toBe("exit");
    expect(e.exit_code).toBe(0);
    expect(e.signal).toBeNull();
    expect(e.duration_ms).toBe(5000);
    expect(e.last_line).toBe("done");
  });

  // T3-3.2: exit event for SIGKILL
  it("produces exit event with signal=SIGKILL (T3-3.2)", () => {
    const e = makeExitEvent({
      session: "build",
      exit_code: null,
      signal: "SIGKILL",
      duration_ms: 1000,
    });

    expect(e.kind).toBe("exit");
    expect(e.exit_code).toBeNull();
    expect(e.signal).toBe("SIGKILL");
  });

  it("omits last_line when not provided", () => {
    const e = makeExitEvent({
      session: "s",
      exit_code: 0,
      duration_ms: 100,
    });
    expect(e).not.toHaveProperty("last_line");
  });

  // TDD-C-07: embedded newline in last_line is properly JSON-escaped
  it("JSON-escapes embedded newlines in last_line (TDD-C-07)", () => {
    const e = makeExitEvent({
      session: "build",
      exit_code: 0,
      duration_ms: 100,
      last_line: "line1\nline2\nline3",
    });

    // Serialize to NDJSON and verify it's a single valid line
    const json = JSON.stringify(e);
    // The raw JSON should NOT contain an unescaped newline
    expect(json).not.toContain("\n");
    // But it should contain the escaped version
    expect(json).toContain("\\n");
    // Parse it back to verify round-trip
    const parsed = JSON.parse(json);
    expect(parsed.last_line).toBe("line1\nline2\nline3");
  });
});

describe("makeDroppedEvent", () => {
  it("produces dropped event with count and reason", () => {
    const e = makeDroppedEvent({
      session: "build",
      count: 42,
    });

    expect(e.kind).toBe("dropped");
    expect(e.count).toBe(42);
    expect(e.reason).toBe("max-buffer-overflow");
  });
});

describe("NDJSON purity with adversarial content", () => {
  // TDD-C-07 + TDD-D-21: ensure NDJSON contract holds with embedded newlines
  it("serializes events with embedded newlines as single valid JSON lines", () => {
    const { writer, lines } = createCapture();
    const e = makeMatchEvent({
      session: "build",
      pattern: "ERR",
      line: "ERROR:\n  at foo.js:10\n  at bar.js:20",
      line_no: 1,
    });
    writer.write(e);

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    // The line itself should not contain any raw newlines (only the trailing one)
    const lineContent = lines[0].slice(0, -1);
    expect(lineContent).not.toContain("\n");
    // Parse it back
    const parsed = JSON.parse(lineContent);
    expect(parsed.line).toBe("ERROR:\n  at foo.js:10\n  at bar.js:20");
  });

  // T3-3.8: match event + exit behavior fire together
  it("can write match and exit events in sequence (T3-3.8)", () => {
    const { writer, parsed } = createCapture();
    const match = makeMatchEvent({
      session: "build",
      pattern: "^READY",
      line: "READY now",
      line_no: 100,
    });
    const exit = makeExitEvent({
      session: "build",
      exit_code: 0,
      duration_ms: 5000,
    });
    writer.write(match);
    writer.write(exit);
    const events = parsed();
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("match");
    expect(events[1].kind).toBe("exit");
  });

  // Binary-ish content: null bytes, high bytes
  it("handles binary content in line field via JSON escaping (TDD-C-08 partial)", () => {
    const { writer, lines } = createCapture();
    const e = makeMatchEvent({
      session: "s",
      pattern: "X",
      line: "foo\x00bar\xFFbaz",
      line_no: 1,
    });
    writer.write(e);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });
});
