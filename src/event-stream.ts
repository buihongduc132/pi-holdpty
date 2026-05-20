/**
 * NDJSON event emitter for pi-holdpty.
 *
 * Single writer per process — all events go through one serialized channel
 * to guarantee no interleaved partial JSON lines on stdout.
 *
 * Event shapes match architecture.md NDJSON event specifications.
 */

// ── Event types ──────────────────────────────────────────────────

export interface MatchEvent {
  ts: string;
  session: string;
  kind: "match";
  label?: string;
  pattern: string;
  line: string;
  line_no: number;
  coalesced_count: number;
}

export interface ExitEvent {
  ts: string;
  session: string;
  kind: "exit";
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  last_line?: string;
}

export interface DroppedEvent {
  ts: string;
  session: string;
  kind: "dropped";
  count: number;
  reason: string;
}

export interface ClaimChangeEvent {
  ts: string;
  session: string;
  kind: "claim_change";
  from: string | null;
  to: string | null;
  force: boolean;
}

export interface StaleWarningEvent {
  ts: string;
  session: string;
  kind: "stale_warning";
  owner_session: string;
  idle_for_ms: number;
  orphaned: boolean;
  suggest: "claim" | "force-claim" | "close";
}

export type WatcherEvent =
  | MatchEvent
  | ExitEvent
  | DroppedEvent
  | ClaimChangeEvent
  | StaleWarningEvent;

// ── NDJSON Writer ────────────────────────────────────────────────

/**
 * Serializes events to NDJSON on a writable stream.
 * Guarantees: one complete JSON object per line, no interleaving.
 * All string fields are JSON-escaped (embedded newlines become \\n).
 */
export class NdjsonWriter {
  private _writeCount = 0;

  constructor(private readonly out: NodeJS.WritableStream = process.stdout) {}

  /**
   * Write a single event as one NDJSON line.
   * JSON.stringify handles escaping of embedded newlines, quotes, etc.
   */
  write(event: WatcherEvent): boolean {
    const line = JSON.stringify(event) + "\n";
    this._writeCount++;
    return this.out.write(line);
  }

  get writeCount(): number {
    return this._writeCount;
  }
}

// ── Event constructors ───────────────────────────────────────────

export function makeMatchEvent(opts: {
  session: string;
  pattern: string;
  line: string;
  line_no: number;
  label?: string;
  coalesced_count?: number;
  ts?: string;
}): MatchEvent {
  return {
    ts: opts.ts ?? new Date().toISOString(),
    session: opts.session,
    kind: "match",
    ...(opts.label != null ? { label: opts.label } : {}),
    pattern: opts.pattern,
    line: opts.line,
    line_no: opts.line_no,
    coalesced_count: opts.coalesced_count ?? 0,
  };
}

export function makeExitEvent(opts: {
  session: string;
  exit_code: number | null;
  signal?: string | null;
  duration_ms: number;
  last_line?: string;
  ts?: string;
}): ExitEvent {
  return {
    ts: opts.ts ?? new Date().toISOString(),
    session: opts.session,
    kind: "exit",
    exit_code: opts.exit_code,
    signal: opts.signal ?? null,
    duration_ms: opts.duration_ms,
    ...(opts.last_line != null ? { last_line: opts.last_line } : {}),
  };
}

export function makeDroppedEvent(opts: {
  session: string;
  count: number;
  reason?: string;
  ts?: string;
}): DroppedEvent {
  return {
    ts: opts.ts ?? new Date().toISOString(),
    session: opts.session,
    kind: "dropped",
    count: opts.count,
    reason: opts.reason ?? "max-buffer-overflow",
  };
}
