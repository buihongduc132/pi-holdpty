/**
 * Performance benchmarks for ownership metadata operations.
 * Per R10: metadata write <= 2ms.
 */

import { bench, describe } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeFullMetadata,
  readFullMetadata,
  type FullSessionMetadata,
} from "./ownership.js";

function createTmpDir(): string {
  const dir = join(tmpdir(), `pi-holdpty-bench-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeBasicMeta(name: string): FullSessionMetadata {
  return {
    name,
    pid: process.pid,
    childPid: process.pid,
    command: ["echo", "hello"],
    cols: 120,
    rows: 40,
    startedAt: new Date().toISOString(),
    origin_session: "s_bench",
    origin_pid: process.pid,
    owner_session: "s_bench",
    owner_pid: process.pid,
    created_at: new Date().toISOString(),
    last_interaction_at: new Date().toISOString(),
    last_interaction_by: "s_bench",
    claim_history: [{ ts: new Date().toISOString(), from: null, to: "s_bench", force: false }],
  };
}

describe("T5-08: Metadata write performance", () => {
  const tmpDir = createTmpDir();
  const meta = makeBasicMeta("bench-session");

  bench("writeFullMetadata (atomic tmp→rename)", () => {
    writeFullMetadata(meta, tmpDir);
  }, { time: 2000 });

  bench("readFullMetadata", () => {
    readFullMetadata("bench-session", tmpDir);
  }, { time: 2000 });

  // Cleanup handled by process exit
});
