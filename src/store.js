import { readFile, writeFile, rename } from "node:fs/promises";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { join } from "node:path";

/** API keys are stored only as SHA-256 hashes; the raw key is shown once at registration. */
export function hashKey(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/** Timing-safe lookup of a key record by the presented bearer token. */
export function findByKey(keys, token) {
  if (!token) return null;
  const presented = Buffer.from(hashKey(token), "hex");
  for (const rec of Object.values(keys)) {
    if (!rec.key_hash) continue;
    const stored = Buffer.from(rec.key_hash, "hex");
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) return rec;
  }
  return null;
}

export async function readKeys(dir) {
  try {
    return JSON.parse(await readFile(join(dir, "keys.json"), "utf8"));
  } catch {
    return {};
  }
}

// Writes are serialized per path and land via tmp-file + rename, so concurrent
// requests in one process can't interleave a partial keys.json.
const queues = new Map();
export function writeKeys(dir, keys) {
  const path = join(dir, "keys.json");
  const prev = queues.get(path) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, JSON.stringify(keys, null, 2));
      await rename(tmp, path);
    })
    .catch(() => {});
  queues.set(path, next);
  return next;
}
