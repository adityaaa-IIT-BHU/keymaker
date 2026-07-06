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

test("handles Swagger 2.0 body and formData parameters", () => {
  const v2 = {
    swagger: "2.0",
    info: { title: "old" },
    paths: {
      "/pets": {
        post: {
          operationId: "makePet",
          summary: "Make pet",
          parameters: [
            {
              name: "payload",
              in: "body",
              required: true,
              schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, age: { type: "integer" } } },
            },
          ],
        },
      },
      "/upload": {
        post: {
          operationId: "upload",
          summary: "Upload",
          parameters: [{ name: "file_name", in: "formData", type: "string", required: true, description: "name" }],
        },
      },
    },
  };
  const { ops } = extractOperations(v2);
  const makePet = ops.find((o) => o.name === "makePet");
  assert.deepEqual([...makePet.inputSchema.required].sort(), ["name"]);
  assert.equal(makePet.paramLocs.name, "body");
  assert.equal(makePet.paramLocs.age, "body");
  const upload = ops.find((o) => o.name === "upload");
  assert.equal(upload.paramLocs.file_name, "body");
  assert.deepEqual(upload.inputSchema.required, ["file_name"]);
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
