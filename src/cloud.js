import { createServer } from "node:http";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { loadSpec } from "./parse.js";
import { extractOperations } from "./extract.js";
import { toTools } from "./gen-mcp.js";
import { renderLlmsTxt } from "./gen-llms.js";
import { renderAuthMd } from "./gen-authmd.js";
import { scoreSpec } from "./score.js";
import { keymakerGateway } from "./gateway.js";

const TENANT_RE = /^[a-z0-9-]{3,40}$/;

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Provision a tenant directory from an OpenAPI spec: writes the full agent-ready kit. */
export async function provisionTenant(dataRoot, { id, name, specSource, publicUrl }) {
  const dir = join(dataRoot, id);
  const serviceUrl = `${publicUrl.replace(/\/$/, "")}/t/${id}`;
  const spec = await loadSpec(specSource);
  const baseUrl = (spec.servers?.[0]?.url ?? "http://localhost:3000").replace(/\/$/, "");
  const { ops, warnings } = extractOperations(spec);
  if (!ops.length) throw new Error("spec produced no operations");

  await mkdir(join(dir, ".well-known"), { recursive: true });
  const authMd = renderAuthMd({ spec, serviceUrl });
  await writeFile(
    join(dir, "tools.json"),
    JSON.stringify({ title: spec.info?.title ?? name, version: spec.info?.version ?? "0.0.0", baseUrl, tools: toTools(ops) }, null, 2)
  );
  await writeFile(join(dir, "llms.txt"), renderLlmsTxt({ spec, ops, baseUrl, serviceUrl }));
  await writeFile(join(dir, "auth.md"), authMd);
  await writeFile(join(dir, ".well-known", "auth.md"), authMd);

  const adminToken = `adm_${randomBytes(16).toString("hex")}`;
  await writeFile(
    join(dir, "signup.config.json"),
    JSON.stringify(
      {
        dev_accept_any_attestation: true,
        trusted_issuers: [],
        registrations_per_minute_per_ip: 10,
        verifies_per_minute_per_key: 120,
        mcp_requests_per_minute_per_key: 60,
        admin_token: adminToken,
        public_url: serviceUrl,
        storage: { driver: "sqlite" },
      },
      null,
      2
    )
  );

  const score = scoreSpec(spec, ops, warnings);
  return { dir, adminToken, serviceUrl, operations: ops.length, score: score.total, grade: score.grade, title: spec.info?.title ?? name };
}

const PAGE = (body) => `<!doctype html><html><head><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Keymaker Cloud</title><style>
:root{--ink:#211E16;--bg:#FBFAF7;--brass:#8A6D1F;--line:#E2DCCC;--panel:#F2EFE7}
@media(prefers-color-scheme:dark){:root{--ink:#EAE4D4;--bg:#161309;--brass:#D9B44A;--line:#35301F;--panel:#201C10}}
*{box-sizing:border-box}body{background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0}
.wrap{max-width:760px;margin:0 auto;padding:3rem 1.25rem 5rem}h1{font:700 1.8rem/1.2 ui-monospace,Menlo,monospace;margin:0 0 .5rem}
h1 .k{color:var(--brass)}p.sub{color:var(--brass);margin:0 0 2rem;font:600 .8rem ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:1.4rem;margin:1rem 0}
input,button{font:15px ui-monospace,Menlo,monospace;padding:.6rem .8rem;border-radius:6px;border:1px solid var(--line)}
input{width:100%;background:var(--bg);color:var(--ink);margin:.35rem 0}button{background:var(--brass);color:var(--bg);border:none;font-weight:700;cursor:pointer;margin-top:.5rem}
label{font-size:.85rem;color:var(--ink);opacity:.8}code,pre{font:13px ui-monospace,Menlo,monospace;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:.1em .4em}
pre{padding:1rem;overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.85rem}th{text-align:left;color:var(--brass);border-bottom:2px solid var(--brass);padding:.4rem .5rem .3rem 0;font:600 .72rem ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase}
td{border-bottom:1px solid var(--line);padding:.5rem .5rem;font-variant-numeric:tabular-nums}a{color:var(--brass)}
</style></head><body><div class="wrap">${body}</div></body></html>`;

function landing(publicUrl) {
  return PAGE(`<h1><span class="k">key</span>maker cloud</h1><p class="sub">hosted agent onboarding · beta</p>
<p>Turn any API into one an AI agent can discover, sign up for, and use — hosted, no infra to run. Give it your OpenAPI spec URL and get a live agent-signup endpoint plus a hosted MCP server.</p>
<div class="card"><form method="POST" action="/v1/tenants" onsubmit="event.preventDefault();create(this)">
<label>Product name</label><input name="name" placeholder="Acme API" required>
<label>OpenAPI spec URL</label><input name="spec_url" placeholder="https://api.acme.com/openapi.json" required>
<button type="submit">Provision →</button></form><div id="out"></div></div>
<p style="opacity:.7;font-size:.85rem">Open source core: <a href="https://github.com/adityaaa-IIT-BHU/keymaker">github.com/adityaaa-IIT-BHU/keymaker</a> · <code>npx keymaker-cli</code></p>
<script>
async function create(f){const out=document.getElementById('out');out.innerHTML='Provisioning…';
const r=await fetch('/v1/tenants',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:f.name.value,spec_url:f.spec_url.value})});
const j=await r.json();if(!r.ok){out.innerHTML='<pre>'+(j.error||'error')+'</pre>';return;}
out.innerHTML='<pre>✔ '+j.title+' — '+j.operations+' operations, agent-readiness '+j.score+'/100 ('+j.grade+')\\n\\n'+
'Agent signup:  '+j.urls.agent_auth+'\\nHosted MCP:    '+j.urls.mcp+'\\nauth.md:       '+j.urls.auth_md+'\\nDashboard:     '+j.urls.dashboard+'\\n\\n'+
'ADMIN TOKEN (shown once — save it):\\n'+j.admin_token+'</pre>';}
</script>`);
}

async function dashboard(dir, id, publicUrl) {
  let cfg = {};
  try { cfg = JSON.parse(await readFile(join(dir, "signup.config.json"), "utf8")); } catch {}
  const { readKeys } = await import("./store.js");
  const keys = Object.values(await readKeys(dir)).filter((k) => k.type !== "oauth_client");
  const now = Date.now();
  const rows = keys.length
    ? keys.map((k) => {
        const state = k.revoked ? "revoked" : k.expires_at && Date.parse(k.expires_at) < now ? "expired" : k.status;
        return `<tr><td><code>${k.key_id}</code></td><td>${k.client_name}</td><td>${state}</td><td>${k.scopes.join(",")}</td><td>${k.usage}</td></tr>`;
      }).join("")
    : `<tr><td colspan="5" style="opacity:.6">No agents have signed up yet.</td></tr>`;
  const totalCalls = keys.reduce((n, k) => n + (k.usage ?? 0), 0);
  return PAGE(`<h1><span class="k">${id}</span> dashboard</h1><p class="sub">${keys.length} agents · ${totalCalls} metered calls</p>
<div class="card"><table><tr><th>key id</th><th>agent</th><th>state</th><th>scopes</th><th>calls</th></tr>${rows}</table></div>
<p style="font-size:.85rem;opacity:.8">Signup endpoint: <code>${publicUrl}/t/${id}/agent-auth</code> · MCP: <code>${publicUrl}/t/${id}/mcp</code></p>`);
}

/** Start the multi-tenant hosted platform. */
export async function startCloud({ dataRoot = "data", port = 8080, publicUrl } = {}) {
  await mkdir(dataRoot, { recursive: true });
  publicUrl = (publicUrl ?? process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const gateways = new Map(); // id -> gateway handler

  const gatewayFor = async (id) => {
    if (gateways.has(id)) return gateways.get(id);
    const g = await keymakerGateway({ dir: join(dataRoot, id), mountBase: `/t/${id}` });
    gateways.set(id, g);
    return g;
  };
  const tenantExists = async (id) => {
    try {
      await readFile(join(dataRoot, id, "tools.json"), "utf8");
      return true;
    } catch {
      return false;
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(type === "application/json" ? JSON.stringify(body, null, 2) : body);
    };
    try {
      if (req.method === "GET" && url.pathname === "/") return send(200, landing(publicUrl), "text/html");
      if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true });

      if (req.method === "POST" && url.pathname === "/v1/tenants") {
        const body = await readJson(req);
        if (!body.name || !body.spec_url) return send(400, { error: "name and spec_url required" });
        let id = slug(body.name);
        if (!TENANT_RE.test(id)) return send(400, { error: "name must yield a 3-40 char [a-z0-9-] slug" });
        if (await tenantExists(id)) id = `${id}-${randomBytes(2).toString("hex")}`;
        let t;
        try {
          t = await provisionTenant(dataRoot, { id, name: body.name, specSource: body.spec_url, publicUrl });
        } catch (err) {
          return send(422, { error: `could not provision: ${err.message}` });
        }
        return send(201, {
          tenant_id: id,
          title: t.title,
          operations: t.operations,
          score: t.score,
          grade: t.grade,
          admin_token: t.adminToken,
          urls: {
            agent_auth: `${publicUrl}/t/${id}/agent-auth`,
            mcp: `${publicUrl}/t/${id}/mcp`,
            auth_md: `${publicUrl}/t/${id}/auth.md`,
            llms_txt: `${publicUrl}/t/${id}/llms.txt`,
            dashboard: `${publicUrl}/t/${id}/dashboard`,
          },
        });
      }

      const m = url.pathname.match(/^\/t\/([a-z0-9-]+)(\/.*)?$/);
      if (m) {
        const id = m[1];
        const rest = m[2] || "/";
        if (!(await tenantExists(id))) return send(404, { error: "unknown tenant" });

        if (req.method === "GET" && rest === "/dashboard") {
          const dir = join(dataRoot, id);
          let cfg = {};
          try { cfg = JSON.parse(await readFile(join(dir, "signup.config.json"), "utf8")); } catch {}
          const token = url.searchParams.get("admin_token") ?? req.headers["x-admin-token"];
          if (!cfg.admin_token || !safeEqual(token, cfg.admin_token)) {
            return send(401, `${PAGE("<h1>Dashboard</h1><p>Add <code>?admin_token=…</code> (the token shown when you provisioned this tenant).</p>")}`, "text/html");
          }
          return send(200, await dashboard(dir, id, publicUrl), "text/html");
        }

        // Delegate everything else to the per-tenant gateway.
        req.url = rest + url.search;
        const gateway = await gatewayFor(id);
        if (await gateway(req, res)) return;
        return send(404, { error: "not found on tenant", hint: `${publicUrl}/t/${id}/auth.md` });
      }

      send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: String(err?.message ?? err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, resolve);
  });
  return server;
}
