/**
 * Session directory management: metadata CRUD, listing, stale detection.
 *
 * The filesystem IS the registry. Each session has:
 *   {name}.sock  — Unix domain socket
 *   {name}.json  — Metadata
 */
export interface SessionMetadata {
    name: string;
    pid: number;
    childPid: number;
    command: string[];
    cols: number;
    rows: number;
    startedAt: string;
}
export interface SessionInfo {
    name: string;
    metadata: SessionMetadata;
    socketExists: boolean;
}
/**
 * Generate a session name from a command: `basename-xxxx`
 */
export declare function generateName(command: string[]): string;
/**
 * Validate a session name.
 */
export declare function validateName(name: string): void;
/**
 * Write session metadata to disk.
 */
export declare function writeMetadata(meta: SessionMetadata): void;
/**
 * Read session metadata from disk.
 */
export declare function readMetadata(name: string): SessionMetadata | null;
/**
 * Remove session files (socket + metadata).
 */
export declare function removeSession(name: string): void;
/**
 * List all sessions, with optional stale cleanup.
 */
export declare function listSessions(opts?: {
    clean?: boolean;
}): Promise<SessionInfo[]>;
/**
 * Check if a session name is in use (metadata exists and process is alive).
 */
export declare function isSessionActive(name: string): boolean;
