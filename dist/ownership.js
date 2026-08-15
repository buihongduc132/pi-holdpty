/**
 * Ownership subsystem: single-writer enforcement, claim/release/force-claim,
 * history capping, and atomic metadata writes.
 *
 * Layer 2 — depends only on Layer 1 (session.ts, platform.ts).
 * Per R5, R6, R7.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { getSessionDir, metadataPath } from "./platform.js";
// ── Constants ────────────────────────────────────────────────────
export const CLAIM_HISTORY_CAP = 16;
export const LOCK_TIMEOUT_MS = 5000;
export const LOCK_STALE_MS = 30000;
export class MetadataCorruptError extends Error {
    constructor(message) {
        super(message);
        this.name = "MetadataCorruptError";
    }
}
export class MetadataWriteError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "MetadataWriteError";
    }
}
export class OwnershipError extends Error {
    errorCode;
    ownerSession;
    sessionName;
    constructor(opts) {
        super(opts.message);
        this.name = "OwnershipError";
        this.errorCode = opts.errorCode;
        this.ownerSession = opts.ownerSession;
        this.sessionName = opts.sessionName;
    }
}
// ── Session ID Resolution ────────────────────────────────────────
/**
 * Resolve the current session ID from PI_SESSION_ID env or generate a fallback.
 */
export function resolveSessionId() {
    const envId = process.env["PI_SESSION_ID"];
    if (envId && envId.trim().length > 0) {
        return envId.trim();
    }
    return `${randomUUID()}@${hostname()}`;
}
// ── Ownership Defaults ───────────────────────────────────────────
const OWNERSHIP_DEFAULTS = {
    origin_session: null,
    origin_pid: null,
    owner_session: null,
    owner_pid: null,
    created_at: null,
    last_interaction_at: null,
    last_interaction_by: null,
    claim_history: [],
};
/**
 * Apply ownership defaults to a raw metadata object.
 * Handles backwards compatibility with upstream-only metadata.
 */
export function applyOwnershipDefaults(raw) {
    return {
        // Upstream fields
        name: raw.name ?? "",
        pid: raw.pid ?? 0,
        childPid: raw.childPid ?? 0,
        command: raw.command ?? [],
        cols: raw.cols ?? 80,
        rows: raw.rows ?? 24,
        startedAt: raw.startedAt ?? "",
        // R5 ownership fields with defaults
        origin_session: raw.origin_session ?? OWNERSHIP_DEFAULTS.origin_session,
        origin_pid: raw.origin_pid ?? OWNERSHIP_DEFAULTS.origin_pid,
        owner_session: raw.owner_session ?? OWNERSHIP_DEFAULTS.owner_session,
        owner_pid: raw.owner_pid ?? OWNERSHIP_DEFAULTS.owner_pid,
        created_at: raw.created_at ?? OWNERSHIP_DEFAULTS.created_at,
        last_interaction_at: raw.last_interaction_at ?? OWNERSHIP_DEFAULTS.last_interaction_at,
        last_interaction_by: raw.last_interaction_by ?? OWNERSHIP_DEFAULTS.last_interaction_by,
        claim_history: Array.isArray(raw.claim_history) ? raw.claim_history : [...OWNERSHIP_DEFAULTS.claim_history],
        ...(raw.stale_after_ms != null ? { stale_after_ms: raw.stale_after_ms } : {}),
    };
}
// ── Atomic Metadata I/O ──────────────────────────────────────────
/**
 * Read full session metadata with R5 fields (backwards compatible).
 * Returns null for missing files, throws MetadataCorruptError for broken JSON.
 */
export function readFullMetadata(name, dir) {
    const sessionDir = dir ?? getSessionDir();
    const path = metadataPath(sessionDir, name);
    let raw;
    try {
        raw = readFileSync(path, "utf-8");
    }
    catch {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        return applyOwnershipDefaults(parsed);
    }
    catch {
        throw new MetadataCorruptError(`Metadata file for session "${name}" contains invalid JSON`);
    }
}
/**
 * Atomic metadata write: write to tmp file then rename.
 * Per R5/R10: guarantees no partial writes visible.
 */
export function writeFullMetadata(meta, dir) {
    const sessionDir = dir ?? getSessionDir();
    const path = metadataPath(sessionDir, meta.name);
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    try {
        writeFileSync(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
        renameSync(tmpPath, path);
    }
    catch (err) {
        // Clean up tmp file on failure
        try {
            unlinkSync(tmpPath);
        }
        catch { /* ignore */ }
        throw new MetadataWriteError(`Failed to write metadata for session "${meta.name}": ${err.message}`, err.code);
    }
}
// ── Filesystem Lock (mkdir-based, portable) ──────────────────────
/**
 * mkdir-based lock for ownership-changing writes.
 * Stale lock recovery via PID file inside the lock directory.
 */
export function acquireLock(sessionName, dir) {
    const sessionDir = dir ?? getSessionDir();
    const lockDir = join(sessionDir, `${sessionName}.lock`);
    const pidFile = join(lockDir, "pid");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            mkdirSync(lockDir);
            // Write our PID so others can detect stale locks
            writeFileSync(pidFile, String(process.pid), "utf-8");
            return lockDir;
        }
        catch (err) {
            if (err.code === "EEXIST") {
                // Lock exists — check if stale
                if (isLockStale(lockDir)) {
                    breakLock(lockDir);
                    continue;
                }
                // Wait and retry
                const waitMs = 10 + Math.random() * 20;
                const until = Date.now() + waitMs;
                while (Date.now() < until) { /* spin */ }
                continue;
            }
            throw err;
        }
    }
    throw new Error(`Timeout acquiring lock for session "${sessionName}" after ${LOCK_TIMEOUT_MS}ms`);
}
/**
 * Release a lock.
 */
export function releaseLock(lockDir) {
    try {
        const pidFile = join(lockDir, "pid");
        try {
            unlinkSync(pidFile);
        }
        catch { /* ignore */ }
        rmdirSync(lockDir);
    }
    catch {
        // Lock may already be released
    }
}
/**
 * Check if a lock is stale (holding PID is dead or lock is old).
 */
function isLockStale(lockDir) {
    const pidFile = join(lockDir, "pid");
    try {
        const pidStr = readFileSync(pidFile, "utf-8").trim();
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid))
            return true;
        return !isProcessAlive(pid);
    }
    catch {
        // Can't read PID file — assume stale after timeout
        return true;
    }
}
/**
 * Force-break a lock directory.
 */
function breakLock(lockDir) {
    try {
        const pidFile = join(lockDir, "pid");
        try {
            unlinkSync(pidFile);
        }
        catch { /* ignore */ }
        rmdirSync(lockDir);
    }
    catch {
        // Already broken
    }
}
// ── Process Liveness ─────────────────────────────────────────────
/**
 * Check if a process is alive via kill -0.
 * Treats EPERM as "alive" (process exists but owned by different user).
 */
export function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        // EPERM means the process exists but we don't have permission
        if (err.code === "EPERM")
            return true;
        return false;
    }
}
// ── Cap Claim History ────────────────────────────────────────────
/**
 * Cap claim_history to CLAIM_HISTORY_CAP entries, dropping oldest.
 */
export function capClaimHistory(history) {
    if (history.length <= CLAIM_HISTORY_CAP)
        return history;
    return history.slice(history.length - CLAIM_HISTORY_CAP);
}
/**
 * Create ownership metadata for a new session at launch time.
 */
export function createOwnershipMetadata(sessionId) {
    const sid = sessionId ?? resolveSessionId();
    const now = new Date().toISOString();
    return {
        origin_session: sid,
        origin_pid: process.pid,
        owner_session: sid,
        owner_pid: process.pid,
        created_at: now,
        last_interaction_at: now,
        last_interaction_by: sid,
        claim_history: [
            { ts: now, from: null, to: sid, force: false },
        ],
    };
}
/**
 * Claim a session. Allowed if:
 * - Session has no owner (released)
 * - Session is stale (owner PID dead or idle too long)
 * - force=true (always allowed)
 *
 * Must be called inside a lock.
 */
export function claimSession(meta, claimerSessionId, opts = {}) {
    const { force = false, isStale = false } = opts;
    // Check if claimable
    const hasOwner = meta.owner_session !== null;
    const ownerAlive = meta.owner_pid != null && isProcessAlive(meta.owner_pid);
    if (hasOwner && ownerAlive && !isStale && !force) {
        return { success: false, meta };
    }
    const previousOwner = meta.owner_session;
    const now = new Date().toISOString();
    meta.owner_session = claimerSessionId;
    meta.owner_pid = process.pid;
    meta.last_interaction_at = now;
    meta.last_interaction_by = claimerSessionId;
    meta.claim_history.push({
        ts: now,
        from: previousOwner,
        to: claimerSessionId,
        force,
    });
    meta.claim_history = capClaimHistory(meta.claim_history);
    return {
        success: true,
        meta,
        event: { from: previousOwner, to: claimerSessionId, force },
    };
}
/**
 * Release a session. Only the owner can release (unless force).
 * Must be called inside a lock.
 */
export function releaseSession(meta, releaserSessionId, opts = {}) {
    const { force = false } = opts;
    if (meta.owner_session !== releaserSessionId && !force) {
        return { success: false, meta };
    }
    const previousOwner = meta.owner_session;
    const now = new Date().toISOString();
    meta.owner_session = null;
    meta.owner_pid = null;
    meta.last_interaction_at = now;
    meta.last_interaction_by = releaserSessionId;
    meta.claim_history.push({
        ts: now,
        from: previousOwner,
        to: null,
        force,
    });
    meta.claim_history = capClaimHistory(meta.claim_history);
    return {
        success: true,
        meta,
        event: { from: previousOwner, to: null, force },
    };
}
/**
 * Check if a caller is the owner of a session.
 */
export function isOwner(meta, sessionId) {
    return meta.owner_session === sessionId;
}
/**
 * Update last_interaction timestamp. Called on attach, send, etc.
 */
export function touchInteraction(meta, sessionId) {
    meta.last_interaction_at = new Date().toISOString();
    meta.last_interaction_by = sessionId;
}
/**
 * Enforce ownership for a write operation. Throws OwnershipError if not owner.
 */
export function enforceOwnership(meta, sessionId, operation) {
    if (meta.owner_session === null) {
        // No owner — allow (backwards compat for unmanaged sessions)
        return;
    }
    if (meta.owner_session === sessionId) {
        return;
    }
    throw new OwnershipError({
        message: `OWNED_BY_OTHER: Session "${meta.name}" is owned by ${meta.owner_session}. ` +
            `To claim it, run: holdpty claim ${meta.name}`,
        errorCode: "OWNED_BY_OTHER",
        ownerSession: meta.owner_session,
        sessionName: meta.name,
    });
}
/**
 * Perform a locked claim operation (acquire lock, read, claim, write, release).
 */
export function lockedClaim(sessionName, claimerSessionId, opts = {}) {
    const lockDir = acquireLock(sessionName, opts.dir);
    try {
        const meta = readFullMetadata(sessionName, opts.dir);
        if (!meta) {
            throw new Error(`Session "${sessionName}" not found`);
        }
        const result = claimSession(meta, claimerSessionId, opts);
        if (result.success) {
            writeFullMetadata(result.meta, opts.dir);
        }
        return result;
    }
    finally {
        releaseLock(lockDir);
    }
}
/**
 * Perform a locked release operation.
 */
export function lockedRelease(sessionName, releaserSessionId, opts = {}) {
    const lockDir = acquireLock(sessionName, opts.dir);
    try {
        const meta = readFullMetadata(sessionName, opts.dir);
        if (!meta) {
            throw new Error(`Session "${sessionName}" not found`);
        }
        const result = releaseSession(meta, releaserSessionId, opts);
        if (result.success) {
            writeFullMetadata(result.meta, opts.dir);
        }
        return result;
    }
    finally {
        releaseLock(lockDir);
    }
}
//# sourceMappingURL=ownership.js.map