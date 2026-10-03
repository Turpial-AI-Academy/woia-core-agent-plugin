import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(".");

test("doctor does not require the optional source checksum manifest", async () => {
  const source = await readFile(path.join(ROOT, "scripts", "doctor.mjs"), "utf8");
  assert.equal(source.includes("CHECKSUMS.sha256"), false);

  const result = spawnSync(process.execPath, ["scripts/doctor.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
  assert.match(result.stdout, /doctor: toolchain, lockfiles, dependencies, and manifest are ready/);
});
