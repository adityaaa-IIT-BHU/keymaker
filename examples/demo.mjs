#!/usr/bin/env node
// The zero-human loop, end to end:
//   1. A vendor API (Todozilla) protected by keymaker middleware
//   2. keymaker generate → MCP server + llms.txt + auth.md
//   3. An "agent" discovers the API via llms.txt, registers via /agent-auth,
//      and uses the API through the generated MCP server. No human anywhere.
// Run: node examples/demo.mjs
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import { keymakerAuth, startSignupServer } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out", "demo");
const API_PORT = 3456;
const SIGNUP_PORT = 8791;
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

await rm(outDir, { recursive: true, force: true });

step(1, "Vendor generates their agent-ready kit (one command)");
execFileSync(
  "node",
  [
    join(root, "src", "cli.js"),
    "generate",
    join(root, "examples", "todo-api.yaml"),
    "-o", outDir,
    "--base-url", `http://localhost:${API_PORT}/v1`,
    "--service-url", `http://localhost:${SIGNUP_PORT}`,
  ],
  { stdio: "inherit" }
);

step(2, `Vendor's API starts on :${API_PORT}, protected by keymaker middleware`);
const tasks = [];
const auth = keymakerAuth({ dir: outDir });
const api = createServer(async (req, res) => {
  if (!(await auth(req, res))) return;
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
  const m = url.pathname.match(/^\/v1\/tasks\/(.+)$/);
  if (m && req.method === "GET") {
    const t = tasks.find((t) => t.id === m[1]);
    return t ? send(200, t) : send(404, { error: "no such task" });
  }
  return send(404, { error: "not found" });
});
await new Promise((r) => api.listen(API_PORT, r));

step(3, `Agent-signup endpoint starts on :${SIGNUP_PORT}`);
const signup = await startSignupServer({ dir: outDir, port: SIGNUP_PORT });

step(4, "AGENT: discovers the API by reading llms.txt");
const llms = await (await fetch(`http://localhost:${SIGNUP_PORT}/llms.txt`)).text();
console.log(llms.split("\n").slice(0, 4).join("\n"));
const signupLine = llms.split("\n").find((l) => l.includes("/agent-auth"));
console.log(`  → found signup instructions: "${signupLine.trim().slice(0, 90)}…"`);

step(5, "AGENT: signs itself up — no human in the loop");
const reg = await (
  await fetch(`http://localhost:${SIGNUP_PORT}/agent-auth`, {
    method: "POST",
    body: JSON.stringify({ client_name: "demo-agent", scopes: ["read", "write"] }),
  })
).json();
console.log(`  → got ${reg.status} key ${reg.api_key.slice(0, 12)}… (expires ${reg.expires_at})`);

step(6, "AGENT: connects to the generated MCP server and calls tools");
const mcp = spawn("node", [join(outDir, "mcp-server.mjs")], {
  cwd: root,
  env: { ...process.env, API_KEY: reg.api_key, API_BASE_URL: `http://localhost:${API_PORT}/v1` },
  stdio: ["pipe", "pipe", "ignore"],
});
const pending = new Map();
let buf = "";
mcp.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
  }
});
let nextId = 0;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "demo-agent", version: "0" },
});
mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const created = await rpc("tools/call", {
  name: "createTask",
  arguments: { title: "Ship the keymaker demo", due: "2026-07-27" },
});
console.log(`  → createTask: ${created.result.content[0].text.split("\n")[0]}`);
const listed = await rpc("tools/call", { name: "listTasks", arguments: {} });
console.log(`  → listTasks:  ${listed.result.content[0].text.split("\n").slice(1).join(" ")}`);

step("6b", "AGENT: same tools over plain HTTP — no install, single origin");
const httpCall = await (
  await fetch(`http://localhost:${SIGNUP_PORT}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${reg.api_key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "listTasks", arguments: {} } }),
  })
).json();
console.log(`  → POST /mcp listTasks: ${httpCall.result.content[0].text.split("\n").slice(1).join(" ")}`);

step(7, "VENDOR: sees the metered, scoped key on their side");
const issued = await (await fetch(`http://localhost:${SIGNUP_PORT}/agent-auth/keys`)).json();
const k = issued.find((k) => k.client_name === "demo-agent");
console.log(`  → ${k.client_name}: status=${k.status} scopes=${k.scopes.join(",")} usage=${k.usage} requests`);

console.log(
  "\n✔ Full loop: discover → sign up → get scoped key → call API via MCP → metered usage. Zero humans.\n"
);
mcp.kill();
signup.close();
api.close();
process.exit(0);
