/**
 * TDD-B Phase 2: T8-A (Config resolution)
 * RED → GREEN
 */

import { describe, it, expect } from "vitest";
import { resolveConfig, DEFAULTS, type HoldptyContextConfig } from "./config.js";

describe("T8-A — Config Resolution", () => {
  // T8-01: Pi settings > env > default
  it("T8-01: Pi settings win over env for staleAfterMs", () => {
    const cfg = resolveConfig(
      { holdptyContext: { staleAfterMs: 7200000 } },
      { HOLDPTY_CTX_STALE_AFTER_MS: "1800000" },
    );
    expect(cfg.staleAfterMs).toBe(7200000);
  });

  // T8-02: env wins over default when no Pi settings
  it("T8-02: env HOLDPTY_CTX_ENABLED=false wins over default", () => {
    const cfg = resolveConfig({}, { HOLDPTY_CTX_ENABLED: "false" });
    expect(cfg.enabled).toBe(false);
  });

  // T8-03: all defaults when nothing set
  it("T8-03: all defaults when no Pi settings and no env", () => {
    const cfg = resolveConfig({}, {});
    expect(cfg.enabled).toBe(true);
    expect(cfg.staleAfterMs).toBe(14400000);
    expect(cfg.maxSessions).toBe(20);
    expect(cfg.verbosity).toBe("compact");
    expect(cfg.warnOnOrphaned).toBe(true);
    expect(cfg.quietBelowAgeMs).toBe(0);
    expect(cfg.includeOriginOnlyIfDifferent).toBe(true);
    expect(cfg.releaseOnShutdown).toBe(false);
  });

  // T8-04: invalid type falls back to default
  it("T8-04: invalid type 'banana' for enabled falls back to default true", () => {
    const cfg = resolveConfig(
      { holdptyContext: { enabled: "banana" } },
      {},
    );
    expect(cfg.enabled).toBe(true);
  });

  // C-10: negative staleAfterMs
  it("C-10: negative staleAfterMs in env falls back to default", () => {
    const cfg = resolveConfig({}, { HOLDPTY_CTX_STALE_AFTER_MS: "-1" });
    expect(cfg.staleAfterMs).toBe(DEFAULTS.staleAfterMs);
  });

  // Env booleans
  it("env boolean parsing: '1', 'yes', 'true' → true; '0', 'no', 'false' → false", () => {
    expect(resolveConfig({}, { HOLDPTY_CTX_ENABLED: "1" }).enabled).toBe(true);
    expect(resolveConfig({}, { HOLDPTY_CTX_ENABLED: "yes" }).enabled).toBe(true);
    expect(resolveConfig({}, { HOLDPTY_CTX_ENABLED: "0" }).enabled).toBe(false);
    expect(resolveConfig({}, { HOLDPTY_CTX_ENABLED: "no" }).enabled).toBe(false);
  });

  // Invalid verbosity
  it("invalid verbosity in settings falls back to default", () => {
    const cfg = resolveConfig(
      { holdptyContext: { verbosity: "extreme" } },
      {},
    );
    expect(cfg.verbosity).toBe("compact");
  });

  // maxSessions=0 is valid
  it("C-11: maxSessions=0 is valid (config level)", () => {
    const cfg = resolveConfig(
      { holdptyContext: { maxSessions: 0 } },
      {},
    );
    expect(cfg.maxSessions).toBe(0);
  });
});
