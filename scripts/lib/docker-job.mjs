import { spawnSync } from "node:child_process";
import { canonicalToolchain } from "./toolchain-contract.mjs";
import { ROOT, assert } from "./plugin.mjs";

const CONTAINER_ENGINE_RE = /^[A-Za-z0-9._-]+$/;

export function resolveContainerEngine(env = process.env) {
  const engine = String(env.WOIA_CONTAINER_ENGINE ?? "docker").trim();
  if (!engine || !CONTAINER_ENGINE_RE.test(engine)) {
    throw new Error("WOIA_CONTAINER_ENGINE must be a simple executable name such as docker or podman");
  }
  return engine;
}

export function dockerRunArgs(root, image, pnpmVersion) {
  const setup = [
    "set -eu",
    "mkdir -p /workspace",
    "tar --exclude='./node_modules' --exclude='./node_modules/**' --exclude='./.agent-work' --exclude='./.agent-work/**' -C /source -cf /tmp/plugin-source.tar .",
    "tar --no-same-owner -C /workspace -xf /tmp/plugin-source.tar",
    "rm -f /tmp/plugin-source.tar",
    "if [ -e /workspace/node_modules ]; then echo 'workspace unexpectedly contains host node_modules' >&2; exit 1; fi",
    "npm install --global pnpm@" + pnpmVersion,
    "test \"$(pnpm --version)\" = \"" + pnpmVersion + "\"",
    "pnpm install --frozen-lockfile",
    "node scripts/ci-fast.mjs",
  ].join("\n");

  return [
    "run",
    "--rm",
    "--mount",
    "type=bind,source=" + root + ",target=/source,readonly",
    "--workdir",
    "/workspace",
    image,
    "/bin/sh",
    "-ec",
    setup,
  ];
}

export async function runDockerJob(label) {
  const engine = resolveContainerEngine();
  const engineVersion = spawnSync(engine, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (engineVersion.error || engineVersion.status !== 0) {
    const detail = engineVersion.stderr?.trim() || engineVersion.error?.message || "container engine is unavailable";
    throw new Error(label + " requires a running local OCI container engine with Docker-compatible CLI semantics (" + engine + "): " + detail);
  }

  const toolchain = await canonicalToolchain(ROOT);
  const image = "node:" + toolchain.node + "-bookworm";
  console.log(label + ": container engine " + engine + " " + engineVersion.stdout.trim());
  console.log(label + ": image " + image);
  console.log(label + ": read-only source copied to an ephemeral Linux workspace; host node_modules excluded");
  console.log(label + ": network access is required to install pinned pnpm and frozen dependencies; ci:fast itself is offline");

  const result = spawnSync(engine, dockerRunArgs(ROOT, image, toolchain.pnpm), { stdio: "inherit" });
  if (result.error) throw result.error;
  assert(result.status === 0, label + " failed with " + engine + " exit code " + (result.status ?? "unknown"));
  console.log(label + ": OK");
}
