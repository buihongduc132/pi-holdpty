/**
 * Stale detection: threshold check, orphan-PID probe, stale_warning emission.
 *
 * Layer 2 — depends on Layer 1 (session.ts, platform.ts) and ownership.ts.
 * Per R8.
 */

import { type FullSessionMetadata, isProcessAlive } from "./ownership.js";
import type { StaleWarningEvent } from "./event-stream.js";

// ── Duration Parsing ─────────────────────────────────────────────

/**
 * Parse a human-friendly duration string into milliseconds.
 * Supports: "4h", "30m", "2d", "500ms", plain number (ms).
 */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") return input;
  const trimmed = input.trim();
  if (!trimmed) return 0;

  // Plain number (ms)
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!match) {
    throw new Error(`Invalid duration: "${input}". Use formats like 4h, 30m, 2d, 500ms, or plain milliseconds.`);
  }

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "ms": return Math.round(value);
    case "s":  return Math.round(value * 1000);
    case "m":  return Math.round(value * 60 * 1000);
    case "h":  return Math.round(value * 60 * 60 * 1000);
    case "d":  return Math.round(value * 24 * 60 * 60 * 1000);
    default:   return Math.round(value);
  }
}

// ── Default Stale Threshold ──────────────────────────────────────

export const DEFAULT_STALE_AFTER_MS = 4 * 60 * 60 * 1000; // 4 hours

// ── Staleness Check ──────────────────────────────────────────────

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
export function resolveStaleThreshold(meta: FullSessionMetadata, envOverride?: string): number {
  // Per-session override (from launch --stale-after)
  if (meta.stale_after_ms != null && meta.stale_after_ms >= 0) {
    return meta.stale_after_ms;
  }

  // Environment override
  const envVal = envOverride ?? process.env["HOLDPTY_STALE_AFTER"];
  if (envVal) {
    try {
      return parseDuration(envVal);
    } catch {
      // Invalid env — fall through to default
    }
  }

  return DEFAULT_STALE_AFTER_MS;
}

/**
 * Check if a session is stale.
 * A session is stale if:
 *   - owner_pid is dead (orphaned) — regardless of time threshold
 *   - last_interaction_at exceeds the stale threshold
 */
export function checkStaleness(
  meta: FullSessionMetadata,
  opts: { now?: number; thresholdMs?: number } = {},
): StalenessResult {
  const now = opts.now ?? Date.now();
  const threshold = opts.thresholdMs ?? resolveStaleThreshold(meta);

  // Check orphan status
  const orphaned = meta.owner_pid != null && !isProcessAlive(meta.owner_pid);

  // Compute idle time
  let idleMs = 0;
  if (meta.last_interaction_at) {
    const lastInteraction = new Date(meta.last_interaction_at).getTime();
    idleMs = Math.max(0, now - lastInteraction); // Clamp to 0 for clock skew
  } else if (meta.created_at) {
    const created = new Date(meta.created_at).getTime();
    idleMs = Math.max(0, now - created);
  }

  // Orphaned is always stale
  if (orphaned) {
    return {
      stale: true,
      idle_for_ms: idleMs,
      orphaned: true,
      suggest: "claim",
    };
  }

  // Time-based staleness
  const timeStale = idleMs >= threshold;
  if (timeStale) {
    return {
      stale: true,
      idle_for_ms: idleMs,
      orphaned: false,
      suggest: "claim",
    };
  }

  return {
    stale: false,
    idle_for_ms: idleMs,
    orphaned: false,
  };
}

// ── Stale Warning Event ──────────────────────────────────────────

/**
 * Track which sessions have already emitted a stale warning.
 * Key: session name, Value: timestamp of last stale warning.
 */
const staleWarningEmitted = new Map<string, number>();

/**
 * Reset stale warning tracking (for tests).
 */
export function resetStaleWarnings(): void {
  staleWarningEmitted.clear();
}

/**
 * Mark a session as having had its stale warning reset (e.g., after interaction).
 */
export function clearStaleWarning(sessionName: string): void {
  staleWarningEmitted.delete(sessionName);
}

/**
 * Check if a stale warning should be emitted for a session.
 * Returns the event if it should be emitted, null otherwise.
 *
 * Emits once per stale crossing. If session recovers and goes stale again,
 * a new warning is emitted.
 */
export function checkAndEmitStaleWarning(
  meta: FullSessionMetadata,
  opts: { now?: number; thresholdMs?: number } = {},
): StaleWarningEvent | null {
  const staleness = checkStaleness(meta, opts);

  if (!staleness.stale) {
    // Not stale — clear any previous warning so a future crossing re-emits
    staleWarningEmitted.delete(meta.name);
    return null;
  }

  // Already emitted for this crossing?
  if (staleWarningEmitted.has(meta.name)) {
    return null;
  }

  // Emit warning
  staleWarningEmitted.set(meta.name, Date.now());

  return {
    ts: new Date().toISOString(),
    session: meta.name,
    kind: "stale_warning",
    owner_session: meta.owner_session ?? "unknown",
    idle_for_ms: staleness.idle_for_ms,
    orphaned: staleness.orphaned,
    suggest: staleness.suggest ?? "claim",
  };
}
