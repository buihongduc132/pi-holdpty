/**
 * Regex compile cache, debounce/coalesce, and max-buffer guard
 * for the watcher pipeline.
 *
 * Per R10: regex compile cached per-pattern per-process.
 * Per R2: debounce per (session, pattern, label) tuple;
 *         coalesce within debounce window; max-buffer overflow
 *         drops oldest and emits a "dropped" event.
 */
import { type WatcherEvent } from "./event-stream.js";
/**
 * Return true if `pattern` is a pure literal (no regex metacharacters).
 */
export declare function isLiteralPattern(pattern: string): boolean;
/**
 * Compile a regex pattern with caching.
 * Returns the cached RegExp if available; otherwise creates, caches, and returns it.
 * LRU eviction when cache exceeds CACHE_MAX.
 */
export declare function compilePattern(pattern: string, flags?: string): RegExp;
/**
 * Get the current regex cache size (for testing).
 */
export declare function cacheSize(): number;
/**
 * Clear the regex cache (for testing).
 */
export declare function clearCache(): void;
export interface PatternSpec {
    pattern: string;
    label?: string;
    regex: RegExp;
}
/**
 * Compile a list of (pattern, label?) specs into PatternSpec objects.
 */
export declare function compilePatterns(patterns: string[], labels: string[]): PatternSpec[];
/**
 * Test a single line against all patterns. Returns all matching specs.
 */
export declare function matchLine(line: string, specs: PatternSpec[]): PatternSpec[];
export type EventCallback = (event: WatcherEvent) => void;
export interface WatcherFilterOptions {
    session: string;
    patterns: PatternSpec[];
    debounceMs: number;
    maxBufferBytes: number;
    onEvent: EventCallback;
}
/**
 * Stateful watcher filter that processes lines, applies pattern matching,
 * debounce/coalesce, and max-buffer overflow detection.
 */
export declare class WatcherFilter {
    private readonly session;
    private readonly patterns;
    private readonly debounceMs;
    private readonly maxBufferBytes;
    private readonly onEvent;
    /** Debounce state keyed by "pattern|||label" */
    private debounceMap;
    /** Current buffered bytes for backpressure */
    private bufferedBytes;
    private lineNo;
    private pendingPartial;
    constructor(opts: WatcherFilterOptions);
    /**
     * Feed raw data (may contain multiple lines or partial lines).
     * Lines are delimited by \n.
     */
    feed(data: string | Buffer): void;
    /**
     * Process a complete line against all patterns.
     */
    private processLine;
    /**
     * Handle a single pattern match with debounce/coalesce.
     */
    private handleMatch;
    /**
     * Flush all pending debounce timers immediately (used on shutdown).
     */
    flush(): void;
    /**
     * Destroy all timers (for cleanup without emitting).
     */
    destroy(): void;
    /**
     * Get current line count (for testing).
     */
    get currentLineNo(): number;
}
