import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSignupServer } from "../src/serve.js";
import { initStripeBilling } from "../src/billing.js";

test("billing: registration creates a Stripe customer, metering emits meter events", async (t) => {
  // Mock Stripe
  const stripeCalls = [];
  const stripe = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    stripeCalls.push({ path: req.url, params: Object.fromEntries(new URLSearchParams(body)) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/v1/customers" ? { id: "cus_mock123" } : { ok: true }));
  });
  await new Promise((r) => stripe.listen(0, r));
  t.after(() => stripe.close());

  process.env.KM_TEST_STRIPE_KEY = "sk_test_mock";
  const dir = await mkdtemp(join(tmpdir(), "keymaker-billing-"));
  await writeFile(join(dir, "auth.md"), "# a");
  await writeFile(join(dir, "llms.txt"), "# l");
  await writeFile(
    join(dir, "signup.config.json"),
    JSON.stringify({
      dev_accept_any_attestation: true,
      billing: {
        provider: "stripe",
        secret_key_env: "KM_TEST_STRIPE_KEY",
        api_base: `http://localhost:${stripe.address().port}`,
        meter_event_name: "km_test_call",
      },
    })
  );
  const server = await startSignupServer({ dir, port: 0 });
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;

  const reg = await (
    await fetch(`${base}/agent-auth`, {
      method: "POST",
      body: JSON.stringify({ client_name: "billed-agent", billing_email: "agent@example.com" }),
    })
  ).json();
  assert.equal(reg.billing_customer_id, "cus_mock123");

  const customerCall = stripeCalls.find((c) => c.path === "/v1/customers");
  assert.equal(customerCall.params.name, "billed-agent");
  assert.equal(customerCall.params.email, "agent@example.com");
  assert.equal(customerCall.params["metadata[key_id]"], reg.key_id);

  // verify → meter event (fire-and-forget, so poll briefly)
  await fetch(`${base}/agent-auth/verify`, {
    method: "POST",
    body: JSON.stringify({ api_key: reg.api_key }),
  });
  for (let i = 0; i < 20 && !stripeCalls.some((c) => c.path === "/v1/billing/meter_events"); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const meterCall = stripeCalls.find((c) => c.path === "/v1/billing/meter_events");
  assert.ok(meterCall, "meter event was sent to Stripe");
  assert.equal(meterCall.params.event_name, "km_test_call");
  assert.equal(meterCall.params["payload[stripe_customer_id]"], "cus_mock123");
});

test("billing-init creates meter, product, and metered price", async (t) => {
  const calls = [];
  const stripe = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push({ method: req.method, path: req.url, params: Object.fromEntries(new URLSearchParams(body)) });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "GET" && req.url === "/v1/billing/meters") return res.end(JSON.stringify({ data: [] }));
    if (req.url === "/v1/billing/meters") return res.end(JSON.stringify({ id: "mtr_1", event_name: "km_call" }));
    if (req.url === "/v1/products") return res.end(JSON.stringify({ id: "prod_1" }));
    if (req.url === "/v1/prices") return res.end(JSON.stringify({ id: "price_1" }));
    res.end("{}");
  });
  await new Promise((r) => stripe.listen(0, r));
  t.after(() => stripe.close());

  process.env.KM_INIT_STRIPE_KEY = "sk_test_mock";
  const out = await initStripeBilling({
    secretKeyEnv: "KM_INIT_STRIPE_KEY",
    apiBase: `http://localhost:${stripe.address().port}`,
    eventName: "km_call",
    perCallUsd: 0.002,
  });

  assert.deepEqual(out, { meter_id: "mtr_1", product_id: "prod_1", price_id: "price_1", event_name: "km_call" });
  const priceCall = calls.find((c) => c.path === "/v1/prices");
  assert.equal(priceCall.params["recurring[meter]"], "mtr_1");
  assert.equal(priceCall.params["recurring[usage_type]"], "metered");
  assert.equal(priceCall.params.unit_amount_decimal, "0.2");
});

test("billing disabled → no customer id, registration still works", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "keymaker-nobill-"));
  await writeFile(join(dir, "auth.md"), "# a");
  await writeFile(join(dir, "llms.txt"), "# l");
  await writeFile(join(dir, "signup.config.json"), JSON.stringify({ dev_accept_any_attestation: true }));
  const server = await startSignupServer({ dir, port: 0 });
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const reg = await (
    await fetch(`${base}/agent-auth`, { method: "POST", body: JSON.stringify({ client_name: "x" }) })
  ).json();
  assert.equal(reg.billing_customer_id, undefined);
  assert.ok(reg.api_key);
});
