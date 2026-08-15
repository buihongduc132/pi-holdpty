/**
 * Client connections: attach, view, logs.
 *
 * Connects to a holder process over a Unix domain socket.
 */
import { type Socket } from "node:net";
import { type HelloAckPayload } from "./protocol.js";
export type ClientMode = "attach" | "view" | "logs" | "wait" | "send";
export interface ConnectOptions {
    name: string;
    mode: ClientMode;
    /**
     * If set, called for each DATA_OUT frame during replay instead of
     * writing to stdout. After REPLAY_END, live data goes to stdout directly.
     */
    onReplayData?: (payload: Buffer) => void;
    /**
     * Called synchronously when REPLAY_END is received, before the connect
     * promise resolves. Use to flush buffered replay data.
     */
    onReplayEnd?: () => void;
}
export interface ClientConnection {
    socket: Socket;
    ack: HelloAckPayload;
    /** Promise that resolves when the connection ends. Value is exit code or null. */
    done: Promise<number | null>;
}
/**
 * Connect to a session. Performs the HELLO handshake and buffer replay.
 */
export declare function connect(opts: ConnectOptions): Promise<ClientConnection>;
export interface AttachOptions {
    name: string;
}
/**
 * Attach to a session interactively.
 * Takes over the terminal (raw mode). Returns exit code or null (detach).
 */
export declare function attach(opts: AttachOptions): Promise<number | null>;
export interface ViewOptions {
    name: string;
}
/**
 * View a session (read-only live stream).
 * Writes PTY data to stdout. Returns when the session ends.
 *
 * Data output (both replay and live) is handled by connect()'s data listener.
 */
export declare function view(opts: ViewOptions): Promise<void>;
export interface LogsOptions {
    name: string;
    /** Show only the last N lines of replay. */
    tail?: number;
    /** Keep streaming live data after replay (like tail -f). */
    follow?: boolean;
    /** Skip replay entirely. Only valid with --follow. */
    noReplay?: boolean;
}
/**
 * Dump the session's output buffer to stdout and exit.
 * With --follow, keeps streaming live data after replay.
 * With --tail N, only shows the last N lines of replay.
 * With --no-replay, skips buffer replay (only valid with --follow).
 */
export declare function logs(opts: LogsOptions): Promise<void>;
export interface SendOptions {
    name: string;
    /** Data to send to the session's PTY. */
    data: Buffer;
}
/**
 * Send input to a session without attaching.
 *
 * Unlike attach, send mode does NOT take an exclusive writer lock — multiple
 * senders and an attached client can coexist. The data is written to the PTY
 * and the connection is closed immediately.
 *
 * This is the programmatic equivalent of typing into the terminal.
 */
export declare function send(opts: SendOptions): Promise<void>;
export interface WaitOptions {
    name: string;
}
/**
 * Connect to an existing session, wait for the inner process to exit,
 * and return its exit code. No PTY output is written to stdout.
 *
 * This is the network-level primitive used by both `holdpty wait <session>`
 * and the `--wait` flag on `holdpty launch`.
 */
export declare function waitForExit(opts: WaitOptions): Promise<number>;
