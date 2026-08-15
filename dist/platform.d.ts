/**
 * Platform-specific paths and utilities.
 *
 * Session directory (for metadata .json files):
 *   Windows: %TEMP%\dt\
 *   Linux:   $XDG_RUNTIME_DIR/dt/ or /tmp/dt-$UID/
 *
 * Socket paths:
 *   Windows: Named pipes (//./pipe/holdpty-<name>)
 *   Linux:   Unix domain sockets ({sessionDir}/{name}.sock)
 *
 * Override metadata dir via HOLDPTY_DIR environment variable.
 */
/**
 * Get the session directory path (ensures it exists).
 * This is where metadata .json files are stored.
 */
export declare function getSessionDir(): string;
/**
 * Resolve the session directory path without creating it.
 */
export declare function resolveSessionDir(): string;
/**
 * Socket/pipe path for a session name.
 *
 * On Windows: named pipe `//./pipe/holdpty-<name>`
 * On Linux/macOS: Unix domain socket `{sessionDir}/{name}.sock`
 */
export declare function socketPath(sessionDir: string, name: string): string;
/**
 * Metadata file path for a session name.
 */
export declare function metadataPath(sessionDir: string, name: string): string;
/**
 * Default shell for the current platform.
 */
export declare function defaultShell(): string;
/**
 * Whether the current platform is Windows.
 */
export declare const isWindows: boolean;
/**
 * Resolved command for pty.spawn() on Windows.
 *
 * node-pty on Windows can't search PATH, resolve PATHEXT, or run
 * .cmd/.bat files. This function finds the actual file and returns
 * the shell + args needed to execute it.
 *
 * Returns { shell, args } where shell is what to pass to pty.spawn()
 * and args replaces the original args array.
 *
 * On non-Windows, returns the command unchanged.
 */
export declare function resolveCommand(command: string[]): {
    shell: string;
    args: string[];
};
