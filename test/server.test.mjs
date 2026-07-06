import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSignupServer } from "../src/serve.js";
import { keymakerAuth } from "../src/middleware.js";
import { hashKey } from "../src/store.js";

async function tempDir(config = { dev_accept_any_attestation: true }) {
  const dir = await mkdtemp(join(tmpdir(), "keymaker-"));
  await writeFile(join(dir, "auth.md"), "# test auth.md");
  await writeFile(join(dir, "llms.txt"), "# test llms.txt");
  await writeFile(join(dir, "signup.config.json"), JSON.stringify(config));
  return dir;
}

test("signup → verify → claim → attested flow", async (t) => {
  const dir = await tempDir();
  const server = await startSignupServer({ dir, port: 0 });
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;

  const reg = await (
    await fetch(`${base}/agent-auth`, {
      method: "POST",
      body: JSON.stringify({ client_name: "test-agent", scopes: ["read", "write"] }),
    })
  ).json();
  assert.equal(reg.status, "unclaimed");
  assert.ok(reg.api_key.startsWith("ak_"));
  assert.ok(reg.claim_token);

  const ver = await (
    await fetch(`${base}/agent-auth/verify`, {
      method: "POST",
      body: JSON.stringify({ api_key: reg.api_key }),
    })
  ).json();
  assert.equal(ver.valid, true);
  assert.equal(ver.usage, 1);

  const claim = await (
    await fetch(`${base}/agent-auth/claim`, {
      method: "POST",
      body: JSON.stringify({ claim_token: reg.claim_token }),
    })
  ).json();
  assert.equal(claim.status, "claimed");

  const att = await (
    await fetch(`${base}/agent-auth`, {
      method: "POST",
      body: JSON.stringify({ client_name: "attested", attestation: "dev-token" }),
    })
  ).json();
  assert.equal(att.status, "agent_verified");
  assert.equal(att.expires_at, null);
  assert.equal(att.attestation_mode, "dev-accepted");

  const md = await (await fetch(`${base}/.well-known/auth.md`)).text();
  assert.match(md, /test auth\.md/);

  // raw keys never touch disk — records hold only hash + display prefix
  const onDisk = Object.values(JSON.parse(await readFile(join(dir, "keys.json"), "utf8")));
  assert.ok(onDisk.length >= 2);
  assert.ok(onDisk.every((r) => !r.api_key && r.key_hash && r.key_prefix.startsWith("ak_")));
  assert.ok(onDisk.some((r) => r.key_hash === hashKey(reg.api_key)));
});

test("rejected attestation still issues a temporary key with the reason", async (t) => {
  const dir = await tempDir({ dev_accept_any_attestation: false, trusted_issuers: [] });
  const server = await startSignupServer({ dir, port: 0 });
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const reg = await (
    await fetch(`${base}/agent-auth`, {
      method: "POST",
      body: JSON.stringify({ client_name: "x", attestation: "garbage" }),
    })
  ).json();
  assert.equal(reg.status, "unclaimed");
  assert.match(reg.attestation_error, /no trusted_issuers/);
});

test("registration rate limit per IP", async (t) => {
  const dir = await tempDir({ registrations_per_minute_per_ip: 2 });
  const server = await startSignupServer({ dir, port: 0 });
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const codes = [];
  for (let i = 0; i < 3; i++) {
    codes.push((await fetch(`${base}/agent-auth`, { method: "POST", body: "{}" })).status);
  }
  assert.deepEqual(codes, [201, 201, 429]);
});

test("middleware enforces auth, scopes, and rate limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keymaker-mw-"));
  const rec = {
    key_id: "key_1",
    key_hash: hashKey("ak_test"),
    key_prefix: "ak_test",
    client_name: "t",
    scopes: ["read"],
    status: "claimed",
    expires_at: null,
    usage: 0,
  };
  await writeFile(join(dir, "keys.json"), JSON.stringify({ key_1: rec }));
  const mw = keymakerAuth({ dir, rateLimitPerMinute: 2 });
  const mkRes = () => {
    const r = { code: null, writeHead(c) { r.code = c; return r; }, end() {} };
    return r;
  };

  let res = mkRes();
  assert.equal(await mw({ headers: {}, method: "GET" }, res), false);
  assert.equal(res.code, 401);

  res = mkRes();
  const req = { headers: { authorization: "Bearer ak_test" }, method: "GET" };
  assert.equal(await mw(req, res), true);
  assert.equal(req.agent.key_id, "key_1");

  res = mkRes();
  assert.equal(await mw({ headers: { authorization: "Bearer ak_test" }, method: "POST" }, res), false);
  assert.equal(res.code, 403);

  res = mkRes();
  await mw({ headers: { authorization: "Bearer ak_test" }, method: "GET" }, res);
  res = mkRes();
  assert.equal(await mw({ headers: { authorization: "Bearer ak_test" }, method: "GET" }, res), false);
  assert.equal(res.code, 429);
});
