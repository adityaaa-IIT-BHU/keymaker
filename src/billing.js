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
