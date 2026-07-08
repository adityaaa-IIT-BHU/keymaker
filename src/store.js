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

// Two storage backends behind one interface. Default: keys.json (atomic,
// serialized writes). Opt-in via signup.config.json {"storage":{"driver":"sqlite"}}:
// keys.db using Node's built-in node:sqlite — no extra dependency, survives
// high write rates, needs Node 22.13+.
const backends = new Map();

async function backend(dir) {
  if (backends.has(dir)) return backends.get(dir);
  let driver = "json";
  try {
    const cfg = JSON.parse(await readFile(join(dir, "signup.config.json"), "utf8"));
    if (cfg.storage?.driver === "sqlite") driver = "sqlite";
  } catch {}
  const impl = driver === "sqlite" ? await sqliteBackend(dir) : jsonBackend(dir);
  backends.set(dir, impl);
  return impl;
}

function jsonBackend(dir) {
  const path = join(dir, "keys.json");
  // Writes are serialized and land via tmp-file + rename, so concurrent
  // requests in one process can't interleave a partial keys.json.
  let queue = Promise.resolve();
  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch {
        return {};
      }
    },
    write(keys) {
      queue = queue
        .then(async () => {
          const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
          await writeFile(tmp, JSON.stringify(keys, null, 2));
          await rename(tmp, path);
        })
        .catch(() => {});
      return queue;
    },
  };
}

async function sqliteBackend(dir) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error('storage.driver "sqlite" requires Node 22.13+ (built-in node:sqlite)');
  }
  const db = new DatabaseSync(join(dir, "keys.db"));
  db.exec("CREATE TABLE IF NOT EXISTS agent_keys (key_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  const selectAll = db.prepare("SELECT key_id, data FROM agent_keys");
  const upsert = db.prepare(
    "INSERT INTO agent_keys (key_id, data) VALUES (?, ?) ON CONFLICT(key_id) DO UPDATE SET data = excluded.data"
  );
  const del = db.prepare("DELETE FROM agent_keys WHERE key_id = ?");
  return {
    async read() {
      const out = {};
      for (const row of selectAll.all()) out[row.key_id] = JSON.parse(row.data);
      return out;
    },
    async write(keys) {
      const stale = new Set(selectAll.all().map((r) => r.key_id));
      db.exec("BEGIN");
      try {
        for (const [id, rec] of Object.entries(keys)) {
          upsert.run(id, JSON.stringify(rec));
          stale.delete(id);
        }
        for (const id of stale) del.run(id);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

export async function readKeys(dir) {
  return (await backend(dir)).read();
}

export async function writeKeys(dir, keys) {
  return (await backend(dir)).write(keys);
}
