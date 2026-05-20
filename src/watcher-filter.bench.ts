/**
 * Performance benchmarks for watcher-filter.
 *
 * Per R10: regex compile cached per-pattern; LRU 1024 max.
 * Run with: npx vitest bench src/watcher-filter.bench.ts
 */

import { describe, bench, beforeEach } from "vitest";
import {
  compilePattern,
  clearCache,
  compilePatterns,
  WatcherFilter,
  type EventCallback,
} from "./watcher-filter.js";
import type { WatcherEvent } from "./event-stream.js";

describe("regex compile cache", () => {
  beforeEach(() => clearCache());

  bench("compile 1024 unique patterns", () => {
    clearCache();
    for (let i = 0; i < 1024; i++) {
      compilePattern(`pattern_${i}_\\d+`);
    }
  });

  bench("compile cached pattern (hit)", () => {
    compilePattern("ERROR");
  });
});

describe("WatcherFilter throughput", () => {
  const noopCallback: EventCallback = () => {};

  bench("1000 matching lines, debounce=100ms", () => {
    clearCache();
    const specs = compilePatterns(["ERROR"], []);
    const filter = new WatcherFilter({
      session: "bench",
      patterns: specs,
      debounceMs: 100,
      maxBufferBytes: 1024 * 1024,
      onEvent: noopCallback,
    });

    for (let i = 0; i < 1000; i++) {
      filter.feed(`ERROR line ${i}\n`);
    }
    filter.destroy();
  });

  bench("1000 non-matching lines", () => {
    clearCache();
    const specs = compilePatterns(["ERROR"], []);
    const filter = new WatcherFilter({
      session: "bench",
      patterns: specs,
      debounceMs: 100,
      maxBufferBytes: 1024 * 1024,
      onEvent: noopCallback,
    });

    for (let i = 0; i < 1000; i++) {
      filter.feed(`INFO line ${i}\n`);
    }
    filter.destroy();
  });

  bench("1000 lines, 4 patterns, debounce=0", () => {
    clearCache();
    const specs = compilePatterns(
      ["ERROR", "WARN", "FATAL", "CRITICAL"],
      ["errors", "warnings", "fatal", "critical"],
    );
    const filter = new WatcherFilter({
      session: "bench",
      patterns: specs,
      debounceMs: 0,
      maxBufferBytes: 1024 * 1024,
      onEvent: noopCallback,
    });

    for (let i = 0; i < 1000; i++) {
      filter.feed(`ERROR: something went wrong on iteration ${i}\n`);
    }
    filter.destroy();
  });
});
