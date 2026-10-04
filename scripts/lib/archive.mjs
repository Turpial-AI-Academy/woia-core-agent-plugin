import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assert, portablePayloadPaths } from "./plugin.mjs";

function readTarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer.toString("utf8", start, end >= start && end < start + length ? end : start + length);
}

function readOctal(buffer, start, length) {
  const value = buffer.toString("ascii", start, start + length).replace(/[\0 ]+$/g, "").trim();
  if (!value) return 0;
  const parsed = Number.parseInt(value, 8);
  assert(Number.isSafeInteger(parsed) && parsed >= 0, `Portable archive has invalid tar size "${value}"`);
  return parsed;
}

function listTarEntries(buffer) {
  const files = [];
  let offset = 0;
  let sawEnd = false;
  assert(buffer.length % 512 === 0, "Portable archive is not aligned to tar blocks");
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      assert(buffer.subarray(offset).every((byte) => byte === 0), "Portable archive has data after its tar terminator");
      assert(buffer.length - offset >= 1024, "Portable archive is missing the second tar terminator block");
      break;
    }

    let checksum = 0;
    for (let index = 0; index < header.length; index++) {
      checksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    assert(readOctal(header, 148, 8) === checksum, "Portable archive has an invalid tar header checksum");

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const archivePath = [prefix, name].filter(Boolean).join("/");
    const typeFlag = String.fromCharCode(header[156] || 0);
    const size = readOctal(header, 124, 12);
    assert(offset + 512 + size <= buffer.length, `Portable archive entry is truncated: ${archivePath}`);
    assert(!archivePath.startsWith("/") && !archivePath.includes("\\") && !archivePath.split("/").includes(".."),
      `Portable archive contains an unsafe path: ${archivePath}`);

    if (typeFlag === "0" || typeFlag === "\0") {
      files.push({
        path: archivePath.replace(/\/$/, ""),
        content: Buffer.from(buffer.subarray(offset + 512, offset + 512 + size)),
      });
    }
    else if (typeFlag !== "5" && typeFlag !== "x" && typeFlag !== "g" && typeFlag !== "L" && typeFlag !== "K") {
      assert(false, `Portable archive contains a non-file entry: ${archivePath}`);
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert(sawEnd, "Portable archive is missing its tar terminator");
  assert(files.length > 0, "Portable archive contains no files");
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function archiveEntries(root, treeish = "HEAD") {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "plugin-archive-"));
  const archivePath = path.join(temporaryDirectory, "candidate.tar");
  try {
    try {
      execFileSync("git", ["archive", "--format=tar", "--prefix=plugin-package/", `--output=${archivePath}`, treeish], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`Could not create Git portable archive for ${treeish}: ${error.message}`);
    }
    const archive = await readFile(archivePath);
    return listTarEntries(archive)
      .map(({ path: archivePath, content }) => {
        assert(archivePath.startsWith("plugin-package/"), `Portable archive entry is outside its package prefix: ${archivePath}`);
        return { path: archivePath.slice("plugin-package/".length), content };
      })
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function validatePortableArchive(root, treeish = "HEAD") {
  const expected = await portablePayloadPaths(root);
  const entries = await archiveEntries(root, treeish);
  const actual = entries.map((entry) => entry.path);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const extra = actual.filter((relativePath) => !expectedSet.has(relativePath));
  const missing = expected.filter((relativePath) => !actualSet.has(relativePath));
  assert(extra.length === 0 && missing.length === 0,
    `Git archive does not match the portable payload; extra: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`);
  for (const entry of entries) {
    const source = await readFile(path.join(root, ...entry.path.split("/")));
    assert(entry.content.equals(source), `Git archive content differs from candidate checkout: ${entry.path}`);
  }
  return actual.length;
}
