/**
 * Pure context renderer for pi-holdpty additionalContext.
 * Per R9.1: generates the text block injected on session_start.
 *
 * This module has ZERO Pi runtime dependencies — testable standalone.
 */

import type { HoldptyContextConfig } from "./config.js";

// ── Types ────────────────────────────────────────────────────────

export interface SessionForRender {
  name: string;
  created_at: string | null;
  owner_session: string | null;
  owner_pid: number | null;
  owner_alive: boolean;
  origin_session: string | null;
  last_interaction_at: string | null;
  last_interaction_by: string | null;
  stale: boolean;
  orphaned: boolean;
  idle_for_ms: number;
}

// ── Duration Formatting ──────────────────────────────────────────

/**
 * Format milliseconds as a human-readable duration: "2h13m", "4m", "18m", etc.
 */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return "just now";
}

// ── Renderer ─────────────────────────────────────────────────────

/**
 * Pure function: render the additionalContext block.
 *
 * @param sessions - Session data (pre-fetched from `holdpty ls --json` + liveness probes)
 * @param cfg - Resolved config
 * @param now - Current timestamp (ms) for age/idle computation
 * @returns The formatted text block, or empty string for 0 sessions
 */
export function renderContext(
  sessions: SessionForRender[],
  cfg: HoldptyContextConfig,
  now: number,
): string {
  if (sessions.length === 0) {
    return "";
  }

  // Filter out sessions younger than quietBelowAgeMs
  let filtered = sessions;
  if (cfg.quietBelowAgeMs > 0) {
    filtered = sessions.filter((s) => {
      if (!s.created_at) return true;
      const ageMs = now - new Date(s.created_at).getTime();
      return ageMs >= cfg.quietBelowAgeMs;
    });
  }

  if (filtered.length === 0) {
    return "";
  }

  // Cap at maxSessions
  const shown = cfg.maxSessions > 0 ? filtered.slice(0, cfg.maxSessions) : [];
  const remaining = filtered.length - shown.length;

  const lines: string[] = [];
  lines.push(`[pi-holdpty — ${filtered.length} active PTY${filtered.length !== 1 ? "s" : ""}]`);

  for (const s of shown) {
    const age = s.created_at ? formatDuration(Math.max(0, now - new Date(s.created_at).getTime())) : "unknown";
    const ownerStatus = s.owner_alive ? "[running]" : `[exited ${formatDuration(s.idle_for_ms)}]`;
    const ownerStr = s.owner_session ?? "none";
    const interactionTime = s.idle_for_ms > 0 ? `${formatDuration(s.idle_for_ms)} ago` : "just now";
    const interactionBy = s.last_interaction_by ?? "unknown";

    let line = `- ${s.name}   age ${age}   owner ${ownerStr} ${ownerStatus}      last_interaction ${interactionTime} by ${interactionBy}`;

    // Origin session (only if different from owner and configured)
    if (cfg.includeOriginOnlyIfDifferent) {
      if (s.origin_session && s.origin_session !== s.owner_session) {
        line += ` (origin ${s.origin_session})`;
      }
    } else if (s.origin_session) {
      line += ` (origin ${s.origin_session})`;
    }

    lines.push(line);

    // Stale / orphan warning
    if (s.stale && cfg.warnOnOrphaned) {
      lines.push(`                  ⚠ STALE — \`holdpty claim ${s.name}\` (force-claim only if instructed/emergency).`);
    } else if (s.stale && !cfg.warnOnOrphaned && !s.orphaned) {
      lines.push(`                  ⚠ STALE — \`holdpty claim ${s.name}\` (force-claim only if instructed/emergency).`);
    } else if (s.orphaned && cfg.warnOnOrphaned) {
      lines.push(`                  ⚠ STALE — \`holdpty claim ${s.name}\` (force-claim only if instructed/emergency).`);
    }
  }

  if (remaining > 0) {
    lines.push(`... and ${remaining} more`);
  }

  lines.push("");
  lines.push("Rules: 1 session = 1 PTY owner. `claim` is allowed on stale PTYs. `--force-claim` requires explicit instruction or emergency.");

  return lines.join("\n");
}
