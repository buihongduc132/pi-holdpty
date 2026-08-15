/**
 * Stale detection: threshold check, orphan-PID probe, stale_warning emission.
 *
 * Layer 2 — depends on Layer 1 (session.ts, platform.ts) and ownership.ts.
 * Per R8.
 */
import { type FullSessionMetadata } from "./ownership.js";
import type { StaleWarningEvent } from "./event-stream.js";
/**
 * Parse a human-friendly duration string into milliseconds.
 * Supports: "4h", "30m", "2d", "500ms", plain number (ms).
 */
export declare function parseDuration(input: string | number): number;
export declare const DEFAULT_STALE_AFTER_MS: number;
export interface StalenessResult {
    stale: boolean;
    idle_for_ms: number;
    orphaned: boolean;
    suggest?: "claim" | "force-claim" | "close";
}
/**
 * Resolve the stale threshold for a session.
 * Precedence: per-session stale_after_ms > HOLDPTY_STALE_AFTER env > default.
 */
export declare function resolveStaleThreshold(meta: FullSessionMetadata, envOverride?: string): number;
/**
 * Check if a session is stale.
 * A session is stale if:
 *   - owner_pid is dead (orphaned) — regardless of time threshold
 *   - last_interaction_at exceeds the stale threshold
 */
export declare function checkStaleness(meta: FullSessionMetadata, opts?: {
    now?: number;
    thresholdMs?: number;
}): StalenessResult;
/**
 * Reset stale warning tracking (for tests).
 */
export declare function resetStaleWarnings(): void;
/**
 * Mark a session as having had its stale warning reset (e.g., after interaction).
 */
export declare function clearStaleWarning(sessionName: string): void;
/**
 * Check if a stale warning should be emitted for a session.
 * Returns the event if it should be emitted, null otherwise.
 *
 * Emits once per stale crossing. If session recovers and goes stale again,
 * a new warning is emitted.
 */
export declare function checkAndEmitStaleWarning(meta: FullSessionMetadata, opts?: {
    now?: number;
    thresholdMs?: number;
}): StaleWarningEvent | null;
