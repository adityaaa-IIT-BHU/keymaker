import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSignupServer } from "../src/serve.js";
import { readKeys } from "../src/store.js";

test("sqlite storage: full signup flow persists to keys.db, no keys.json", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "keymaker-sqlite-"));
  await writeFile(join(dir, "auth.md"), "# a");
  await writeFile(join(dir, "llms.txt"), "# l");
  await writeFile(
    join(dir, "signup.config.json"),
    JSON.stringify({ dev_accept_any_attestation: true, storage: { driver: "sqlite" } })
  );
  const server = await startSignupServer({ dir, port: 0 });
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;

  const reg = await (
    await fetch(`${base}/agent-auth`, {
      method: "POST",
      body: JSON.stringify({ client_name: "sqlite-agent", scopes: ["read"] }),
    })
  ).json();
  assert.ok(reg.api_key.startsWith("ak_"));

  const ver = await (
    await fetch(`${base}/agent-auth/verify`, {
      method: "POST",
      body: JSON.stringify({ api_key: reg.api_key }),
    })
  ).json();
  assert.equal(ver.valid, true);
  assert.equal(ver.usage, 1);

  // keys.db exists; keys.json was never created
  await access(join(dir, "keys.db"));
  await assert.rejects(access(join(dir, "keys.json")));

  // records are hashed in sqlite too, and readable through the same interface
  const keys = await readKeys(dir);
  const rec = Object.values(keys)[0];
  assert.ok(rec.key_hash && !rec.api_key);
  assert.equal(rec.usage, 1);
});
