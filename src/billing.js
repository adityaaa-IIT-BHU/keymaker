/**
 * Config-gated billing provider. Enable in signup.config.json:
 *   "billing": {
 *     "provider": "stripe",
 *     "secret_key_env": "STRIPE_SECRET_KEY",
 *     "meter_event_name": "keymaker_api_call"
 *   }
 * On registration the agent becomes a Stripe customer; every metered request
 * emits a Billing Meter event, so a metered price turns usage into invoices.
 * Returns null when unconfigured — billing is always optional.
 */
/**
 * One-command Stripe setup: creates (or reuses) the billing meter, a product,
 * and a metered monthly price. Works in test mode (sk_test_…) immediately —
 * no account activation needed until you charge real money.
 */
export async function initStripeBilling({
  secretKeyEnv = "STRIPE_SECRET_KEY",
  apiBase = "https://api.stripe.com",
  eventName = "keymaker_api_call",
  perCallUsd = 0.001,
  currency = "usd",
} = {}) {
  const key = process.env[secretKeyEnv];
  if (!key) throw new Error(`Set ${secretKeyEnv} first (a test-mode sk_test_… key works fine).`);
  const base = apiBase.replace(/\/$/, "");
  const call = async (method, path, params) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(params ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: params ? new URLSearchParams(params) : undefined,
    });
    if (!res.ok) throw new Error(`Stripe ${path}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  };

  const meters = await call("GET", "/v1/billing/meters");
  let meter = (meters.data ?? []).find((m) => m.event_name === eventName && m.status !== "inactive");
  if (!meter) {
    meter = await call("POST", "/v1/billing/meters", {
      display_name: "Keymaker agent API calls",
      event_name: eventName,
      "default_aggregation[formula]": "sum",
      "customer_mapping[event_payload_key]": "stripe_customer_id",
      "customer_mapping[type]": "by_id",
      "value_settings[event_payload_key]": "value",
    });
  }
  const product = await call("POST", "/v1/products", { name: "Agent API access (metered)" });
  const price = await call("POST", "/v1/prices", {
    product: product.id,
    currency,
    unit_amount_decimal: String(perCallUsd * 100),
    "recurring[interval]": "month",
    "recurring[usage_type]": "metered",
    "recurring[meter]": meter.id,
  });
  return { meter_id: meter.id, product_id: product.id, price_id: price.id, event_name: eventName };
}

export function createBilling(cfg) {
  if (!cfg || cfg.provider !== "stripe") return null;
  const key = process.env[cfg.secret_key_env ?? "STRIPE_SECRET_KEY"];
  if (!key) return null;
  const base = (cfg.api_base ?? "https://api.stripe.com").replace(/\/$/, "");
  const eventName = cfg.meter_event_name ?? "keymaker_api_call";

  const call = async (path, params) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
    });
    if (!res.ok) throw new Error(`Stripe ${path}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  };

  return {
    async onRegister(record, body = {}) {
      const params = { name: record.client_name, "metadata[key_id]": record.key_id };
      if (body.billing_email) params.email = String(body.billing_email).slice(0, 200);
      const customer = await call("/v1/customers", params);
      return { customer_id: customer.id };
    },
    async onMeter(record) {
      if (!record.billing_customer_id) return;
      await call("/v1/billing/meter_events", {
        event_name: eventName,
        "payload[stripe_customer_id]": record.billing_customer_id,
        "payload[value]": "1",
      });
    },
  };
}
