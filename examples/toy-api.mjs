#!/usr/bin/env node
// Minimal task API protected by keymaker middleware — used by the demo video.
// Usage: node examples/toy-api.mjs <generated-dir> [port]
import { createServer } from "node:http";
import { keymakerAuth } from "../src/index.js";

const dir = process.argv[2] ?? "out/video";
const port = Number(process.argv[3] ?? 3456);
const auth = keymakerAuth({ dir });
const tasks = [];

createServer(async (req, res) => {
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
  return send(404, { error: "not found" });
}).listen(port, () => console.log(`toy api on :${port}`));
