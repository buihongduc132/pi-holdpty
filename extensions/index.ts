/**
 * Pi extension entry point for pi-holdpty.
 *
 * Registers session_start and session_shutdown hooks.
 * Uses pi-hooks-manager convention (registerHook + isEnabled) when available,
 * falls back to plain pi.on(...) for standalone usage.
 *
 * Per R9, R9.1, R9.2, R9.3.
 */

import { resolveConfig } from "./config.js";
import { renderContext, type SessionForRender } from "./context-render.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Types for Pi runtime (minimal interface for decoupling) ──────

interface PiEventContext {
  additionalContext?: string;
  cwd?: string;
  [key: string]: unknown;
}

interface PiAPI {
  on(event: string, handler: (event: unknown, ctx: PiEventContext) => Promise<void> | void): void;
  settings?: Record<string, unknown>;
  sessionId?: string;
}

// ── Hooks-manager integration (optional import) ──────────────────

let registerHook: ((ext: string, event: string, opts?: Record<string, unknown>) => void) | null = null;
let isEnabled: ((ext: string, event: string) => boolean) | null = null;

// Dynamic import path constructed at runtime so TypeScript doesn't try to resolve it.
// In a Pi runtime with pi-hooks-manager installed, this resolves to the shared lib.
// In standalone usage, it fails silently.
const HOOKS_MANAGER_PATH = [".", ".", "lib", "hooks-manager.js"].join("/");
try {
  const hooksManager = await import(/* @vite-ignore */ HOOKS_MANAGER_PATH).catch(() => null);
  if (hooksManager) {
    registerHook = hooksManager.registerHook;
    isEnabled = hooksManager.isEnabled;
  }
} catch {
  // Standalone — no hooks-manager available
}

// ── Extension Activation ─────────────────────────────────────────

const EXTENSION_NAME = "pi-holdpty";

export default function activate(pi: PiAPI): void {
  const cfg = resolveConfig(pi.settings, process.env as Record<string, string | undefined>);

  if (!cfg.enabled) return;

  // Register hooks with hooks-manager if available
  if (registerHook) {
    registerHook(EXTENSION_NAME, "session_start", { blocking: false, source: "pi", origin: "package" });
    registerHook(EXTENSION_NAME, "session_shutdown", { blocking: false, source: "pi", origin: "package" });
  }

  // session_start: inject additionalContext
  pi.on("session_start", async (_event: unknown, ctx: PiEventContext) => {
    // Check hooks-manager toggle
    if (isEnabled && !isEnabled(EXTENSION_NAME, "session_start")) return;

    const t0 = performance.now();
    try {
      const sessions = await callHoldptyLsJson(cfg.contextBudgetMs);
      const elapsed = performance.now() - t0;

      if (elapsed > cfg.contextBudgetMs) {
        ctx.additionalContext = `[pi-holdpty] context skipped — ${sessions.length} sessions, listing too slow`;
        return;
      }

      const rendered = renderContext(sessions, cfg, Date.now());
      if (rendered) {
        ctx.additionalContext = rendered;
      }
    } catch {
      // Graceful fallback — don't block session_start
      ctx.additionalContext = `[pi-holdpty] context unavailable — holdpty binary not found or errored`;
    }
  });

  // session_shutdown: release owned PTYs if configured
  pi.on("session_shutdown", async () => {
    if (isEnabled && !isEnabled(EXTENSION_NAME, "session_shutdown")) return;

    if (cfg.releaseOnShutdown && pi.sessionId) {
      try {
        await releaseOwnedBy(pi.sessionId);
      } catch {
        // Best-effort — don't block shutdown
      }
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Call `holdpty ls --json` and parse the output.
 * Returns session data suitable for renderContext.
 */
async function callHoldptyLsJson(timeoutMs: number): Promise<SessionForRender[]> {
  const { stdout } = await execFileAsync("holdpty", ["ls", "--json"], {
    timeout: timeoutMs,
    encoding: "utf-8",
  });

  if (!stdout || !stdout.trim()) return [];

  let parsed: unknown[];
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.map((s: any) => ({
    name: s.name ?? "unknown",
    created_at: s.metadata?.created_at ?? s.metadata?.startedAt ?? null,
    owner_session: s.metadata?.owner_session ?? null,
    owner_pid: s.metadata?.owner_pid ?? s.metadata?.pid ?? null,
    owner_alive: s.metadata?.owner_pid ? isProcessAliveQuick(s.metadata.owner_pid) : false,
    origin_session: s.metadata?.origin_session ?? null,
    last_interaction_at: s.metadata?.last_interaction_at ?? null,
    last_interaction_by: s.metadata?.last_interaction_by ?? null,
    stale: false, // Computed below
    orphaned: false,
    idle_for_ms: 0,
  }));
}

function isProcessAliveQuick(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Release all PTYs owned by a session ID.
 */
async function releaseOwnedBy(sessionId: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("holdpty", ["ls", "--json"], {
      timeout: 5000,
      encoding: "utf-8",
    });
    if (!stdout) return;
    const sessions = JSON.parse(stdout);
    if (!Array.isArray(sessions)) return;

    for (const s of sessions) {
      if (s.metadata?.owner_session === sessionId) {
        try {
          await execFileAsync("holdpty", ["release", s.name], { timeout: 2000 });
        } catch {
          // Best effort
        }
      }
    }
  } catch {
    // Best effort
  }
}
