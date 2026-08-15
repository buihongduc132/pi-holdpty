#!/usr/bin/env node
import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "node_modules", "node-pty", "prebuilds");
if (!existsSync(root)) process.exit(0);

for (const platformArch of ["darwin-arm64", "darwin-x64"]) {
  const helper = join(root, platformArch, "spawn-helper");
  if (!existsSync(helper)) continue;
  const mode = statSync(helper).mode;
  if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755);
}
