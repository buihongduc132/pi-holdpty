/**
 * Pi extension config resolver.
 * 3-tier precedence: Pi settings > env vars > defaults.
 * Per R9.2.
 */

// ── Types ────────────────────────────────────────────────────────

export type Verbosity = "compact" | "detailed" | "minimal";

export interface HoldptyContextConfig {
  enabled: boolean;
  staleAfterMs: number;
  maxSessions: number;
  includeOriginOnlyIfDifferent: boolean;
  verbosity: Verbosity;
  warnOnOrphaned: boolean;
  quietBelowAgeMs: number;
  releaseOnShutdown: boolean;
  contextBudgetMs: number;
}

// ── Defaults ─────────────────────────────────────────────────────

export const DEFAULTS: HoldptyContextConfig = {
  enabled: true,
  staleAfterMs: 4 * 60 * 60 * 1000, // 4h
  maxSessions: 20,
  includeOriginOnlyIfDifferent: true,
  verbosity: "compact",
  warnOnOrphaned: true,
  quietBelowAgeMs: 0,
  releaseOnShutdown: false,
  contextBudgetMs: 200,
};

// ── Validators ───────────────────────────────────────────────────

function isValidBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isValidNumber(v: unknown, min = 0): v is number {
  return typeof v === "number" && !isNaN(v) && v >= min;
}

function isValidVerbosity(v: unknown): v is Verbosity {
  return v === "compact" || v === "detailed" || v === "minimal";
}

function parseBoolEnv(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  const lower = v.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  return undefined;
}

function parseNumEnv(v: string | undefined, min = 0): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = parseInt(v, 10);
  if (isNaN(n) || n < min) return undefined;
  return n;
}

// ── Resolver ─────────────────────────────────────────────────────

/**
 * Resolve config from Pi settings > env > defaults.
 * Invalid values silently fall back to defaults (no throws).
 */
export function resolveConfig(
  piSettings?: Record<string, unknown>,
  env?: Record<string, string | undefined>,
): HoldptyContextConfig {
  const settings = (piSettings?.holdptyContext ?? {}) as Record<string, unknown>;
  const e = env ?? process.env;

  return {
    enabled: resolveField(
      settings.enabled,
      parseBoolEnv(e["HOLDPTY_CTX_ENABLED"]),
      DEFAULTS.enabled,
      isValidBool,
    ),
    staleAfterMs: resolveField(
      settings.staleAfterMs,
      parseNumEnv(e["HOLDPTY_CTX_STALE_AFTER_MS"]),
      DEFAULTS.staleAfterMs,
      (v): v is number => isValidNumber(v, 0),
    ),
    maxSessions: resolveField(
      settings.maxSessions,
      parseNumEnv(e["HOLDPTY_CTX_MAX_SESSIONS"], 0),
      DEFAULTS.maxSessions,
      (v): v is number => isValidNumber(v, 0),
    ),
    includeOriginOnlyIfDifferent: resolveField(
      settings.includeOriginOnlyIfDifferent,
      parseBoolEnv(e["HOLDPTY_CTX_INCLUDE_ORIGIN_ONLY_IF_DIFFERENT"]),
      DEFAULTS.includeOriginOnlyIfDifferent,
      isValidBool,
    ),
    verbosity: resolveField(
      settings.verbosity,
      e["HOLDPTY_CTX_VERBOSITY"] as Verbosity | undefined,
      DEFAULTS.verbosity,
      isValidVerbosity,
    ),
    warnOnOrphaned: resolveField(
      settings.warnOnOrphaned,
      parseBoolEnv(e["HOLDPTY_CTX_WARN_ON_ORPHANED"]),
      DEFAULTS.warnOnOrphaned,
      isValidBool,
    ),
    quietBelowAgeMs: resolveField(
      settings.quietBelowAgeMs,
      parseNumEnv(e["HOLDPTY_CTX_QUIET_BELOW_AGE_MS"], 0),
      DEFAULTS.quietBelowAgeMs,
      (v): v is number => isValidNumber(v, 0),
    ),
    releaseOnShutdown: resolveField(
      settings.releaseOnShutdown,
      parseBoolEnv(e["HOLDPTY_CTX_RELEASE_ON_SHUTDOWN"]),
      DEFAULTS.releaseOnShutdown,
      isValidBool,
    ),
    contextBudgetMs: resolveField(
      settings.contextBudgetMs,
      parseNumEnv(e["HOLDPTY_CTX_BUDGET_MS"], 1),
      DEFAULTS.contextBudgetMs,
      (v): v is number => isValidNumber(v, 1),
    ),
  };
}

/**
 * Generic field resolver: settings > env > default, with validation.
 */
function resolveField<T>(
  settingsValue: unknown,
  envValue: T | undefined,
  defaultValue: T,
  validate: (v: unknown) => v is T,
): T {
  if (settingsValue !== undefined && validate(settingsValue)) {
    return settingsValue;
  }
  if (envValue !== undefined && validate(envValue)) {
    return envValue;
  }
  return defaultValue;
}
