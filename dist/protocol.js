/**
 * Wire protocol: binary length-prefixed frames over Unix domain sockets.
 *
 * Frame format:
 *   [1B type] [4B length (BE u32)] [payload]
 *
 * See docs/PROTOCOL.md for the full specification.
 */
// ── Message types ──────────────────────────────────────────────────
export const MSG = {
    DATA_OUT: 0x01,
    DATA_IN: 0x02,
    RESIZE: 0x03,
    EXIT: 0x04,
    ERROR: 0x05,
    HELLO: 0x06,
    HELLO_ACK: 0x07,
    REPLAY_END: 0x08,
};
/** Header size: 1 byte type + 4 bytes length */
export const HEADER_SIZE = 5;
/** Max payload size: 10 MB (anything larger is considered malformed) */
export const MAX_PAYLOAD = 10 * 1024 * 1024;
// ── Encoding ───────────────────────────────────────────────────────
/**
 * Encode a frame into a Buffer ready for socket.write().
 */
export function encodeFrame(type, payload = Buffer.alloc(0)) {
    const frame = Buffer.alloc(HEADER_SIZE + payload.length);
    frame[0] = type;
    frame.writeUInt32BE(payload.length, 1);
    if (payload.length > 0) {
        if (payload.copy) {
            payload.copy(frame, HEADER_SIZE);
        }
        else {
            frame.set(payload, HEADER_SIZE);
        }
    }
    return frame;
}
// ── Typed encode helpers ───────────────────────────────────────────
export function encodeDataOut(data) {
    return encodeFrame(MSG.DATA_OUT, data);
}
export function encodeDataIn(data) {
    return encodeFrame(MSG.DATA_IN, data);
}
export function encodeResize(cols, rows) {
    const payload = Buffer.alloc(4);
    payload.writeUInt16BE(cols, 0);
    payload.writeUInt16BE(rows, 2);
    return encodeFrame(MSG.RESIZE, payload);
}
export function encodeExit(code) {
    const payload = Buffer.alloc(4);
    payload.writeInt32BE(code, 0);
    return encodeFrame(MSG.EXIT, payload);
}
export function encodeError(message) {
    return encodeFrame(MSG.ERROR, Buffer.from(message, "utf-8"));
}
export function encodeHello(hello) {
    return encodeFrame(MSG.HELLO, Buffer.from(JSON.stringify(hello), "utf-8"));
}
export function encodeHelloAck(ack) {
    return encodeFrame(MSG.HELLO_ACK, Buffer.from(JSON.stringify(ack), "utf-8"));
}
export function encodeReplayEnd() {
    return encodeFrame(MSG.REPLAY_END);
}
// ── Decode helpers ─────────────────────────────────────────────────
export function decodeResize(payload) {
    if (payload.length < 4)
        throw new Error("RESIZE payload too short");
    return {
        cols: payload.readUInt16BE(0),
        rows: payload.readUInt16BE(2),
    };
}
export function decodeExit(payload) {
    if (payload.length < 4)
        throw new Error("EXIT payload too short");
    return { code: payload.readInt32BE(0) };
}
export function decodeHello(payload) {
    return JSON.parse(payload.toString("utf-8"));
}
export function decodeHelloAck(payload) {
    return JSON.parse(payload.toString("utf-8"));
}
export function decodeError(payload) {
    return payload.toString("utf-8");
}
// ── Stream decoder ─────────────────────────────────────────────────
/**
 * Stateful frame decoder that handles partial reads from a TCP/UDS stream.
 *
 * Usage:
 *   const decoder = new FrameDecoder();
 *   socket.on('data', (chunk) => {
 *     for (const frame of decoder.decode(chunk)) {
 *       handleFrame(frame);
 *     }
 *   });
 */
export class FrameDecoder {
    buf = Buffer.alloc(0);
    /**
     * Feed a chunk of data and yield any complete frames.
     */
    decode(chunk) {
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        const frames = [];
        while (this.buf.length >= HEADER_SIZE) {
            const type = this.buf[0];
            const payloadLen = this.buf.readUInt32BE(1);
            if (payloadLen > MAX_PAYLOAD) {
                // Malformed — reset buffer and signal error
                this.buf = Buffer.alloc(0);
                throw new Error(`Payload too large: ${payloadLen} bytes (max ${MAX_PAYLOAD})`);
            }
            const totalLen = HEADER_SIZE + payloadLen;
            if (this.buf.length < totalLen) {
                break; // Need more data
            }
            const payload = Buffer.from(this.buf.subarray(HEADER_SIZE, totalLen));
            frames.push({ type, payload });
            this.buf = Buffer.from(this.buf.subarray(totalLen));
        }
        return frames;
    }
    /**
     * Reset internal buffer (e.g. on reconnect).
     */
    reset() {
        this.buf = Buffer.alloc(0);
    }
}
//# sourceMappingURL=protocol.js.map