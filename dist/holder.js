/**
 * Holder process: owns the PTY, manages the ring buffer, accepts clients
 * over a Unix domain socket.
 *
 * One holder per session. No central daemon.
 */
import { createServer } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import * as pty from "node-pty";
import { RingBuffer, DEFAULT_CAPACITY } from "./ring-buffer.js";
import { MSG, FrameDecoder, encodeDataOut, encodeExit, encodeError, encodeHelloAck, encodeReplayEnd, decodeHello, decodeResize, } from "./protocol.js";
import { getSessionDir, socketPath, isWindows, resolveCommand, } from "./platform.js";
import { writeMetadata, removeSession, validateName, generateName, } from "./session.js";
// ── Holder ─────────────────────────────────────────────────────────
export class Holder {
    name;
    sessionDir;
    ringBuffer;
    ptyProcess;
    server;
    clients = new Set();
    writer = null;
    childExitCode = null;
    childExited = false;
    shuttingDown = false;
    resolveShutdown;
    shutdownDone;
    constructor(name, sessionDir, ptyProcess, server) {
        this.name = name;
        this.sessionDir = sessionDir;
        this.ringBuffer = new RingBuffer(DEFAULT_CAPACITY);
        this.ptyProcess = ptyProcess;
        this.server = server;
        this.shutdownDone = new Promise((resolve) => {
            this.resolveShutdown = resolve;
        });
    }
    /**
     * Create and start a holder. Returns when the PTY + socket are ready.
     */
    static async start(opts) {
        const name = opts.name ?? generateName(opts.command);
        validateName(name);
        const sessionDir = getSessionDir();
        const sockPath = socketPath(sessionDir, name);
        // On Linux/macOS, clean up any leftover socket file from a crashed session
        // Named pipes on Windows don't leave files
        if (!isWindows && existsSync(sockPath)) {
            try {
                unlinkSync(sockPath);
            }
            catch { /* ignore */ }
        }
        const cols = opts.cols ?? 120;
        const rows = opts.rows ?? 40;
        // Spawn PTY
        // On Windows, node-pty can't search PATH, resolve PATHEXT, or run
        // .cmd/.bat files. resolveCommand() finds the real file and wraps
        // .cmd/.bat with cmd.exe /c as needed.
        const resolved = resolveCommand(opts.command);
        const ptyProcess = pty.spawn(resolved.shell, resolved.args, {
            name: "xterm-256color",
            cols,
            rows,
            cwd: opts.cwd ?? process.cwd(),
            env: opts.env ?? process.env,
        });
        // Create Unix domain socket server
        const server = createServer();
        const holder = new Holder(name, sessionDir, ptyProcess, server);
        // Wire up PTY events
        holder.setupPty();
        // Start listening BEFORE writing metadata.
        // Metadata signals "session exists" — it must only appear when the
        // socket is actually connectable (avoids TOCTOU).
        await holder.listen(sockPath);
        // Wire up server events
        holder.setupServer();
        // Now write metadata — the session is fully ready
        const meta = {
            name,
            pid: process.pid,
            childPid: ptyProcess.pid,
            command: opts.command,
            cols,
            rows,
            startedAt: new Date().toISOString(),
        };
        writeMetadata(meta);
        return holder;
    }
    /**
     * The session name.
     */
    get sessionName() {
        return this.name;
    }
    /**
     * Wait for the holder to shut down (child exit + cleanup).
     * Returns the child's exit code.
     */
    async waitForExit() {
        await this.shutdownDone;
        return this.childExitCode ?? -1;
    }
    /**
     * Bridge stdin/stdout directly to the PTY (for --fg mode).
     *
     * This is a lightweight alternative to socket-based attach for cases
     * where the holder runs in the same process. If stdin is a TTY, raw
     * mode is enabled and resize events are forwarded.
     *
     * Returns the child's exit code when the child process exits.
     */
    async pipeStdio() {
        // Wire PTY output → stdout (in addition to the ring buffer + broadcast
        // that setupPty already handles)
        this.ptyProcess.onData((data) => {
            process.stdout.write(data);
        });
        // Wire stdin → PTY input
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        const onStdinData = (data) => {
            try {
                this.ptyProcess.write(data.toString("utf-8"));
            }
            catch {
                // PTY may have closed
            }
        };
        process.stdin.on("data", onStdinData);
        // Forward terminal resize events
        const onResize = () => {
            if (process.stdout.columns && process.stdout.rows) {
                try {
                    this.ptyProcess.resize(process.stdout.columns, process.stdout.rows);
                }
                catch {
                    // PTY may have closed
                }
            }
        };
        if (process.stdin.isTTY) {
            process.stdout.on("resize", onResize);
            // Send initial size
            onResize();
        }
        const code = await this.waitForExit();
        // Cleanup
        process.stdin.removeListener("data", onStdinData);
        process.stdout.removeListener("resize", onResize);
        try {
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            process.stdin.pause();
        }
        catch {
            // Already closed
        }
        return code;
    }
    // ── PTY wiring ─────────────────────────────────────────────────
    setupPty() {
        this.ptyProcess.onData((data) => {
            const buf = Buffer.from(data, "utf-8");
            this.ringBuffer.write(buf);
            this.broadcast(encodeDataOut(buf));
        });
        this.ptyProcess.onExit(({ exitCode }) => {
            this.childExitCode = exitCode;
            this.childExited = true;
            // Delay to let ConPTY flush remaining output
            const drainMs = isWindows ? 200 : 100;
            setTimeout(() => {
                this.shutdown();
            }, drainMs);
        });
    }
    // ── Server wiring ──────────────────────────────────────────────
    listen(sockPath) {
        return new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(sockPath, () => {
                this.server.removeListener("error", reject);
                resolve();
            });
        });
    }
    setupServer() {
        this.server.on("connection", (socket) => {
            this.handleConnection(socket);
        });
    }
    // ── Client connection handling ─────────────────────────────────
    handleConnection(socket) {
        const client = {
            socket,
            decoder: new FrameDecoder(),
            mode: null,
        };
        this.clients.add(client);
        socket.on("data", (chunk) => {
            let frames;
            try {
                frames = client.decoder.decode(chunk);
            }
            catch {
                this.sendError(socket, "Malformed frame");
                socket.destroy();
                return;
            }
            for (const frame of frames) {
                this.handleFrame(client, frame);
            }
        });
        socket.on("close", () => {
            this.disconnectClient(client);
        });
        socket.on("error", () => {
            // disconnectClient() calls client.socket.destroy() internally, so the
            // fd is released — no separate destroy() needed here (see #8).
            this.disconnectClient(client);
        });
    }
    handleFrame(client, frame) {
        // Pre-handshake: only HELLO is valid
        if (client.mode === null) {
            if (frame.type !== MSG.HELLO) {
                this.sendError(client.socket, "Expected HELLO");
                client.socket.destroy();
                return;
            }
            let hello;
            try {
                hello = decodeHello(frame.payload);
            }
            catch {
                this.sendError(client.socket, "Invalid HELLO payload");
                client.socket.destroy();
                return;
            }
            if (hello.protocolVersion !== 1) {
                this.sendError(client.socket, `Unsupported protocol version: ${hello.protocolVersion}`);
                client.socket.destroy();
                return;
            }
            // Check attach exclusivity
            if (hello.mode === "attach" && this.writer !== null) {
                this.sendError(client.socket, `Session "${this.name}" has an active attachment. Use 'holdpty view ${this.name}' for read-only access.`);
                client.socket.destroy();
                return;
            }
            // Accept connection
            client.mode = hello.mode;
            if (hello.mode === "attach") {
                this.writer = client;
            }
            // Send HELLO_ACK
            const ack = encodeHelloAck({
                name: this.name,
                cols: this.ptyProcess.cols,
                rows: this.ptyProcess.rows,
                mode: hello.mode,
                pid: this.ptyProcess.pid,
            });
            client.socket.write(ack);
            // Replay buffer (skip for wait and send modes)
            if (hello.mode !== "wait" && hello.mode !== "send") {
                const bufData = this.ringBuffer.read();
                if (bufData.length > 0) {
                    client.socket.write(encodeDataOut(bufData));
                }
            }
            // Send REPLAY_END
            client.socket.write(encodeReplayEnd());
            // For logs mode: disconnect after replay
            if (hello.mode === "logs") {
                client.socket.end();
            }
            // If child already exited, send EXIT (applies to attach, view, and wait)
            // Send mode clients get an error instead — can't send to a dead session
            if (this.childExited && hello.mode !== "logs") {
                if (hello.mode === "send") {
                    this.sendError(client.socket, `Session "${this.name}" has already exited`);
                }
                else {
                    client.socket.write(encodeExit(this.childExitCode ?? -1));
                }
                client.socket.end();
            }
            return;
        }
        // Post-handshake: handle data frames
        switch (frame.type) {
            case MSG.DATA_IN:
                if (client.mode === "attach" || client.mode === "send") {
                    try {
                        this.ptyProcess.write(frame.payload.toString("utf-8"));
                    }
                    catch {
                        // PTY may have closed
                    }
                    // Send mode: close connection after writing — holder owns the close
                    // to avoid client-side timing races on Windows named pipes
                    if (client.mode === "send") {
                        client.socket.end();
                    }
                }
                break;
            case MSG.RESIZE:
                if (client.mode === "attach") {
                    try {
                        const { cols, rows } = decodeResize(frame.payload);
                        this.ptyProcess.resize(cols, rows);
                    }
                    catch {
                        // PTY may have closed, or invalid resize
                    }
                }
                break;
            default:
                // Unknown/unexpected — ignore (forward-compatible)
                break;
        }
    }
    // ── Broadcasting ───────────────────────────────────────────────
    broadcast(data) {
        for (const client of this.clients) {
            if (client.mode === "attach" || client.mode === "view") {
                try {
                    client.socket.write(data);
                }
                catch {
                    // Client gone — will be cleaned on close event
                }
            }
        }
    }
    sendError(socket, message) {
        try {
            socket.write(encodeError(message));
        }
        catch {
            // Socket may already be dead
        }
    }
    // ── Cleanup ────────────────────────────────────────────────────
    disconnectClient(client) {
        if (this.writer === client) {
            this.writer = null;
        }
        this.clients.delete(client);
        try {
            client.socket.destroy();
        }
        catch {
            // Already destroyed
        }
    }
    shutdown() {
        if (this.shuttingDown)
            return;
        this.shuttingDown = true;
        // Notify all connected clients
        const exitFrame = encodeExit(this.childExitCode ?? -1);
        for (const client of this.clients) {
            if (client.mode === "attach" || client.mode === "view" || client.mode === "wait") {
                try {
                    client.socket.write(exitFrame);
                    client.socket.end();
                }
                catch {
                    // Ignore write errors during shutdown
                }
            }
        }
        // Linger for late connections (default 5s per DESIGN.md, configurable for tests)
        const lingerMs = parseInt(process.env["HOLDPTY_LINGER_MS"] ?? "5000", 10) || 5000;
        setTimeout(() => {
            // Force-close remaining clients
            for (const client of this.clients) {
                try {
                    client.socket.destroy();
                }
                catch { /* ignore */ }
            }
            this.clients.clear();
            this.writer = null;
            // Close server
            this.server.close(() => {
                // Clean up files
                removeSession(this.name);
                this.shuttingDown = false;
                this.resolveShutdown();
            });
        }, lingerMs);
    }
    /**
     * Stop the child process. Used by the `stop` command.
     */
    kill(signal) {
        try {
            this.ptyProcess.kill(signal);
        }
        catch {
            // Process may already be dead
        }
    }
}
//# sourceMappingURL=holder.js.map