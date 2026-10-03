import { lstat } from "node:fs/promises";
import path from "node:path";
import { ROOT, validateManifest, assert } from "./lib/plugin.mjs";
import { validateCurrentToolchain } from "./lib/toolchain.mjs";

const toolchain = await validateCurrentToolchain(ROOT);
for (const required of [
  "plugin.json",
  "mise.toml",
  "mise.lock",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]) {
  const stat = await lstat(path.join(ROOT, required)).catch(() => null);
  assert(stat?.isFile(), `Missing required maintenance file: ${required}`);
}

const manifest = await validateManifest(ROOT);
console.log(`doctor: Node ${toolchain.node}`);
console.log(`doctor: pnpm ${toolchain.pnpm}`);
console.log(`doctor: plugin ${manifest.name}@${manifest.version}`);
console.log("doctor: toolchain, lockfiles, dependencies, and manifest are ready");
