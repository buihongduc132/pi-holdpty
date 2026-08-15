/**
 * Fixed-size circular byte buffer for raw terminal output.
 *
 * Stores up to `capacity` bytes. Older data is silently overwritten
 * when the buffer wraps. No allocations after construction.
 */
/** Default buffer size: 1 MB */
export declare const DEFAULT_CAPACITY: number;
export declare class RingBuffer {
    private readonly buf;
    private readonly capacity;
    /** Next write position (mod capacity) */
    private head;
    /** Total bytes ever written (used to detect wrap) */
    private written;
    constructor(capacity?: number);
    /**
     * Write data into the buffer. May overwrite old data if it wraps.
     */
    write(data: Uint8Array): void;
    /**
     * Read all buffered data as a contiguous Buffer.
     * Returns up to `capacity` bytes (the most recent data).
     */
    read(): Buffer;
    /**
     * Number of readable bytes currently in the buffer.
     */
    get size(): number;
    /**
     * Total bytes written since creation (may exceed capacity).
     */
    get totalWritten(): number;
    /**
     * Reset the buffer to empty.
     */
    clear(): void;
}
