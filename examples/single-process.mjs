#!/usr/bin/env node
// One process, one port: your API with the keymaker gateway mounted inside it.
// Agents get discovery (/llms.txt), signup (/agent-auth), and tools (/mcp)
// on the SAME origin as your API. Run: node examples/single-process.mjs
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import { keymakerGateway, keymakerAuth } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out", "single");
const PORT = 4567;

await rm(outDir, { recursive: true, force: true });
execFileSync("node", [
  join(root, "src", "cli.js"), "generate", join(root, "examples", "todo-api.yaml"),
  "-o", outDir,
  "--base-url", `http://localhost:${PORT}/v1`,
  "--service-url", `http://localhost:${PORT}`,
], { stdio: "ignore" });

const gateway = await keymakerGateway({ dir: outDir });
const auth = keymakerAuth({ dir: outDir });
const tasks = [];

const app = createServer(async (req, res) => {
  if (await gateway(req, res)) return; // /llms.txt /auth.md /agent-auth* /mcp
  if (!(await auth(req, res))) return; // everything else needs an agent key
  const url = new URL(req.url, "http://localhost");
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url.pathname === "/v1/tasks") return send(200, tasks);
  if (req.method === "POST" && url.pathname === "/v1/tasks") {
    let data = "";
    for await (const c of req) data += c;
    const t = { id: String(tasks.length + 1), ...JSON.parse(data || "{}"), status: "open" };
    tasks.push(t);
    return send(201, t);
  }
  return send(404, { error: "not found" });
});
await new Promise((r) => app.listen(PORT, r));
console.log(`Todozilla + keymaker gateway on http://localhost:${PORT} — one process\n`);

// An agent does the whole loop against the single origin:
const reg = await (
  await fetch(`http://localhost:${PORT}/agent-auth`, {
    method: "POST",
    body: JSON.stringify({ client_name: "single-origin-agent", scopes: ["read", "write"] }),
  })
).json();
console.log(`agent registered: ${reg.key_id} (${reg.status})`);

const call = await (
  await fetch(`http://localhost:${PORT}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${reg.api_key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "createTask", arguments: { title: "One origin to rule them all" } },
    }),
  })
).json();
console.log(`tools/call createTask → ${call.result.content[0].text.split("\n")[0]}`);

const keys = await (await fetch(`http://localhost:${PORT}/agent-auth/keys`)).json();
console.log(`vendor sees: usage=${keys[0].usage}\n✔ discovery, signup, tools, and the API itself — one port.`);
app.close();
process.exit(0);
