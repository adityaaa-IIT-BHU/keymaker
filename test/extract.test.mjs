import test from "node:test";
import assert from "node:assert/strict";
import { extractOperations } from "../src/extract.js";

const spec = {
  openapi: "3.0.0",
  info: { title: "T" },
  paths: {
    "/things/{id}": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Thing id" },
      ],
      get: { operationId: "getThing", summary: "Get a thing", tags: ["Things"] },
      post: {
        operationId: "updateThing",
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
            },
          },
        },
      },
    },
  },
};

test("flattens body, inherits shared path params, tracks locations", () => {
  const { ops, warnings } = extractOperations(spec);
  assert.equal(ops.length, 2);
  const post = ops.find((o) => o.name === "updateThing");
  assert.deepEqual([...post.inputSchema.required].sort(), ["id", "name"]);
  assert.equal(post.paramLocs.name, "body");
  assert.equal(post.paramLocs.id, "path");
  assert.ok(warnings.some((w) => w.includes("updateThing: no summary")));
});

test("include/exclude filters by name", () => {
  assert.equal(extractOperations(spec, { include: ["getThing"] }).ops.length, 1);
  assert.equal(extractOperations(spec, { exclude: ["update"] }).ops.length, 1);
});

test("resolves $refs in operation schemas", () => {
  const refSpec = {
    openapi: "3.0.0",
    info: {},
    components: {
      schemas: { Pet: { type: "object", properties: { nick: { type: "string" } } } },
    },
    paths: {
      "/pets": {
        post: {
          operationId: "addPet",
          summary: "Add pet",
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
        },
      },
    },
  };
  const { ops } = extractOperations(refSpec);
  assert.equal(ops[0].inputSchema.properties.nick.type, "string");
});
