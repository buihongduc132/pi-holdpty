/**
 * Fixed-size circular byte buffer for raw terminal output.
 *
 * Stores up to `capacity` bytes. Older data is silently overwritten
 * when the buffer wraps. No allocations after construction.
 */
/** Default buffer size: 1 MB */
export const DEFAULT_CAPACITY = 1024 * 1024;
export class RingBuffer {
    buf;
    capacity;
    /** Next write position (mod capacity) */
    head = 0;
    /** Total bytes ever written (used to detect wrap) */
    written = 0;
    constructor(capacity = DEFAULT_CAPACITY) {
        if (capacity <= 0) {
            throw new RangeError("RingBuffer capacity must be positive");
        }
        this.capacity = capacity;
        this.buf = Buffer.alloc(capacity);
    }
    /**
     * Write data into the buffer. May overwrite old data if it wraps.
     */
    write(data) {
        const len = data.length;
        if (len === 0)
            return;
        if (len >= this.capacity) {
            // Data is larger than the buffer — only keep the tail
            const offset = len - this.capacity;
            data.copy
                ? data.copy(this.buf, 0, offset, len)
                : this.buf.set(data.subarray(offset), 0);
            this.head = 0;
            this.written += len;
            return;
        }
        const spaceToEnd = this.capacity - this.head;
        if (len <= spaceToEnd) {
            // Fits without wrapping
            if (data.copy) {
                data.copy(this.buf, this.head);
            }
            else {
                this.buf.set(data, this.head);
            }
        }
        else {
            // Wraps around
            if (data.copy) {
                data.copy(this.buf, this.head, 0, spaceToEnd);
                data.copy(this.buf, 0, spaceToEnd, len);
            }
            else {
                this.buf.set(data.subarray(0, spaceToEnd), this.head);
                this.buf.set(data.subarray(spaceToEnd), 0);
            }
        }
        this.head = (this.head + len) % this.capacity;
        this.written += len;
    }
    /**
     * Read all buffered data as a contiguous Buffer.
     * Returns up to `capacity` bytes (the most recent data).
     */
    read() {
        const size = this.size;
        if (size === 0)
            return Buffer.alloc(0);
        if (this.written <= this.capacity) {
            // Buffer hasn't wrapped yet — data starts at 0
            return Buffer.from(this.buf.subarray(0, size));
        }
        // Buffer has wrapped — head points to the start of the oldest data
        // (which is also where the newest write ended)
        const result = Buffer.alloc(size);
        const tail = this.head; // oldest data starts here
        const firstChunk = this.capacity - tail;
        this.buf.copy(result, 0, tail, tail + firstChunk);
        this.buf.copy(result, firstChunk, 0, this.head);
        return result;
    }
    /**
     * Number of readable bytes currently in the buffer.
     */
    get size() {
        return Math.min(this.written, this.capacity);
    }
    /**
     * Total bytes written since creation (may exceed capacity).
     */
    get totalWritten() {
        return this.written;
    }
    /**
     * Reset the buffer to empty.
     */
    clear() {
        this.head = 0;
        this.written = 0;
    }
}
//# sourceMappingURL=ring-buffer.js.map