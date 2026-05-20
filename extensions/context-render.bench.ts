/**
 * Performance benchmarks for context rendering.
 * Per R9.3: warm <= 50ms for <= 20 sessions.
 */

import { bench, describe } from "vitest";
import { renderContext, type SessionForRender } from "./context-render.js";
import { DEFAULTS } from "./config.js";

function makeSession(i: number, now: number): SessionForRender {
  return {
    name: `session-${i}`,
    created_at: new Date(now - (i + 1) * 60 * 60 * 1000).toISOString(),
    owner_session: `s_owner_${i}`,
    owner_pid: process.pid,
    owner_alive: i % 3 !== 0, // every 3rd is dead
    origin_session: i % 4 === 0 ? `s_origin_${i}` : `s_owner_${i}`,
    last_interaction_at: new Date(now - i * 10 * 60 * 1000).toISOString(),
    last_interaction_by: `s_owner_${i}`,
    stale: i % 5 === 0,
    orphaned: i % 3 === 0 && i % 5 === 0,
    idle_for_ms: i * 10 * 60 * 1000,
  };
}

describe("T8-19: renderContext performance", () => {
  const now = Date.now();
  const sessions20 = Array.from({ length: 20 }, (_, i) => makeSession(i, now));
  const sessions50 = Array.from({ length: 50 }, (_, i) => makeSession(i, now));

  bench("renderContext — 20 sessions (warm, target <= 50ms)", () => {
    renderContext(sessions20, DEFAULTS, now);
  }, { time: 2000 });

  bench("renderContext — 50 sessions (capped to 20)", () => {
    renderContext(sessions50, DEFAULTS, now);
  }, { time: 2000 });
});
