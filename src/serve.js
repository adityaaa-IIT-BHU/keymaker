import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { verifyAttestation } from "./attest.js";

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

export async function startSignupServer({ dir, port = 8787 }) {
  const keysPath = join(dir, "keys.json");
  let config = {};
  try {
    config = JSON.parse(await readFile(join(dir, "signup.config.json"), "utf8"));
  } catch {}
  const registrationLimit = config.registrations_per_minute_per_ip ?? 10;
  const verifyLimit = config.verifies_per_minute_per_key ?? 120;
  const regHits = new Map();
  const verifyHits = new Map();
  const allow = (map, id, limit) => {
    const now = Date.now();
    const recent = (map.get(id) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= limit) return false;
    recent.push(now);
    map.set(id, recent);
    return true;
  };

  // keys.json on disk is the source of truth — the vendor's API process
  // (keymakerAuth middleware) reads and writes it too.
  const load = async () => {
    try {
      return JSON.parse(await readFile(keysPath, "utf8"));
    } catch {
      return {};
    }
  };
  const save = (keys) => writeFile(keysPath, JSON.stringify(keys, null, 2));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(type === "application/json" ? JSON.stringify(body, null, 2) : body);
    };
    try {
      if (req.method === "GET" && (url.pathname === "/auth.md" || url.pathname === "/.well-known/auth.md")) {
        return send(200, await readFile(join(dir, "auth.md"), "utf8"), "text/markdown");
      }
      if (req.method === "GET" && url.pathname === "/llms.txt") {
        return send(200, await readFile(join(dir, "llms.txt"), "utf8"), "text/plain");
      }
      if (req.method === "POST" && url.pathname === "/agent-auth") {
        if (!allow(regHits, req.socket.remoteAddress ?? "?", registrationLimit)) {
          return send(429, { error: "registration rate limit exceeded; retry in a minute" });
        }
        const body = await readJson(req);
        let attResult = null;
        if (body.attestation) attResult = await verifyAttestation(body.attestation, config);
        const verified = Boolean(attResult?.verified);
        const keys = await load();
        const keyId = `key_${randomBytes(6).toString("hex")}`;
        const record = {
          key_id: keyId,
          api_key: `ak_${randomBytes(24).toString("hex")}`,
          client_name: String(body.client_name ?? "unnamed-agent").slice(0, 100),
          scopes: Array.isArray(body.scopes) && body.scopes.length ? body.scopes.map(String) : ["read"],
          status: verified ? "agent_verified" : "unclaimed",
          attestation_mode: attResult?.mode ?? null,
          created_at: new Date().toISOString(),
          expires_at: verified ? null : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          claim_token: verified ? null : `ct_${randomBytes(12).toString("hex")}`,
          usage: 0,
        };
        keys[keyId] = record;
        await save(keys);
        const { claim_token, ...pub } = record;
        return send(201, {
          ...pub,
          ...(claim_token ? { claim_token, claim_endpoint: "/agent-auth/claim" } : {}),
          ...(attResult && !attResult.verified ? { attestation_error: attResult.reason } : {}),
        });
      }
      if (req.method === "POST" && url.pathname === "/agent-auth/claim") {
        const { claim_token } = await readJson(req);
        const keys = await load();
        const rec = Object.values(keys).find((k) => k.claim_token && k.claim_token === claim_token);
        if (!rec) return send(404, { error: "unknown claim token" });
        rec.status = "claimed";
        rec.expires_at = null;
        rec.claim_token = null;
        await save(keys);
        return send(200, { key_id: rec.key_id, status: rec.status });
      }
      if (req.method === "POST" && url.pathname === "/agent-auth/verify") {
        const { api_key } = await readJson(req);
        if (!allow(verifyHits, String(api_key ?? "?"), verifyLimit)) {
          return send(429, { error: "verify rate limit exceeded" });
        }
        const keys = await load();
        const rec = Object.values(keys).find((k) => k.api_key === api_key);
        const expired = rec?.expires_at && Date.parse(rec.expires_at) < Date.now();
        if (!rec || expired) return send(401, { valid: false });
        rec.usage += 1;
        await save(keys);
        return send(200, {
          valid: true,
          key_id: rec.key_id,
          scopes: rec.scopes,
          status: rec.status,
          usage: rec.usage,
        });
      }
      if (req.method === "GET" && url.pathname === "/agent-auth/keys") {
        return send(
          200,
          Object.values(await load()).map(({ api_key, claim_token, ...rest }) => rest)
        );
      }
      return send(404, { error: "not found", hint: "GET /auth.md for agent registration instructions" });
    } catch (err) {
      return send(500, { error: String(err?.message ?? err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, resolve);
  });
  return server;
}
