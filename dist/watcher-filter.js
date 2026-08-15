/**
 * Regex compile cache, debounce/coalesce, and max-buffer guard
 * for the watcher pipeline.
 *
 * Per R10: regex compile cached per-pattern per-process.
 * Per R2: debounce per (session, pattern, label) tuple;
 *         coalesce within debounce window; max-buffer overflow
 *         drops oldest and emits a "dropped" event.
 */
import { makeMatchEvent, makeDroppedEvent, } from "./event-stream.js";
// ── Regex compile cache (LRU, max 1024) ─────────────────────────
const CACHE_MAX = 1024;
/** Map<pattern_string, RegExp> — insertion order = LRU order */
const regexCache = new Map();
/**
 * Return true if `pattern` is a pure literal (no regex metacharacters).
 */
export function isLiteralPattern(pattern) {
    return /^[^.*+?^${}()|[\]\\]+$/.test(pattern);
}
/**
 * Compile a regex pattern with caching.
 * Returns the cached RegExp if available; otherwise creates, caches, and returns it.
 * LRU eviction when cache exceeds CACHE_MAX.
 */
export function compilePattern(pattern, flags) {
    const key = flags ? `${pattern}|||${flags}` : pattern;
    const existing = regexCache.get(key);
    if (existing) {
        // Move to end (most recently used)
        regexCache.delete(key);
        regexCache.set(key, existing);
        return existing;
    }
    const re = new RegExp(pattern, flags);
    regexCache.set(key, re);
    // Evict oldest if over capacity
    if (regexCache.size > CACHE_MAX) {
        const oldest = regexCache.keys().next().value;
        if (oldest !== undefined) {
            regexCache.delete(oldest);
        }
    }
    return re;
}
/**
 * Get the current regex cache size (for testing).
 */
export function cacheSize() {
    return regexCache.size;
}
/**
 * Clear the regex cache (for testing).
 */
export function clearCache() {
    regexCache.clear();
}
/**
 * Compile a list of (pattern, label?) specs into PatternSpec objects.
 */
export function compilePatterns(patterns, labels) {
    return patterns.map((p, i) => ({
        pattern: p,
        label: labels[i] || undefined,
        regex: compilePattern(p),
    }));
}
/**
 * Test a single line against all patterns. Returns all matching specs.
 */
export function matchLine(line, specs) {
    const matches = [];
    for (const spec of specs) {
        if (spec.regex.test(line)) {
            matches.push(spec);
        }
    }
    return matches;
}
/**
 * Stateful watcher filter that processes lines, applies pattern matching,
 * debounce/coalesce, and max-buffer overflow detection.
 */
export class WatcherFilter {
    session;
    patterns;
    debounceMs;
    maxBufferBytes;
    onEvent;
    /** Debounce state keyed by "pattern|||label" */
    debounceMap = new Map();
    /** Current buffered bytes for backpressure */
    bufferedBytes = 0;
    lineNo = 0;
    pendingPartial = "";
    constructor(opts) {
        this.session = opts.session;
        this.patterns = opts.patterns;
        this.debounceMs = opts.debounceMs;
        this.maxBufferBytes = opts.maxBufferBytes;
        this.onEvent = opts.onEvent;
    }
    /**
     * Feed raw data (may contain multiple lines or partial lines).
     * Lines are delimited by \n.
     */
    feed(data) {
        const text = typeof data === "string" ? data : data.toString("utf-8");
        const combined = this.pendingPartial + text;
        const lines = combined.split("\n");
        // Last element is partial (no trailing \n) or empty string if ended with \n
        this.pendingPartial = lines.pop() ?? "";
        for (const line of lines) {
            this.processLine(line);
        }
    }
    /**
     * Process a complete line against all patterns.
     */
    processLine(line) {
        this.lineNo++;
        const lineBytes = Buffer.byteLength(line, "utf-8");
        // Max-buffer guard
        this.bufferedBytes += lineBytes;
        if (this.bufferedBytes > this.maxBufferBytes) {
            // Calculate how many lines worth were dropped
            const dropped = makeDroppedEvent({
                session: this.session,
                count: 1, // We track per-line drops
                reason: "max-buffer-overflow",
            });
            this.onEvent(dropped);
            this.bufferedBytes = 0; // Reset after drop event
            return;
        }
        const matched = matchLine(line, this.patterns);
        for (const spec of matched) {
            this.handleMatch(spec, line, this.lineNo);
        }
        // Drain buffered bytes after processing (consumer "read" the line)
        this.bufferedBytes -= lineBytes;
        if (this.bufferedBytes < 0)
            this.bufferedBytes = 0;
    }
    /**
     * Handle a single pattern match with debounce/coalesce.
     */
    handleMatch(spec, line, lineNo) {
        const key = `${spec.pattern}|||${spec.label ?? ""}`;
        if (this.debounceMs <= 0) {
            // No debounce: emit immediately
            this.onEvent(makeMatchEvent({
                session: this.session,
                pattern: spec.pattern,
                line,
                line_no: lineNo,
                label: spec.label,
                coalesced_count: 0,
            }));
            return;
        }
        const existing = this.debounceMap.get(key);
        if (existing) {
            // Coalesce: increment count
            existing.count++;
            return;
        }
        // First match in this debounce window
        const event = makeMatchEvent({
            session: this.session,
            pattern: spec.pattern,
            line,
            line_no: lineNo,
            label: spec.label,
            coalesced_count: 0,
        });
        const entry = {
            event,
            count: 0,
            timer: null,
        };
        entry.timer = setTimeout(() => {
            entry.event.coalesced_count = entry.count;
            this.onEvent(entry.event);
            this.debounceMap.delete(key);
        }, this.debounceMs);
        this.debounceMap.set(key, entry);
    }
    /**
     * Flush all pending debounce timers immediately (used on shutdown).
     */
    flush() {
        for (const [key, entry] of this.debounceMap) {
            if (entry.timer)
                clearTimeout(entry.timer);
            entry.event.coalesced_count = entry.count;
            this.onEvent(entry.event);
        }
        this.debounceMap.clear();
        // Process any remaining partial line
        if (this.pendingPartial) {
            this.processLine(this.pendingPartial);
            this.pendingPartial = "";
        }
    }
    /**
     * Destroy all timers (for cleanup without emitting).
     */
    destroy() {
        for (const [, entry] of this.debounceMap) {
            if (entry.timer)
                clearTimeout(entry.timer);
        }
        this.debounceMap.clear();
    }
    /**
     * Get current line count (for testing).
     */
    get currentLineNo() {
        return this.lineNo;
    }
}
//# sourceMappingURL=watcher-filter.js.map