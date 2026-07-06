import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createBilling } from "./billing.js";
import { findByKey, readKeys, writeKeys } from "./store.js";

/**
 * Drop-in auth middleware for the vendor's own API.
 * Express-style (req, res, next) — also works with plain node:http
 * (call without next; resolves true if the request may proceed).
 *
 * GET/HEAD/OPTIONS require the `read` or `write` scope; everything else requires `write`.
 */
export function keymakerAuth({ dir, rateLimitPerMinute = 60 } = {}) {
  const hits = new Map();
  const billingPromise = readFile(join(dir, "signup.config.json"), "utf8")
    .then((raw) => createBilling(JSON.parse(raw).billing))
    .catch(() => null);

  return async function auth(req, res, next) {
    const fail = (code, error) => {
      if (res?.writeHead) {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify({ error }));
      }
      return false;
    };

    const header = req.headers?.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return fail(401, "missing bearer token; see /auth.md to register");

    const keys = await readKeys(dir);
    const rec = findByKey(keys, token);
    if (!rec) return fail(401, "unknown key; see /auth.md to register");
    if (rec.revoked) return fail(401, "key revoked");
    if (rec.expires_at && Date.parse(rec.expires_at) < Date.now()) {
      return fail(401, "key expired; a human can make it permanent via /agent-auth/claim");
    }

    const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (mutating && !rec.scopes.includes("write")) return fail(403, "write scope required");
    if (!mutating && !rec.scopes.includes("read") && !rec.scopes.includes("write")) {
      return fail(403, "read scope required");
    }

    const now = Date.now();
    const recent = (hits.get(rec.key_id) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= rateLimitPerMinute) return fail(429, "rate limit exceeded");
    recent.push(now);
    hits.set(rec.key_id, recent);

    rec.usage = (rec.usage ?? 0) + 1;
    keys[rec.key_id] = rec;
    await writeKeys(dir, keys);
    billingPromise.then((b) => b?.onMeter(rec)).catch(() => {});

    req.agent = {
      key_id: rec.key_id,
      client_name: rec.client_name,
      scopes: rec.scopes,
      status: rec.status,
    };
    if (typeof next === "function") next();
    return true;
  };
}
