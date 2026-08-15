/**
 * NDJSON event emitter for pi-holdpty.
 *
 * Single writer per process — all events go through one serialized channel
 * to guarantee no interleaved partial JSON lines on stdout.
 *
 * Event shapes match architecture.md NDJSON event specifications.
 */
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
export type WatcherEvent = MatchEvent | ExitEvent | DroppedEvent | ClaimChangeEvent | StaleWarningEvent;
/**
 * Serializes events to NDJSON on a writable stream.
 * Guarantees: one complete JSON object per line, no interleaving.
 * All string fields are JSON-escaped (embedded newlines become \\n).
 */
export declare class NdjsonWriter {
    private readonly out;
    private _writeCount;
    constructor(out?: NodeJS.WritableStream);
    /**
     * Write a single event as one NDJSON line.
     * JSON.stringify handles escaping of embedded newlines, quotes, etc.
     */
    write(event: WatcherEvent): boolean;
    get writeCount(): number;
}
export declare function makeMatchEvent(opts: {
    session: string;
    pattern: string;
    line: string;
    line_no: number;
    label?: string;
    coalesced_count?: number;
    ts?: string;
}): MatchEvent;
export declare function makeExitEvent(opts: {
    session: string;
    exit_code: number | null;
    signal?: string | null;
    duration_ms: number;
    last_line?: string;
    ts?: string;
}): ExitEvent;
export declare function makeDroppedEvent(opts: {
    session: string;
    count: number;
    reason?: string;
    ts?: string;
}): DroppedEvent;
