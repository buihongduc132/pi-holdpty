/**
 * Holder process: owns the PTY, manages the ring buffer, accepts clients
 * over a Unix domain socket.
 *
 * One holder per session. No central daemon.
 */
export interface HolderOptions {
    command: string[];
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
}
export declare class Holder {
    private readonly name;
    private readonly sessionDir;
    private readonly ringBuffer;
    private readonly ptyProcess;
    private readonly server;
    private readonly clients;
    private writer;
    private childExitCode;
    private childExited;
    private shuttingDown;
    private resolveShutdown;
    private readonly shutdownDone;
    private constructor();
    /**
     * Create and start a holder. Returns when the PTY + socket are ready.
     */
    static start(opts: HolderOptions): Promise<Holder>;
    /**
     * The session name.
     */
    get sessionName(): string;
    /**
     * Wait for the holder to shut down (child exit + cleanup).
     * Returns the child's exit code.
     */
    waitForExit(): Promise<number>;
    /**
     * Bridge stdin/stdout directly to the PTY (for --fg mode).
     *
     * This is a lightweight alternative to socket-based attach for cases
     * where the holder runs in the same process. If stdin is a TTY, raw
     * mode is enabled and resize events are forwarded.
     *
     * Returns the child's exit code when the child process exits.
     */
    pipeStdio(): Promise<number>;
    private setupPty;
    private listen;
    private setupServer;
    private handleConnection;
    private handleFrame;
    private broadcast;
    private sendError;
    private disconnectClient;
    private shutdown;
    /**
     * Stop the child process. Used by the `stop` command.
     */
    kill(signal?: string): void;
}
