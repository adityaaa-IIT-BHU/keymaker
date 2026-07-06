import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSignupServer } from "../src/serve.js";

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

async function rpc(base, key, method, params, id = 1) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function setup(t) {
  // Stub upstream API the MCP endpoint proxies to
  const upstream = createServer((req, res) => {
    res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, method: req.method, url: req.url }));
  });
  await new Promise((r) => upstream.listen(0, r));
  const upstreamUrl = `http://localhost:${upstream.address().port}`;

  const dir = await mkdtemp(join(tmpdir(), "keymaker-mcp-"));
  await writeFile(join(dir, "auth.md"), "# a");
  await writeFile(join(dir, "llms.txt"), "# l");
  await writeFile(
    join(dir, "signup.config.json"),
    JSON.stringify({ dev_accept_any_attestation: true, admin_token: "adm_test" })
  );
  await writeFile(
    join(dir, "tools.json"),
    JSON.stringify({
      title: "Stub API",
      version: "1.0.0",
      baseUrl: upstreamUrl,
      meter_at_gateway: true,
      tools: [
        {
          name: "listThings",
          description: "List things",
          method: "GET",
          path: "/things",
          paramLocs: {},
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "makeThing",
          description: "Make a thing",
          method: "POST",
          path: "/things",
          paramLocs: { name: "body" },
          inputSchema: { type: "object", properties: { name: { type: "string" } } },
        },
      ],
    })
  );
  const server = await startSignupServer({ dir, port: 0 });
  t.after(() => {
    server.close();
    upstream.close();
  });
  const base = `http://localhost:${server.address().port}`;
  const register = async (scopes) =>
    (
      await (
        await fetch(`${base}/agent-auth`, {
          method: "POST",
          body: JSON.stringify({ client_name: "t", scopes }),
        })
      ).json()
    ).api_key;
  return { base, register };
}

test("hosted /mcp: register → initialize → list → call, scope-filtered", async (t) => {
  const { base, register } = await setup(t);

  // no key → 401
  assert.equal((await rpc(base, null, "tools/list", {})).status, 401);

  const readKey = await register(["read"]);
  const init = await rpc(base, readKey, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  });
  assert.equal(init.status, 200);
  assert.match(init.body.result.serverInfo.name, /Stub API/);

  // read-scoped key sees only GET tools
  const list = await rpc(base, readKey, "tools/list", {}, 2);
  assert.deepEqual(
    list.body.result.tools.map((x) => x.name),
    ["listThings"]
  );

  // write-scoped key sees both and can call the POST tool
  const writeKey = await register(["read", "write"]);
  const list2 = await rpc(base, writeKey, "tools/list", {}, 3);
  assert.equal(list2.body.result.tools.length, 2);
  const call = await rpc(base, writeKey, "tools/call", { name: "makeThing", arguments: { name: "x" } }, 4);
  assert.match(call.body.result.content[0].text, /HTTP 201 POST/);

  // usage was metered for the successful call
  const issued = await (await fetch(`${base}/agent-auth/keys`)).json();
  const writer = issued.find((k) => k.scopes.includes("write"));
  assert.equal(writer.usage, 1);
});

test("revocation kills a key everywhere", async (t) => {
  const { base, register } = await setup(t);
  const key = await register(["read", "write"]);
  const issued = await (await fetch(`${base}/agent-auth/keys`)).json();
  const keyId = issued[0].key_id;

  // bad admin token → 401
  const bad = await fetch(`${base}/agent-auth/revoke`, {
    method: "POST",
    headers: { "x-admin-token": "wrong" },
    body: JSON.stringify({ key_id: keyId }),
  });
  assert.equal(bad.status, 401);

  const ok = await fetch(`${base}/agent-auth/revoke`, {
    method: "POST",
    headers: { "x-admin-token": "adm_test" },
    body: JSON.stringify({ key_id: keyId }),
  });
  assert.equal(ok.status, 200);

  // verify and /mcp both reject the revoked key
  const ver = await fetch(`${base}/agent-auth/verify`, {
    method: "POST",
    body: JSON.stringify({ api_key: key }),
  });
  assert.equal(ver.status, 401);
  assert.equal((await rpc(base, key, "tools/list", {})).status, 401);
});
