import { readFile } from "node:fs/promises";
import yaml from "js-yaml";

export async function loadSpec(src) {
  let text;
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Failed to fetch spec: HTTP ${res.status}`);
    text = await res.text();
  } else {
    text = await readFile(src, "utf8");
  }
  const spec = yaml.load(text);
  if (!spec || typeof spec !== "object" || (!spec.openapi && !spec.swagger)) {
    throw new Error("Not an OpenAPI document (missing openapi/swagger field)");
  }
  return spec;
}

const MAX_DEPTH = 30;

export function deref(spec, node, depth = 0) {
  if (depth > MAX_DEPTH || node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => deref(spec, n, depth + 1));
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    const target = node.$ref
      .slice(2)
      .split("/")
      .reduce((acc, key) => acc?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], spec);
    if (!target) return { description: `Unresolved ref: ${node.$ref}` };
    return deref(spec, target, depth + 1);
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(spec, v, depth + 1);
  return out;
}
