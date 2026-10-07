import {randomUUID} from "node:crypto";
import {link, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

export async function persistImmutableSnapshot(file, snapshot, timestampField) {
  await mkdir(path.dirname(file), {recursive: true});
  const temp = file + ".tmp-" + randomUUID();
  await writeFile(temp, JSON.stringify(snapshot, null, 2) + "\n", {encoding: "utf8", flag: "wx"});
  try {
    try {
      // Publish complete bytes without replacing a winner from another writer.
      await link(temp, file);
      return {created: true, snapshot};
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const current = JSON.parse(await readFile(file, "utf8"));
      const strip = value => {const copy = {...value}; delete copy[timestampField]; return copy;};
      if (canonical(strip(current)) !== canonical(strip(snapshot))) throw new Error("snapshots are immutable");
      return {created: false, snapshot: current};
    }
  } finally {
    await rm(temp, {force: true});
  }
}
