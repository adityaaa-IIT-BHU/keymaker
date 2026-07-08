import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloud } from "../src/cloud.js";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Widget API", version: "1.0.0" },
  servers: [{ url: "http://UPSTREAM/v1" }],
  paths: {
    "/widgets": {
      get: { operationId: "listWidgets", summary: "List widgets", tags: ["Widgets"] },
      post: {
        operationId: "makeWidget",
        summary: "Make a widget",
        tags: ["Widgets"],
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "name" } } } } },
        },
      },
    },
  },
};

async function withCloud(t) {
  // Serve the spec + act as the upstream API the MCP proxy calls.
  const upstream = createServer((req, res) => {
    if (req.url === "/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(SPEC));
    }
    res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, method: req.method, url: req.url }));
  });
  await new Promise((r) => upstream.listen(0, r));
  const upstreamUrl = `http://localhost:${upstream.address().port}`;
  // Point the spec's server at the live upstream so /mcp calls resolve.
  SPEC.servers[0].url = `${upstreamUrl}/v1`;

  const dataRoot = await mkdtemp(join(tmpdir(), "keymaker-cloud-"));
  const server = await startCloud({ dataRoot, port: 0 });
  const base = `http://localhost:${server.address().port}`;
  t.after(() => { server.close(); upstream.close(); });
  return { base, upstreamUrl };
}

async function provision(base, name, specUrl) {
  const r = await fetch(`${base}/v1/tenants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, spec_url: specUrl }),
  });
  return { status: r.status, body: await r.json() };
}

test("provision a tenant, agent signs up, calls MCP, isolation holds", async (t) => {
  const { base, upstreamUrl } = await withCloud(t);

  const p = await provision(base, "Widget Co", `${upstreamUrl}/openapi.json`);
  assert.equal(p.status, 201);
  assert.equal(p.body.tenant_id, "widget-co");
  assert.equal(p.body.operations, 2);
  assert.ok(p.body.admin_token.startsWith("adm_"));
  assert.match(p.body.urls.mcp, /\/t\/widget-co\/mcp$/);

  // auth.md is served under the tenant prefix
  const authmd = await fetch(`${base}/t/widget-co/auth.md`);
  assert.equal(authmd.status, 200);
  assert.match(await authmd.text(), /Agent registration/);

  // an agent signs itself up on this tenant
  const reg = await (
    await fetch(`${base}/t/widget-co/agent-auth`, {
      method: "POST",
      body: JSON.stringify({ client_name: "shopper-bot", scopes: ["read", "write"] }),
    })
  ).json();
  assert.ok(reg.api_key.startsWith("ak_"));

  // and calls a tool through the tenant's hosted MCP
  const call = await (
    await fetch(`${base}/t/widget-co/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${reg.api_key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "listWidgets", arguments: {} } }),
    })
  ).json();
  assert.match(call.result.content[0].text, /HTTP 200 GET/);

  // second tenant is isolated — its key list does not include the first tenant's agent
  const p2 = await provision(base, "Gadget Co", `${upstreamUrl}/openapi.json`);
  assert.equal(p2.body.tenant_id, "gadget-co");
  const gadgetKeys = await (await fetch(`${base}/t/gadget-co/agent-auth/keys`)).json();
  assert.equal(gadgetKeys.length, 0); // nobody signed up on gadget-co
  const widgetKeys = await (await fetch(`${base}/t/widget-co/agent-auth/keys`)).json();
  assert.equal(widgetKeys.length, 1);
});

test("dashboard requires the admin token", async (t) => {
  const { base, upstreamUrl } = await withCloud(t);
  const p = await provision(base, "Dash Co", `${upstreamUrl}/openapi.json`);
  const id = p.body.tenant_id;

  assert.equal((await fetch(`${base}/t/${id}/dashboard`)).status, 401);
  const ok = await fetch(`${base}/t/${id}/dashboard?admin_token=${p.body.admin_token}`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /dashboard/);
});

test("OAuth client_credentials issues a working MCP token", async (t) => {
  const { base, upstreamUrl } = await withCloud(t);
  const p = await provision(base, "OAuth Co", `${upstreamUrl}/openapi.json`);
  const id = p.body.tenant_id;

  // discovery
  const meta = await (await fetch(`${base}/t/${id}/.well-known/oauth-authorization-server`)).json();
  assert.match(meta.token_endpoint, /\/t\/oauth-co\/token$/);
  assert.match(meta.registration_endpoint, /\/t\/oauth-co\/register$/);

  // DCR
  const reg = await (
    await fetch(`${base}/t/${id}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "claude-desktop", scope: "read" }),
    })
  ).json();
  assert.ok(reg.client_id.startsWith("cid_"));
  assert.ok(reg.client_secret.startsWith("cs_"));

  // token (client_credentials, form-encoded like a real OAuth client)
  const tok = await (
    await fetch(`${base}/t/${id}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: reg.client_id,
        client_secret: reg.client_secret,
        scope: "read",
      }),
    })
  ).json();
  assert.equal(tok.token_type, "Bearer");
  assert.ok(tok.access_token.startsWith("ak_"));

  // the token works on /mcp
  const call = await fetch(`${base}/t/${id}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tok.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(call.status, 200);

  // wrong secret is rejected
  const bad = await fetch(`${base}/t/${id}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: reg.client_id, client_secret: "cs_wrong" }),
  });
  assert.equal(bad.status, 401);

  // OAuth clients don't leak into the key list
  const keys = await (await fetch(`${base}/t/${id}/agent-auth/keys`)).json();
  assert.ok(keys.every((k) => k.type !== "oauth_client"));
});

test("unauthenticated /mcp returns WWW-Authenticate pointing at resource metadata", async (t) => {
  const { base, upstreamUrl } = await withCloud(t);
  const p = await provision(base, "WWW Co", `${upstreamUrl}/openapi.json`);
  const id = p.body.tenant_id;
  const res = await fetch(`${base}/t/${id}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=.*oauth-protected-resource/);
});
