import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { checkSite } from "../src/doctor.js";

function serve(handler) {
  const s = createServer(handler);
  return new Promise((r) => s.listen(0, () => r(s)));
}

test("detects present surfaces", async (t) => {
  const s = await serve((req, res) => {
    if (req.url === "/llms.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("# My API\n\n- [docs](https://x.dev/docs): things");
    }
    if (req.url === "/.well-known/auth.md") {
      res.writeHead(200, { "content-type": "text/markdown" });
      return res.end("# Agent registration\n\nPOST /agent-auth");
    }
    if (req.url === "/mcp" && req.method === "POST") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "bearer key required" }));
    }
    res.writeHead(404);
    res.end("nope");
  });
  t.after(() => s.close());
  const r = await checkSite(`http://localhost:${s.address().port}`);
  assert.equal(r.llms_txt, true);
  assert.equal(r.auth_md, true);
  assert.equal(r.mcp, true);
});

test("SPA catch-all 200s do not count as surfaces", async (t) => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body>app</body></html>");
  });
  t.after(() => s.close());
  const r = await checkSite(`http://localhost:${s.address().port}`);
  assert.equal(r.llms_txt, false);
  assert.equal(r.auth_md, false);
  assert.equal(r.mcp, false);
});

test("unreachable host reports all missing", async () => {
  const r = await checkSite("http://localhost:1");
  assert.deepEqual([r.llms_txt, r.auth_md, r.mcp], [false, false, false]);
});
