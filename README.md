


# Keymaker

**Make your API agent-ready in an afternoon.**



https://github.com/user-attachments/assets/a8e5b189-dbaa-45dc-81b4-af4f2b72c85b



Point Keymaker at your OpenAPI spec. It emits everything an AI agent needs to discover, sign up for, and use your product — with zero humans in the loop:

- **`mcp-server.mjs`** — a runnable MCP server exposing every endpoint as a tool (stdio; works with Claude, Cursor, any MCP client)
- **`llms.txt`** — agent-readable API overview, served the way agents actually browse
- **`auth.md`** + **`.well-known/auth.md`** — machine-readable signup instructions ([auth.md](https://workos.com/auth-md)-pattern-compatible)
- **an agent-signup server** — agents `POST /agent-auth` and get a scoped API key back in one round trip; your backend verifies keys and meters usage with one call

Plus a **curation report**: every endpoint or parameter with missing/weak documentation gets flagged — because agents choose tools by documentation quality, and auto-generated tools from an undocumented spec perform measurably worse.

## Quickstart

```bash
npx keymaker-cli generate https://your.api/openapi.json -o agent-ready
npx keymaker-cli serve agent-ready       # agent signup + hosted /mcp on :8787
```

Or from a clone:

```bash
npm install
node src/cli.js generate examples/todo-api.yaml -o out/todo
node src/cli.js serve out/todo          # agent signup on :8787
node out/todo/mcp-server.mjs            # MCP server (stdio)
```

An agent signs itself up:

```bash
curl -s -X POST localhost:8787/agent-auth \
  -d '{"client_name":"my-agent","scopes":["read","write"]}'
# → { "api_key": "ak_…", "status": "unclaimed", "expires_at": "<60 min>", "claim_token": "ct_…" }
```

No attestation → the key is **temporary (60 min)** — enough for the agent to try your API — and becomes permanent when a human claims it (the [Cloudflare Temporary Accounts](https://blog.cloudflare.com/temporary-accounts/) pattern). With a platform attestation (ID-JAG) → issued as `agent_verified`, no expiry. Your backend checks keys and meters usage:

```bash
curl -s -X POST localhost:8787/agent-auth/verify -d '{"api_key":"ak_…"}'
# → { "valid": true, "scopes": ["read","write"], "usage": 1 }
```

## Mount it inside your app (one process, one port)

You don't need a second service. Mount the gateway in your existing app:

```js
import { keymakerGateway, keymakerAuth } from "keymaker-cli";

const gateway = await keymakerGateway({ dir: "./agent-ready" });
const auth = keymakerAuth({ dir: "./agent-ready" });

// plain node:http
createServer(async (req, res) => {
  if (await gateway(req, res)) return;   // /llms.txt /auth.md /agent-auth* /mcp
  if (!(await auth(req, res))) return;   // everything else needs an agent key
  // …your routes, with req.agent populated
});

// express
app.use(gateway.express());
app.use(auth);
```

`node examples/single-process.mjs` shows the whole thing on one port.

## Agents as paying customers (Stripe)

Add to `signup.config.json` and set `STRIPE_SECRET_KEY`:

```json
"billing": { "provider": "stripe", "meter_event_name": "keymaker_api_call" }
```

Registration creates a Stripe customer for the agent (pass `billing_email` at signup — agents have inboxes now); every metered request emits a [Billing Meter event](https://docs.stripe.com/billing/subscriptions/usage-based). Attach a metered price and usage becomes invoices. Billing is optional and off by default — without config, nothing changes.

## One origin, whole loop: hosted `/mcp`

`keymaker serve` doesn't just issue keys — it hosts the tools too. An agent needs exactly one URL:

```
GET  /llms.txt      → discovers your API
GET  /auth.md       → learns how to register
POST /agent-auth    → gets a scoped key
POST /mcp           → calls your API's tools (Streamable HTTP, Bearer-gated)
```

No stdio, no local install. Tool visibility is scope-filtered — a `read`-scoped key doesn't even *see* write tools in `tools/list`. Every successful call is metered onto the key. Revoke instantly:

```bash
curl -X POST localhost:8787/agent-auth/revoke \
  -H "x-admin-token: <from signup.config.json>" -d '{"key_id":"key_…"}'
```

(The generated `mcp-server.mjs` still works for stdio/local MCP clients like Claude Desktop.)

## Check any live site: `keymaker doctor`

```bash
npx keymaker-cli doctor stripe.com yourapi.com
# stripe.com: 1/3 agent surfaces   llms.txt ✓   auth.md ✗   /mcp ✗
```

We ran it across 63 top API companies: **71% have llms.txt, 8% have agent signup, exactly one has all three.** Full data: [State of Agent Readiness, July 2026](docs/state-of-agent-readiness-2026-07.md).

## Fix your docs automatically: `keymaker improve`

```bash
export ANTHROPIC_API_KEY=sk-ant-…
npx keymaker-cli improve openapi.yaml
# Drafting docs for 1 operation(s) and 2 parameter(s) with claude-opus-4-8…
# ✔ Applied 3 drafted description(s) → openapi.improved.yaml
# Agent-readiness: 80/100 → 100/100 (A)
```

`score` tells you what's missing; `improve` drafts it — every undocumented operation and parameter gets a description generated by Claude (structured outputs, so it can't return malformed data), applied only where fields are empty, written to a new file for your review. Detect → draft → re-grade, one loop. Requires an [Anthropic API key](https://platform.claude.com/).

## Score your API (Lighthouse, for agents)

```bash
node src/cli.js score https://petstore3.swagger.io/api/v3/openapi.json
# Agent-readiness: 84/100  grade B
#   ██████████  40/40  Operation docs
#   ░░░░░░░░░░   0/10  Absolute base URL  → servers[0].url should be an absolute https URL
#   …
```

Six checks, weighted by what actually drives agent tool-selection: operation docs, parameter docs, API description, absolute base URL, documented auth, tagging. Fun fact: the official Swagger Petstore scores a B — its base URL is relative, so an agent literally can't call it.

## Protect your API (drop-in middleware)

```js
import { keymakerAuth } from "keymaker-cli";

const auth = keymakerAuth({ dir: "./agent-ready", rateLimitPerMinute: 60 });
app.use(auth);                    // Express
// or in plain node:http — if (!(await auth(req, res))) return;
// req.agent = { key_id, client_name, scopes, status }
```

Checks the Bearer key, enforces scopes (`read` for GET, `write` for mutations), rate-limits per key, meters usage.

## Real attestation verification

`signup.config.json` (generated next to your artifacts) controls how `agent_verified` keys are issued:

```json
{
  "trusted_issuers": [{ "issuer": "https://agents.example.com", "jwks_url": "https://agents.example.com/.well-known/jwks.json" }],
  "audience": "https://api.yourproduct.com",
  "registrations_per_minute_per_ip": 10
}
```

Attestations are verified as JWTs (RS256/ES256/EdDSA) against the issuer's JWKS — signature, expiry, issuer, and audience checks. The generated default is dev-mode (`dev_accept_any_attestation: true`) so the demo works out of the box; a rejected attestation still issues a 60-minute temporary key, with the rejection reason in the response.

## Why now

- Agents are becoming the first consumer of APIs, and they pick tools by machine-readability. On YC's Lightcone podcast (Feb 2026), Garry Tan described Claude Code choosing the practically-deprecated Whisper V1 over Groq — 200× faster, 10× cheaper — for his transcription pipeline; his co-host pinned the cause: Groq's docs are hard to parse, Whisper's have far more examples.
- YC's Summer 2026 RFS calls for exactly this: agents need to "discover, sign up for, and instantly start using new tools programmatically, without needing a human in the loop."
- The signup protocol layer just standardized (WorkOS's auth.md, May 2026 — adopted by Cloudflare, Firecrawl, Resend, Monday.com). But implementing it — endpoints, attestation verification, key issuance, metering — is still work every vendor does by hand. **Keymaker is the retrofit layer: one command from OpenAPI spec to fully agent-ready.**

## Security posture

- **Keys are hashed at rest** (SHA-256) — `keys.json` stores hash + display prefix; the full key is shown exactly once, at registration. Lookups are timing-safe.
- **Admin token comparison is timing-safe**; key writes are serialized and land atomically (tmp + rename).
- **Rate limits by default**: 10 registrations/min/IP, 120 verifies/min/key, 60 API requests/min/key — all configurable.
- Attestations are verified as signed JWTs against the issuer's JWKS (see above); dev-mode acceptance is explicit, config-gated, and off unless you say otherwise.

Scale note: real-world specs are fine — GitHub's 12.6MB / 1,194-operation spec generates in ~0.3s (you'll get a tool-explosion warning telling you to curate with `--include`, because a 1,194-tool MCP server is how you get [the Whisper problem](#why-now)).

## Status & roadmap

v0.1 — working generator, signup server, JWT attestation verification, scope-enforcing middleware, per-key/per-IP rate limits, agent-readiness scoring. 12 passing tests (`npm test`). Roadmap:

- [x] SQLite storage — `"storage": {"driver": "sqlite"}` in signup.config.json swaps keys.json for keys.db via Node's built-in node:sqlite (zero new dependencies, Node 22.13+)
- [x] Hosted `/mcp` endpoint — one origin serves discovery, signup, and tools
- [x] Mountable gateway — run everything inside your existing app, one process
- [x] Stripe metered billing per key (agents as paying customers) — `keymaker billing-init` sets up the meter + price
- [x] Key revocation API
- [x] CI gate: `keymaker score --json --min 80`
- [x] OAuth 2.1 for MCP clients — RFC 9728/8414/7591 discovery + client_credentials, so Claude Desktop/Cursor connect without pasting keys
- [x] **Managed hosting** — `keymaker cloud` runs the multi-tenant platform: vendors provision from a spec URL and get live per-tenant agent endpoints, dashboards, and OAuth. See [docs/HOSTING.md](docs/HOSTING.md)
- [ ] Automated vendor billing on the hosted platform
- [ ] x402 fallback for account-less micropayment access
- [ ] Registry submission: publish generated MCP servers to agent tool registries

MIT. Built with the [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk).

---

Built by [Aditya Acharya](https://github.com/adityaaa-IIT-BHU) ([LinkedIn](https://www.linkedin.com/in/aditya-acharya-50a85a1b1/)). MIT. Issues and PRs welcome — especially corrections to the [scan data](docs/state-of-agent-readiness-2026-07.md).
