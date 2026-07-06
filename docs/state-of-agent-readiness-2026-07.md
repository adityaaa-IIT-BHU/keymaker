# State of Agent Readiness — July 2026

*63 well-known API companies, probed 2026-07-06 with `keymaker doctor` (this repo). Reproduce: `npx keymaker-cli doctor <hosts...>`. Raw data: [agent-readiness-scan-2026-07-06.json](agent-readiness-scan-2026-07-06.json).*

## Headline

| Surface | Present | Share |
|---|---|---|
| `llms.txt` (agent-readable docs) | 45 / 63 | **71%** |
| `auth.md` (agent self-signup) | 5 / 63 | **8%** |
| `/mcp` on the primary domain | 13 / 63 | 21% |
| **All three (fully agent-ready)** | **1 / 63** | **1.6%** |
| None (invisible to agents) | 14 / 63 | 22% |

**The docs layer is basically won — the signup layer barely exists.** 71% of top API companies now publish llms.txt, but only five (Resend, Supabase, WorkOS, Monday.com, Firecrawl) let an agent register itself via auth.md, and exactly one — **Supabase** — has all three surfaces. An agent can *read about* most of these products; it can *become a customer* of almost none of them.

## Method

For each host we probe five paths on the primary domain: `GET /llms.txt`, `GET /llms-full.txt`, `GET /auth.md`, `GET /.well-known/auth.md`, and `POST /mcp` with a JSON-RPC `initialize`. A surface counts as present only if the response looks real — SPA catch-alls that return 200 HTML for every path count as absent, and `/mcp` counts only on JSON-RPC-shaped or auth-challenge responses, never marketing pages.

## Caveats

- **Primary domain only.** Several companies host MCP servers on other subdomains (e.g. `mcp.stripe.com`) or ship them as npm packages/CLIs — those don't show up here. This scan measures *discoverability at the canonical domain*, which is what an agent tries first.
- llms.txt often lives on docs subdomains we didn't probe for every company, so the 71% is a floor, not a ceiling — which makes the auth.md gap starker, not weaker.
- Point-in-time snapshot (2026-07-06). This space moves weekly; PRs updating the table are welcome.

## Full results

| Host | llms.txt | auth.md | /mcp |
|---|---|---|---|
| supabase.com | ✓ | ✓ | ✓ |
| firecrawl.dev | ✓ | ✓ | ✗ |
| monday.com | ✓ | ✓ | ✗ |
| pinecone.io | ✓ | ✗ | ✓ |
| planetscale.com | ✓ | ✗ | ✓ |
| posthog.com | ✓ | ✗ | ✓ |
| railway.app | ✓ | ✗ | ✓ |
| redis.io | ✓ | ✗ | ✓ |
| render.com | ✓ | ✗ | ✓ |
| replicate.com | ✓ | ✗ | ✓ |
| resend.com | ✓ | ✓ | ✗ |
| slack.com | ✓ | ✗ | ✓ |
| workos.com | ✓ | ✓ | ✗ |
| algolia.com | ✓ | ✗ | ✗ |
| assemblyai.com | ✓ | ✗ | ✗ |
| auth0.com | ✓ | ✗ | ✗ |
| buttondown.com | ✓ | ✗ | ✗ |
| clerk.com | ✓ | ✗ | ✗ |
| cloudflare.com | ✓ | ✗ | ✗ |
| coinbase.com | ✓ | ✗ | ✗ |
| datadoghq.com | ✓ | ✗ | ✗ |
| elevenlabs.io | ✓ | ✗ | ✗ |
| fly.io | ✓ | ✗ | ✗ |
| geocod.io | ✓ | ✗ | ✗ |
| github.com | ✓ | ✗ | ✗ |
| groq.com | ✗ | ✗ | ✓ |
| huggingface.co | ✗ | ✗ | ✓ |
| linear.app | ✓ | ✗ | ✗ |
| meilisearch.com | ✓ | ✗ | ✗ |
| mintlify.com | ✗ | ✗ | ✓ |
| mistral.ai | ✓ | ✗ | ✗ |
| modal.com | ✓ | ✗ | ✗ |
| mongodb.com | ✓ | ✗ | ✗ |
| neon.tech | ✓ | ✗ | ✗ |
| netlify.com | ✓ | ✗ | ✗ |
| notion.so | ✓ | ✗ | ✗ |
| paypal.com | ✓ | ✗ | ✗ |
| plaid.com | ✓ | ✗ | ✗ |
| postmarkapp.com | ✓ | ✗ | ✗ |
| qdrant.tech | ✓ | ✗ | ✗ |
| screenshotone.com | ✗ | ✗ | ✓ |
| sentry.io | ✓ | ✗ | ✗ |
| shopify.com | ✓ | ✗ | ✗ |
| squareup.com | ✓ | ✗ | ✗ |
| stripe.com | ✓ | ✗ | ✗ |
| together.ai | ✓ | ✗ | ✗ |
| vercel.com | ✓ | ✗ | ✗ |
| weaviate.io | ✓ | ✗ | ✗ |
| zuplo.com | ✓ | ✗ | ✗ |
| airtable.com | ✗ | ✗ | ✗ |
| anthropic.com | ✗ | ✗ | ✗ |
| apitemplate.io | ✗ | ✗ | ✗ |
| deepgram.com | ✗ | ✗ | ✗ |
| discord.com | ✗ | ✗ | ✗ |
| documenso.com | ✗ | ✗ | ✗ |
| gitlab.com | ✗ | ✗ | ✗ |
| launchdarkly.com | ✗ | ✗ | ✗ |
| mailgun.com | ✗ | ✗ | ✗ |
| openai.com | ✗ | ✗ | ✗ |
| peekalink.io | ✗ | ✗ | ✗ |
| segment.com | ✗ | ✗ | ✗ |
| sendgrid.com | ✗ | ✗ | ✗ |
| twilio.com | ✗ | ✗ | ✗ |

---

*Generated with [Keymaker](https://github.com/adityaaa-IIT-BHU/keymaker) — one command turns any OpenAPI spec into all three surfaces.*
