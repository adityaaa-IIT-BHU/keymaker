import Anthropic from "@anthropic-ai/sdk";

const METHODS = ["get", "post", "put", "patch", "delete"];

function opName(method, path, op) {
  return (op.operationId || `${method}_${path}`)
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/** Find operations and parameters that lack documentation. */
export function collectGaps(spec) {
  const operations = [];
  const parameters = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const p of pathItem?.parameters ?? []) {
      if (p && !p.$ref && p.name && !p.description) {
        parameters.push({
          operation: `PATH ${path}`,
          path,
          name: p.name,
          in: p.in,
          type: p.schema?.type ?? p.type,
        });
      }
    }
    for (const method of METHODS) {
      const op = pathItem?.[method];
      if (!op) continue;
      const name = opName(method, path, op);
      if (!op.summary && !op.description) {
        operations.push({
          name,
          method: method.toUpperCase(),
          path,
          params: (op.parameters ?? []).map((p) => p?.name).filter(Boolean),
        });
      }
      for (const p of op.parameters ?? []) {
        if (p && !p.$ref && p.name && !p.description) {
          parameters.push({
            operation: name,
            method: method.toUpperCase(),
            path,
            name: p.name,
            in: p.in,
            type: p.schema?.type ?? p.type,
          });
        }
      }
    }
  }
  return { operations, parameters };
}

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["operations", "parameters"],
  properties: {
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "summary", "description"],
        properties: {
          name: { type: "string" },
          summary: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    parameters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["operation", "name", "description"],
        properties: {
          operation: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM = `You write OpenAPI documentation. Given API operations and parameters that lack descriptions, draft them.
Rules: operation summaries are imperative and under 10 words. Operation descriptions are one sentence stating what the operation does and returns. Parameter descriptions are short noun phrases (no trailing period). Derive meaning only from the names, HTTP methods, and paths provided — never invent behavior, defaults, or units that the names do not imply. Echo back the exact "name" and "operation" identifiers you were given.`;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Ask Claude to draft the missing docs. Returns { operations, parameters }. */
export async function draftDescriptions(gaps, { model = "claude-opus-4-8", client } = {}) {
  const anthropic = client ?? new Anthropic();
  const drafts = { operations: [], parameters: [] };
  const opChunks = chunk(gaps.operations, 40);
  const paramChunks = chunk(gaps.parameters, 40);
  const rounds = Math.max(opChunks.length, paramChunks.length, 1);

  for (let i = 0; i < rounds; i++) {
    const payload = { operations: opChunks[i] ?? [], parameters: paramChunks[i] ?? [] };
    if (!payload.operations.length && !payload.parameters.length) continue;
    const response = await anthropic.messages.create({
      model,
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: DRAFT_SCHEMA },
      },
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    });
    if (response.stop_reason === "refusal") {
      throw new Error("The model declined to draft these descriptions.");
    }
    const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
    const parsed = JSON.parse(text);
    drafts.operations.push(...(parsed.operations ?? []));
    drafts.parameters.push(...(parsed.parameters ?? []));
  }
  return drafts;
}

/** Write drafted docs into the spec, only where fields are still empty. Returns count applied. */
export function applyDescriptions(spec, drafts) {
  let applied = 0;
  const opMap = new Map(drafts.operations.map((o) => [o.name, o]));
  const paramMap = new Map(drafts.parameters.map((p) => [`${p.operation}::${p.name}`, p]));

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const p of pathItem?.parameters ?? []) {
      if (p && !p.$ref && p.name && !p.description) {
        const d = paramMap.get(`PATH ${path}::${p.name}`);
        if (d?.description) {
          p.description = d.description;
          applied++;
        }
      }
    }
    for (const method of METHODS) {
      const op = pathItem?.[method];
      if (!op) continue;
      const name = opName(method, path, op);
      const od = opMap.get(name);
      if (od && !op.summary && !op.description) {
        op.summary = od.summary;
        op.description = od.description;
        applied++;
      }
      for (const p of op.parameters ?? []) {
        if (p && !p.$ref && p.name && !p.description) {
          const d = paramMap.get(`${name}::${p.name}`);
          if (d?.description) {
            p.description = d.description;
            applied++;
          }
        }
      }
    }
  }
  return applied;
}
