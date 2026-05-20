import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/e2e.test.ts", "src/integration.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/watcher-filter.ts",
        "src/event-stream.ts",
        "src/cli-commands.ts",
      ],
      thresholds: {
        lines: 85,
        functions: 80,
        branches: 80,
        statements: 85,
      },
    },
  },
});
