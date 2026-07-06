import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { collectGaps, draftDescriptions, applyDescriptions } from "../src/improve.js";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "T" },
  paths: {
    "/tasks/{taskId}": {
      parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: "getTask", summary: "Get one task" },
      delete: { operationId: "deleteTask" },
    },
  },
};

test("collectGaps finds undocumented operations and parameters", () => {
  const gaps = collectGaps(SPEC);
  assert.deepEqual(gaps.operations.map((o) => o.name), ["deleteTask"]);
  assert.equal(gaps.parameters.length, 1);
  assert.equal(gaps.parameters[0].operation, "PATH /tasks/{taskId}");
  assert.equal(gaps.parameters[0].name, "taskId");
});

test("draft + apply via mocked Claude API", async (t) => {
  // Mock the Messages API: echo back a draft for every gap it was sent
  const mock = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const payload = JSON.parse(JSON.parse(body).messages[0].content);
    const draft = {
      operations: payload.operations.map((o) => ({
        name: o.name,
        summary: `Do ${o.name}`,
        description: `Performs ${o.name} on ${o.path}.`,
      })),
      parameters: payload.parameters.map((p) => ({
        operation: p.operation,
        name: p.name,
        description: `The ${p.name}`,
      })),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "mock",
        content: [{ type: "text", text: JSON.stringify(draft) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    );
  });
  await new Promise((r) => mock.listen(0, r));
  t.after(() => mock.close());

  const client = new Anthropic({
    apiKey: "test-key",
    baseURL: `http://localhost:${mock.address().port}`,
  });

  const spec = structuredClone(SPEC);
  const gaps = collectGaps(spec);
  const drafts = await draftDescriptions(gaps, { client });
  const applied = applyDescriptions(spec, drafts);

  assert.equal(applied, 2);
  assert.equal(spec.paths["/tasks/{taskId}"].delete.summary, "Do deleteTask");
  assert.match(spec.paths["/tasks/{taskId}"].delete.description, /deleteTask/);
  assert.equal(spec.paths["/tasks/{taskId}"].parameters[0].description, "The taskId");
  // already-documented fields untouched
  assert.equal(spec.paths["/tasks/{taskId}"].get.summary, "Get one task");
});
