import { deref } from "./parse.js";

const METHODS = ["get", "post", "put", "patch", "delete"];

export function extractOperations(spec, { include, exclude } = {}) {
  const ops = [];
  const warnings = [];
  for (const [path, rawPathItem] of Object.entries(spec.paths ?? {})) {
    const pathItem = rawPathItem ?? {};
    const sharedParams = deref(spec, pathItem.parameters) ?? [];
    for (const method of METHODS) {
      if (!pathItem[method]) continue;
      const op = deref(spec, pathItem[method]);
      const name = (op.operationId || `${method}_${path}`)
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 64);
      if (include?.length && !include.some((p) => name.toLowerCase().includes(p.toLowerCase()))) continue;
      if (exclude?.length && exclude.some((p) => name.toLowerCase().includes(p.toLowerCase()))) continue;

      const properties = {};
      const required = new Set();
      const paramLocs = {};
      for (const p of [...sharedParams, ...(op.parameters ?? [])]) {
        if (!p?.name) continue;
        properties[p.name] = {
          ...(p.schema ?? { type: "string" }),
          ...(p.description || p.schema?.description
            ? { description: p.description ?? p.schema.description }
            : {}),
        };
        if (p.required || p.in === "path") required.add(p.name);
        paramLocs[p.name] = p.in;
        if (!p.description && !p.schema?.description) {
          warnings.push(`${name}: parameter "${p.name}" has no description`);
        }
      }

      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      if (bodySchema) {
        if (bodySchema.type === "object" && bodySchema.properties) {
          for (const [k, v] of Object.entries(bodySchema.properties)) {
            if (properties[k]) continue;
            properties[k] = v;
            paramLocs[k] = "body";
            if ((bodySchema.required ?? []).includes(k)) required.add(k);
          }
        } else {
          properties.body = bodySchema;
          paramLocs.body = "body";
        }
      }

      const description = [op.summary, op.description].filter(Boolean).join(" — ");
      if (!description) {
        warnings.push(`${name}: no summary or description — agents pick tools by docs; write one`);
      }

      ops.push({
        name,
        description: description || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        paramLocs,
        inputSchema: {
          type: "object",
          properties,
          ...(required.size ? { required: [...required] } : {}),
        },
        tags: op.tags ?? [],
      });
    }
  }
  return { ops, warnings };
}
