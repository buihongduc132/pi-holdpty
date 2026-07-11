/**
 * TDD tests for issue #8: socket 'error' handlers must call socket.destroy()
 * to release the underlying file descriptor. Without an explicit destroy(),
 * the handler relies on Node's implicit auto-destroy; this is fragile
 * (e.g. if autoDestroy is disabled, or a future refactor swallows the error)
 * and the bug report flags it as an fd-leak risk under connection churn.
 *
 * How these tests discriminate buggy vs. fixed code:
 *   Node calls Socket#destroy() once automatically when 'error' fires
 *   (autoDestroy is the stream default). The buggy handlers never call
 *   destroy() themselves, so destroy() is invoked exactly once. The fixed
 *   handlers call destroy() explicitly, so destroy() is invoked at least
 *   twice. We wrap each captured socket's destroy() to count the calls.
 *
 * Coverage:
 *  - Location #1: client.ts connect() error handler
 *  - Location #2: session.ts isSocketReachable() error handler (via listSessions)
 *
 * Location #3 (holder.ts per-client error handler) is a false positive: it
 * calls disconnectClient(), which internally calls client.socket.destroy()
 * (see disconnectClient in holder.ts).
 *
 * Location #4 (cli.ts event-stream error handler) wraps filter.flush() in
 * try/finally and calls process.exit(1), which makes it impractical to unit
 * test in isolation (cmdWatch is unexported and the handler exits the
 * process). The fix is correct by construction (try/finally guarantees the
 * socket is destroyed even if flush throws) and is exercised indirectly by
 * the watch command's e2e behavior, but has no dedicated assertion here.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type * as Net from "node:net";
import { mkdtempSync, rmSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Capture every socket created by net.createConnection ───────────
// vi.mock is hoisted automatically by vitest, so it applies before any
// module that calls createConnection is evaluated. The factory delegates
// to the real implementation (preserving behavior), records each socket,
// and instruments its destroy() to count explicit calls.

interface TrackedSocket extends Net.Socket {
  __destroyCallCount: number;
}

const createdSockets: TrackedSocket[] = [];

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof Net>();
  return {
    ...actual,
    createConnection: (...args: unknown[]) => {
      const socket = actual.createConnection(...args) as TrackedSocket;
      socket.__destroyCallCount = 0;
      const origDestroy = socket.destroy.bind(socket);
      socket.destroy = (...dArgs: unknown[]) => {
        socket.__destroyCallCount++;
        return origDestroy(...dArgs);
      };
      createdSockets.push(socket);
      return socket;
    },
  };
});

// Import AFTER the mock is set up. These modules call createConnection.
const { connect } = await import("./client.js");
const { writeMetadata, listSessions } = await import("./session.js");
type SessionMetadata = import("./session.js").SessionMetadata;

let testDir: string;
const originalHoldptyDir = process.env["HOLDPTY_DIR"];

function freshDir(): string {
  testDir = mkdtempSync(join(tmpdir(), "holdpty-sock-destroy-"));
  process.env["HOLDPTY_DIR"] = testDir;
  return testDir;
}

afterEach(async () => {
  createdSockets.length = 0;
  try {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  // Restore the original HOLDPTY_DIR so later tests don't inherit a deleted path.
  if (originalHoldptyDir === undefined) {
    delete process.env["HOLDPTY_DIR"];
  } else {
    process.env["HOLDPTY_DIR"] = originalHoldptyDir;
  }
});

// ── Location #1: client.ts connect() error handler ─────────────────

describe("client.connect() error handler destroys the socket (issue #8)", () => {
  it("calls socket.destroy() explicitly when the connection errors during handshake", async () => {
    freshDir();

    // Metadata exists so readMetadata pre-check passes, but no holder is
    // listening → createConnection emits 'error'.
    const meta: SessionMetadata = {
      name: "dead-connect",
      pid: process.pid,
      childPid: 999999,
      command: ["sleep", "1"],
      cols: 80,
      rows: 24,
      startedAt: new Date().toISOString(),
    };
    writeMetadata(meta);

    const beforeCount = createdSockets.length;

    // connect() rejects because the socket errors (ECONNREFUSED / ENOENT).
    await expect(connect({ name: "dead-connect", mode: "view" })).rejects.toThrow(
      /Cannot connect to session/,
    );

    // Let the error event propagate through the handler.
    await new Promise((r) => setImmediate(r));

    const newSockets = createdSockets.slice(beforeCount);
    expect(newSockets.length).toBeGreaterThanOrEqual(1);
    // Node auto-destroys once (count = 1). The fix must add an explicit
    // destroy() so the count is >= 2. Buggy code leaves it at exactly 1.
    for (const sock of newSockets) {
      expect(sock.__destroyCallCount).toBeGreaterThanOrEqual(2);
    }
  }, 5000);
});

// ── Location #2: session.ts isSocketReachable() error handler ──────

describe("isSocketReachable (via listSessions) destroys the socket on error (issue #8)", () => {
  if (process.platform === "win32") {
    it.skip("skipped on Windows: socket-existence check differs", () => {});
  } else {
    it("calls socket.destroy() explicitly when the reachability check errors", async () => {
      const dir = freshDir();

      // A session whose holder PID is dead but a leftover socket FILE exists.
      // existsSync(socketPath) is true, so listSessions probes with
      // isSocketReachable, whose createConnection to a non-listening path
      // emits 'error'.
      const name = "stale-sock";
      const meta: SessionMetadata = {
        name,
        pid: 999999, // not alive → triggers the isSocketReachable branch
        childPid: 999998,
        command: ["sleep", "1"],
        cols: 80,
        rows: 24,
        startedAt: new Date().toISOString(),
      };
      writeMetadata(meta);

      // Empty placeholder file at the socket path so existsSync() is true.
      const fd = openSync(join(dir, `${name}.sock`), "w");
      closeSync(fd);

      const beforeCount = createdSockets.length;

      await listSessions({ clean: true });

      // Let pending error events flush.
      await new Promise((r) => setTimeout(r, 50));

      const newSockets = createdSockets.slice(beforeCount);
      expect(newSockets.length).toBeGreaterThanOrEqual(1);
      for (const sock of newSockets) {
        expect(sock.__destroyCallCount).toBeGreaterThanOrEqual(2);
      }
    }, 5000);
  }
});
