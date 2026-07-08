# Keymaker Cloud — the hosted platform

The CLI makes *one* API agent-ready on your machine. **Keymaker Cloud** runs the same gateway multi-tenant: any number of vendors provision from a spec URL and get live, hosted agent-signup + MCP endpoints they never have to operate.

## What a vendor gets

`POST /v1/tenants` with `{name, spec_url}` provisions a tenant in seconds and returns:

```
POST https://cloud.example/t/<id>/agent-auth     agents register, get scoped keys
POST https://cloud.example/t/<id>/mcp            hosted MCP server (Bearer or OAuth)
GET  https://cloud.example/t/<id>/auth.md         machine-readable signup instructions
GET  https://cloud.example/t/<id>/llms.txt        agent-readable API overview
GET  https://cloud.example/t/<id>/dashboard       keys + usage (admin-token gated)
```

Each tenant is isolated: its own SQLite key store, its own admin token, its own rate limits. The whole tested gateway (hashed keys, scopes, revocation, metering, Stripe hooks) runs per tenant.

## MCP clients connect over OAuth

Every tenant exposes OAuth 2.1 discovery so Claude Desktop / Cursor connect without a human pasting a key:

```
GET  /t/<id>/.well-known/oauth-protected-resource   RFC 9728
GET  /t/<id>/.well-known/oauth-authorization-server  RFC 8414
POST /t/<id>/register                                RFC 7591 dynamic client registration
POST /t/<id>/token                                   client_credentials → a scoped access token
```

An unauthenticated `POST /t/<id>/mcp` returns `401` with a `WWW-Authenticate: Bearer resource_metadata="…"` header, which is how an OAuth-capable MCP client discovers all of the above and self-onboards.

## Run it locally

```bash
npx keymaker-cli cloud --port 8080
# open http://localhost:8080 and provision from the form, or:
curl -X POST localhost:8080/v1/tenants -H 'content-type: application/json' \
  -d '{"name":"Acme","spec_url":"https://api.acme.com/openapi.json"}'
```

## Deploy (free tier)

**Fly.io:**
```bash
fly launch --no-deploy
fly volumes create keymaker_data --size 1
fly deploy
fly secrets set PUBLIC_URL=https://<your-app>.fly.dev
```

**Render:** push the repo, New → Blueprint, select `render.yaml`, then set `PUBLIC_URL` to the assigned `onrender.com` URL.

`PUBLIC_URL` matters: it's the origin baked into every provisioned tenant's URLs and OAuth documents. Set it once to your real host.

## Status

Beta. Data is SQLite on a mounted volume (single node). The billing hooks are wired (`billing-init` + per-request meter events) but charging vendors is not yet automated — that's the next milestone. No auth on tenant creation yet; put it behind an invite before opening it publicly.
