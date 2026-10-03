import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/plugin.mjs";

for (const args of [
  ["scripts/validate-plugin.mjs"],
  ["scripts/check-checksums.mjs"],
  ["--test"],
]) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
