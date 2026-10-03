import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function canonicalToolchain(root = ROOT) {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const pnpm = /^pnpm@([^+]+)$/.exec(packageJson.packageManager ?? "")?.[1];
  if (!pnpm || typeof packageJson.engines?.node !== "string") {
    throw new Error("package.json must pin engines.node and packageManager as the maintenance toolchain source of truth");
  }
  return { node: packageJson.engines.node, pnpm };
}

export async function assertRuntimeVersions(root = ROOT) {
  const expected = await canonicalToolchain(root);
  if (process.versions.node !== expected.node) {
    throw new Error(`Maintenance requires Node ${expected.node}; found ${process.versions.node}`);
  }

  let actualPnpm;
  try {
    actualPnpm = execFileSync("pnpm", ["--version"], { cwd: root, encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`Maintenance requires pnpm ${expected.pnpm}; could not run pnpm: ${error.message}`);
  }
  if (actualPnpm !== expected.pnpm) {
    throw new Error(`Maintenance requires pnpm ${expected.pnpm}; found ${actualPnpm}`);
  }
  return expected;
}

export async function installLockedDependencies(root = ROOT) {
  const expected = await assertRuntimeVersions(root);
  const result = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return expected;
}
