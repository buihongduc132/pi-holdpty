/**
 * NDJSON event emitter for pi-holdpty.
 *
 * Single writer per process — all events go through one serialized channel
 * to guarantee no interleaved partial JSON lines on stdout.
 *
 * Event shapes match architecture.md NDJSON event specifications.
 */
// ── NDJSON Writer ────────────────────────────────────────────────
/**
 * Serializes events to NDJSON on a writable stream.
 * Guarantees: one complete JSON object per line, no interleaving.
 * All string fields are JSON-escaped (embedded newlines become \\n).
 */
export class NdjsonWriter {
    out;
    _writeCount = 0;
    constructor(out = process.stdout) {
        this.out = out;
    }
    /**
     * Write a single event as one NDJSON line.
     * JSON.stringify handles escaping of embedded newlines, quotes, etc.
     */
    write(event) {
        const line = JSON.stringify(event) + "\n";
        this._writeCount++;
        return this.out.write(line);
    }
    get writeCount() {
        return this._writeCount;
    }
}
// ── Event constructors ───────────────────────────────────────────
export function makeMatchEvent(opts) {
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
export function makeExitEvent(opts) {
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
export function makeDroppedEvent(opts) {
    return {
        ts: opts.ts ?? new Date().toISOString(),
        session: opts.session,
        kind: "dropped",
        count: opts.count,
        reason: opts.reason ?? "max-buffer-overflow",
    };
}
//# sourceMappingURL=event-stream.js.map