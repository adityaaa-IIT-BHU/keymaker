import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { verifyAttestation } from "./attest.js";
import { handleMcpRequest } from "./mcp-http.js";
import { createBilling } from "./billing.js";
import { hashKey, findByKey, readKeys, writeKeys } from "./store.js";

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

const GATEWAY_PATHS = new Set([
  "/auth.md",
  "/.well-known/auth.md",
  "/llms.txt",
  "/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/register",
  "/token",
]);

// Public origin of this gateway, from config or the request's Host header, so
// OAuth discovery documents advertise reachable URLs without hardcoding.
function originOf(req, config, mountBase = "") {
  // config.public_url is the full origin including any mount (set per-tenant in
  // the cloud case), so it is used as-is. Only header-derived origins need mountBase.
  if (config.public_url) return config.public_url.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  return `${proto}://${host}${mountBase}`;
}

/**
 * Mountable agent gateway: serves /auth.md, /.well-known/auth.md, /llms.txt,
 * /agent-auth*, and /mcp from inside any node HTTP app.
 *
 * const gateway = await keymakerGateway({ dir: "./agent-ready" });
 * // plain node:  if (await gateway(req, res)) return;
 * // express:     app.use(gateway.express());
 *
 * Returns true if the request was handled.
 */
export async function keymakerGateway({ dir, mountBase = "" }) {
  let config = {};
  try {
    config = JSON.parse(await readFile(join(dir, "signup.config.json"), "utf8"));
  } catch {}
  let mcpMeta = null;
  try {
    mcpMeta = JSON.parse(await readFile(join(dir, "tools.json"), "utf8"));
  } catch {}
  const billing = createBilling(config.billing);

  const registrationLimit = config.registrations_per_minute_per_ip ?? 10;
  const verifyLimit = config.verifies_per_minute_per_key ?? 120;
  const mcpLimit = config.mcp_requests_per_minute_per_key ?? 60;
  const regHits = new Map();
  const verifyHits = new Map();
  const mcpHits = new Map();
  const allow = (map, id, limit) => {
    const now = Date.now();
    const recent = (map.get(id) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= limit) return false;
    recent.push(now);
    map.set(id, recent);
    return true;
  };

  // keys.json on disk is the source of truth — the vendor's API process
  // (keymakerAuth middleware) reads and writes it too. Raw keys are never
  // stored; records hold a SHA-256 hash plus a display prefix.
  const load = () => readKeys(dir);
  const save = (keys) => writeKeys(dir, keys);
  const safeEqual = (a, b) => {
    const ba = Buffer.from(String(a ?? ""));
    const bb = Buffer.from(String(b ?? ""));
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    if (!GATEWAY_PATHS.has(p) && !p.startsWith("/agent-auth")) return false;

    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(type === "application/json" ? JSON.stringify(body, null, 2) : body);
    };
    try {
      if (req.method === "GET" && (p === "/auth.md" || p === "/.well-known/auth.md")) {
        send(200, await readFile(join(dir, "auth.md"), "utf8"), "text/markdown");
        return true;
      }
      if (req.method === "GET" && p === "/llms.txt") {
        send(200, await readFile(join(dir, "llms.txt"), "utf8"), "text/plain");
        return true;
      }
      if (req.method === "POST" && p === "/agent-auth") {
        if (!allow(regHits, req.socket.remoteAddress ?? "?", registrationLimit)) {
          send(429, { error: "registration rate limit exceeded; retry in a minute" });
          return true;
        }
        const body = await readJson(req);
        let attResult = null;
        if (body.attestation) attResult = await verifyAttestation(body.attestation, config);
        const verified = Boolean(attResult?.verified);
        const keys = await load();
        const keyId = `key_${randomBytes(6).toString("hex")}`;
        const apiKey = `ak_${randomBytes(24).toString("hex")}`;
        const record = {
          key_id: keyId,
          key_hash: hashKey(apiKey),
          key_prefix: apiKey.slice(0, 10),
          client_name: String(body.client_name ?? "unnamed-agent").slice(0, 100),
          scopes: Array.isArray(body.scopes) && body.scopes.length ? body.scopes.map(String) : ["read"],
          status: verified ? "agent_verified" : "unclaimed",
          attestation_mode: attResult?.mode ?? null,
          created_at: new Date().toISOString(),
          expires_at: verified ? null : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          claim_token: verified ? null : `ct_${randomBytes(12).toString("hex")}`,
          usage: 0,
        };
        if (billing) {
          try {
            const b = await billing.onRegister(record, body);
            if (b?.customer_id) record.billing_customer_id = b.customer_id;
          } catch {}
        }
        keys[keyId] = record;
        await save(keys);
        const { claim_token, key_hash, ...pub } = record;
        send(201, {
          ...pub,
          api_key: apiKey,
          key_storage: "hashed — this is the only time the full key is shown",
          ...(claim_token ? { claim_token, claim_endpoint: "/agent-auth/claim" } : {}),
          ...(attResult && !attResult.verified ? { attestation_error: attResult.reason } : {}),
        });
        return true;
      }
      if (req.method === "POST" && p === "/agent-auth/claim") {
        const { claim_token } = await readJson(req);
        const keys = await load();
        const rec = Object.values(keys).find((k) => k.claim_token && k.claim_token === claim_token);
        if (!rec) {
          send(404, { error: "unknown claim token" });
          return true;
        }
        rec.status = "claimed";
        rec.expires_at = null;
        rec.claim_token = null;
        await save(keys);
        send(200, { key_id: rec.key_id, status: rec.status });
        return true;
      }
      if (req.method === "POST" && p === "/agent-auth/verify") {
        const { api_key } = await readJson(req);
        if (!allow(verifyHits, String(api_key ?? "?"), verifyLimit)) {
          send(429, { error: "verify rate limit exceeded" });
          return true;
        }
        const keys = await load();
        const rec = findByKey(keys, api_key);
        const expired = rec?.expires_at && Date.parse(rec.expires_at) < Date.now();
        if (!rec || expired || rec.revoked) {
          send(401, { valid: false });
          return true;
        }
        rec.usage += 1;
        await save(keys);
        billing?.onMeter(rec).catch(() => {});
        send(200, {
          valid: true,
          key_id: rec.key_id,
          scopes: rec.scopes,
          status: rec.status,
          usage: rec.usage,
        });
        return true;
      }
      if (req.method === "GET" && p === "/agent-auth/keys") {
        send(
          200,
          Object.values(await load())
            .filter((k) => k.type !== "oauth_client")
            .map(({ key_hash, claim_token, ...rest }) => rest)
        );
        return true;
      }
      if (req.method === "POST" && p === "/agent-auth/revoke") {
        if (!config.admin_token || !safeEqual(req.headers["x-admin-token"], config.admin_token)) {
          send(401, { error: "admin token required (x-admin-token header)" });
          return true;
        }
        const { key_id } = await readJson(req);
        const keys = await load();
        if (!keys[key_id]) {
          send(404, { error: "unknown key_id" });
          return true;
        }
        keys[key_id].revoked = true;
        await save(keys);
        send(200, { key_id, revoked: true });
        return true;
      }
      // --- OAuth 2.1 for MCP clients (RFC 9728 + 8414 + 7591 client_credentials) ---
      // Lets Claude Desktop / Cursor discover, register, and get a token natively
      // instead of a human pasting an ak_ key.
      if (req.method === "GET" && p === "/.well-known/oauth-protected-resource") {
        const origin = originOf(req, config, mountBase);
        send(200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
          scopes_supported: ["read", "write"],
        });
        return true;
      }
      if (req.method === "GET" && p === "/.well-known/oauth-authorization-server") {
        const origin = originOf(req, config, mountBase);
        send(200, {
          issuer: origin,
          registration_endpoint: `${origin}/register`,
          token_endpoint: `${origin}/token`,
          grant_types_supported: ["client_credentials"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          scopes_supported: ["read", "write"],
        });
        return true;
      }
      if (req.method === "POST" && p === "/register") {
        if (!allow(regHits, req.socket.remoteAddress ?? "?", registrationLimit)) {
          send(429, { error: "registration rate limit exceeded; retry in a minute" });
          return true;
        }
        const body = await readJson(req);
        const keys = await load();
        const clientId = `cid_${randomBytes(8).toString("hex")}`;
        const clientSecret = `cs_${randomBytes(24).toString("hex")}`;
        const scopes = String(body.scope ?? "read")
          .split(/\s+/)
          .filter(Boolean);
        keys[clientId] = {
          type: "oauth_client",
          client_id: clientId,
          secret_hash: hashKey(clientSecret),
          client_name: String(body.client_name ?? "mcp-client").slice(0, 100),
          scopes: scopes.length ? scopes : ["read"],
          created_at: new Date().toISOString(),
        };
        await save(keys);
        send(201, {
          client_id: clientId,
          client_secret: clientSecret,
          client_name: keys[clientId].client_name,
          grant_types: ["client_credentials"],
          token_endpoint_auth_method: "client_secret_post",
          scope: keys[clientId].scopes.join(" "),
        });
        return true;
      }
      if (req.method === "POST" && p === "/token") {
        const ct = req.headers["content-type"] ?? "";
        let body;
        if (ct.includes("application/json")) {
          body = await readJson(req);
        } else {
          let raw = "";
          for await (const c of req) raw += c;
          body = Object.fromEntries(new URLSearchParams(raw));
        }
        if (body.grant_type !== "client_credentials") {
          send(400, { error: "unsupported_grant_type" });
          return true;
        }
        const keys = await load();
        const client = keys[body.client_id];
        if (
          !client ||
          client.type !== "oauth_client" ||
          !safeEqual(hashKey(body.client_secret ?? ""), client.secret_hash)
        ) {
          send(401, { error: "invalid_client" });
          return true;
        }
        // Mint a fresh agent key as the access token; scope-narrow to what was requested.
        const requested = String(body.scope ?? "").split(/\s+/).filter(Boolean);
        const scopes = requested.length
          ? requested.filter((s) => client.scopes.includes(s))
          : client.scopes;
        const keyId = `key_${randomBytes(6).toString("hex")}`;
        const apiKey = `ak_${randomBytes(24).toString("hex")}`;
        const ttlSec = 3600;
        keys[keyId] = {
          key_id: keyId,
          key_hash: hashKey(apiKey),
          key_prefix: apiKey.slice(0, 10),
          client_name: client.client_name,
          scopes: scopes.length ? scopes : ["read"],
          status: "agent_verified",
          issued_via: "oauth_client_credentials",
          oauth_client_id: client.client_id,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
          usage: 0,
        };
        if (billing) {
          try {
            const b = await billing.onRegister(keys[keyId], {});
            if (b?.customer_id) keys[keyId].billing_customer_id = b.customer_id;
          } catch {}
        }
        await save(keys);
        send(200, {
          access_token: apiKey,
          token_type: "Bearer",
          expires_in: ttlSec,
          scope: keys[keyId].scopes.join(" "),
        });
        return true;
      }

      if (p === "/mcp") {
        if (!mcpMeta) {
          send(501, { error: "no tools.json in this directory; re-run keymaker generate" });
          return true;
        }
        if (req.method !== "POST") {
          send(405, { error: "POST only (stateless MCP)" });
          return true;
        }
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : null;
        const keys = await load();
        const rec = findByKey(keys, token);
        const expired = rec?.expires_at && Date.parse(rec.expires_at) < Date.now();
        if (!rec || expired || rec.revoked) {
          // Point OAuth-capable MCP clients at the protected-resource metadata (MCP auth spec).
          const origin = originOf(req, config, mountBase);
          res.writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          });
          res.end(
            JSON.stringify({
              error: "valid bearer key required; register via POST /agent-auth (see /auth.md) or OAuth /token",
            })
          );
          return true;
        }
        if (!allow(mcpHits, rec.key_id, mcpLimit)) {
          send(429, { error: "mcp rate limit exceeded; retry in a minute" });
          return true;
        }
        const body = await readJson(req);
        await handleMcpRequest(req, res, body, {
          meta: mcpMeta,
          // api_key: the presented raw token — records only store its hash, and
          // the proxy needs it to forward the agent's identity upstream.
          agent: { ...rec, api_key: token },
          meter: async () => {
            const fresh = await load();
            if (fresh[rec.key_id]) {
              fresh[rec.key_id].usage += 1;
              await save(fresh);
              billing?.onMeter(fresh[rec.key_id]).catch(() => {});
            }
          },
        });
        return true;
      }
      send(404, { error: "not found", hint: "GET /auth.md for agent registration instructions" });
      return true;
    } catch (err) {
      send(500, { error: String(err?.message ?? err) });
      return true;
    }
  };

  handler.express = () => (req, res, next) => {
    handler(req, res)
      .then((handled) => {
        if (!handled) next();
      })
      .catch(next);
  };

  return handler;
}
