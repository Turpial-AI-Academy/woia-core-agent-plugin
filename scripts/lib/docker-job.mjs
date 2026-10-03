import { spawnSync } from "node:child_process";
import { canonicalToolchain } from "./toolchain-contract.mjs";
import { ROOT, assert } from "./plugin.mjs";

export function dockerRunArgs(root, image, pnpmVersion) {
  const setup = [
    "set -eu",
    "mkdir -p /workspace",
    "tar --exclude='./node_modules' --exclude='./node_modules/**' --exclude='./.agent-work' --exclude='./.agent-work/**' -C /source -cf /tmp/plugin-source.tar .",
    "tar -C /workspace -xf /tmp/plugin-source.tar",
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
  const dockerVersion = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (dockerVersion.error || dockerVersion.status !== 0) {
    const detail = dockerVersion.stderr?.trim() || dockerVersion.error?.message || "Docker is unavailable";
    throw new Error(label + " requires a running Docker engine: " + detail);
  }

  const toolchain = await canonicalToolchain(ROOT);
  const image = "node:" + toolchain.node + "-bookworm";
  console.log(label + ": Docker " + dockerVersion.stdout.trim());
  console.log(label + ": image " + image);
  console.log(label + ": read-only source copied to an ephemeral Linux workspace; host node_modules excluded");
  console.log(label + ": network access is required to install pinned pnpm and frozen dependencies; ci:fast itself is offline");

  const result = spawnSync("docker", dockerRunArgs(ROOT, image, toolchain.pnpm), { stdio: "inherit" });
  if (result.error) throw result.error;
  assert(result.status === 0, label + " failed with Docker exit code " + (result.status ?? "unknown"));
  console.log(label + ": OK");
}
