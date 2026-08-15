/**
 * Wire protocol: binary length-prefixed frames over Unix domain sockets.
 *
 * Frame format:
 *   [1B type] [4B length (BE u32)] [payload]
 *
 * See docs/PROTOCOL.md for the full specification.
 */
export declare const MSG: {
    readonly DATA_OUT: 1;
    readonly DATA_IN: 2;
    readonly RESIZE: 3;
    readonly EXIT: 4;
    readonly ERROR: 5;
    readonly HELLO: 6;
    readonly HELLO_ACK: 7;
    readonly REPLAY_END: 8;
};
export type MsgType = (typeof MSG)[keyof typeof MSG];
export interface Frame {
    type: MsgType;
    payload: Buffer;
}
/** Header size: 1 byte type + 4 bytes length */
export declare const HEADER_SIZE = 5;
/** Max payload size: 10 MB (anything larger is considered malformed) */
export declare const MAX_PAYLOAD: number;
/**
 * Encode a frame into a Buffer ready for socket.write().
 */
export declare function encodeFrame(type: MsgType, payload?: Buffer | Uint8Array): Buffer;
export declare function encodeDataOut(data: Buffer): Buffer;
export declare function encodeDataIn(data: Buffer): Buffer;
export declare function encodeResize(cols: number, rows: number): Buffer;
export declare function encodeExit(code: number): Buffer;
export declare function encodeError(message: string): Buffer;
export interface HelloPayload {
    mode: "attach" | "view" | "logs" | "wait" | "send";
    protocolVersion: number;
}
export declare function encodeHello(hello: HelloPayload): Buffer;
export interface HelloAckPayload {
    name: string;
    cols: number;
    rows: number;
    mode: "attach" | "view" | "logs" | "wait" | "send";
    pid: number;
}
export declare function encodeHelloAck(ack: HelloAckPayload): Buffer;
export declare function encodeReplayEnd(): Buffer;
export declare function decodeResize(payload: Buffer): {
    cols: number;
    rows: number;
};
export declare function decodeExit(payload: Buffer): {
    code: number;
};
export declare function decodeHello(payload: Buffer): HelloPayload;
export declare function decodeHelloAck(payload: Buffer): HelloAckPayload;
export declare function decodeError(payload: Buffer): string;
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
export declare class FrameDecoder {
    private buf;
    /**
     * Feed a chunk of data and yield any complete frames.
     */
    decode(chunk: Buffer): Frame[];
    /**
     * Reset internal buffer (e.g. on reconnect).
     */
    reset(): void;
}
