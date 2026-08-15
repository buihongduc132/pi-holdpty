/**
 * Line-based filtering for replay data.
 *
 * Operates on raw bytes, counting \n (0x0A) as line separators.
 * Used by --tail to filter ring buffer replay before writing to stdout.
 */
/**
 * Accumulates replay chunks and flushes the last N lines.
 *
 * Lines are delimited by \n (0x0A). A trailing partial line
 * (no terminating \n) counts as a line.
 */
export declare class TailBuffer {
    private chunks;
    private totalBytes;
    /**
     * Buffer a replay data chunk.
     */
    push(data: Buffer): void;
    /**
     * Return the last `lines` lines from the accumulated data.
     * If the data has fewer than `lines` lines, returns everything.
     * If `lines` is 0, returns empty buffer.
     */
    flush(lines: number): Buffer;
    /**
     * Extract data from chunk[ci][bi] to end.
     */
    private sliceFrom;
}
