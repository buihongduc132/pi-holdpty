/**
 * Ownership subsystem: single-writer enforcement, claim/release/force-claim,
 * history capping, and atomic metadata writes.
 *
 * Layer 2 — depends only on Layer 1 (session.ts, platform.ts).
 * Per R5, R6, R7.
 */
export declare const CLAIM_HISTORY_CAP = 16;
export declare const LOCK_TIMEOUT_MS = 5000;
export declare const LOCK_STALE_MS = 30000;
export interface ClaimHistoryEntry {
    ts: string;
    from: string | null;
    to: string | null;
    force: boolean;
}
export interface OwnershipMetadata {
    origin_session: string | null;
    origin_pid: number | null;
    owner_session: string | null;
    owner_pid: number | null;
    created_at: string | null;
    last_interaction_at: string | null;
    last_interaction_by: string | null;
    claim_history: ClaimHistoryEntry[];
    stale_after_ms?: number;
}
/**
 * Full session metadata: upstream fields + R5 ownership fields.
 */
export interface FullSessionMetadata {
    name: string;
    pid: number;
    childPid: number;
    command: string[];
    cols: number;
    rows: number;
    startedAt: string;
    origin_session: string | null;
    origin_pid: number | null;
    owner_session: string | null;
    owner_pid: number | null;
    created_at: string | null;
    last_interaction_at: string | null;
    last_interaction_by: string | null;
    claim_history: ClaimHistoryEntry[];
    stale_after_ms?: number;
}
export declare class MetadataCorruptError extends Error {
    constructor(message: string);
}
export declare class MetadataWriteError extends Error {
    readonly code?: string | undefined;
    constructor(message: string, code?: string | undefined);
}
export declare class OwnershipError extends Error {
    readonly errorCode: string;
    readonly ownerSession: string | null;
    readonly sessionName: string;
    constructor(opts: {
        message: string;
        errorCode: string;
        ownerSession: string | null;
        sessionName: string;
    });
}
/**
 * Resolve the current session ID from PI_SESSION_ID env or generate a fallback.
 */
export declare function resolveSessionId(): string;
/**
 * Apply ownership defaults to a raw metadata object.
 * Handles backwards compatibility with upstream-only metadata.
 */
export declare function applyOwnershipDefaults(raw: Record<string, unknown>): FullSessionMetadata;
/**
 * Read full session metadata with R5 fields (backwards compatible).
 * Returns null for missing files, throws MetadataCorruptError for broken JSON.
 */
export declare function readFullMetadata(name: string, dir?: string): FullSessionMetadata | null;
/**
 * Atomic metadata write: write to tmp file then rename.
 * Per R5/R10: guarantees no partial writes visible.
 */
export declare function writeFullMetadata(meta: FullSessionMetadata, dir?: string): void;
/**
 * mkdir-based lock for ownership-changing writes.
 * Stale lock recovery via PID file inside the lock directory.
 */
export declare function acquireLock(sessionName: string, dir?: string): string;
/**
 * Release a lock.
 */
export declare function releaseLock(lockDir: string): void;
/**
 * Check if a process is alive via kill -0.
 * Treats EPERM as "alive" (process exists but owned by different user).
 */
export declare function isProcessAlive(pid: number): boolean;
/**
 * Cap claim_history to CLAIM_HISTORY_CAP entries, dropping oldest.
 */
export declare function capClaimHistory(history: ClaimHistoryEntry[]): ClaimHistoryEntry[];
export interface ClaimResult {
    success: boolean;
    meta: FullSessionMetadata;
    event?: {
        from: string | null;
        to: string | null;
        force: boolean;
    };
}
/**
 * Create ownership metadata for a new session at launch time.
 */
export declare function createOwnershipMetadata(sessionId?: string): OwnershipMetadata;
/**
 * Claim a session. Allowed if:
 * - Session has no owner (released)
 * - Session is stale (owner PID dead or idle too long)
 * - force=true (always allowed)
 *
 * Must be called inside a lock.
 */
export declare function claimSession(meta: FullSessionMetadata, claimerSessionId: string, opts?: {
    force?: boolean;
    isStale?: boolean;
}): ClaimResult;
/**
 * Release a session. Only the owner can release (unless force).
 * Must be called inside a lock.
 */
export declare function releaseSession(meta: FullSessionMetadata, releaserSessionId: string, opts?: {
    force?: boolean;
}): ClaimResult;
/**
 * Check if a caller is the owner of a session.
 */
export declare function isOwner(meta: FullSessionMetadata, sessionId: string): boolean;
/**
 * Update last_interaction timestamp. Called on attach, send, etc.
 */
export declare function touchInteraction(meta: FullSessionMetadata, sessionId: string): void;
/**
 * Enforce ownership for a write operation. Throws OwnershipError if not owner.
 */
export declare function enforceOwnership(meta: FullSessionMetadata, sessionId: string, operation: string): void;
/**
 * Perform a locked claim operation (acquire lock, read, claim, write, release).
 */
export declare function lockedClaim(sessionName: string, claimerSessionId: string, opts?: {
    force?: boolean;
    isStale?: boolean;
    dir?: string;
}): ClaimResult;
/**
 * Perform a locked release operation.
 */
export declare function lockedRelease(sessionName: string, releaserSessionId: string, opts?: {
    force?: boolean;
    dir?: string;
}): ClaimResult;
