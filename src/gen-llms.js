export function renderLlmsTxt({ spec, ops, baseUrl, serviceUrl }) {
  const title = spec.info?.title ?? "API";
  const lines = [`# ${title}`, ""];
  if (spec.info?.description) {
    lines.push(`> ${spec.info.description.trim().split("\n")[0]}`, "");
  }
  lines.push(`Base URL: ${baseUrl}`, "");

  const schemes = Object.entries(spec.components?.securitySchemes ?? {});
  if (schemes.length) {
    lines.push("## Authentication", "");
    for (const [name, s] of schemes) {
      lines.push(
        `- ${name}: ${s.type}${s.scheme ? ` (${s.scheme})` : ""}${s.description ? ` — ${s.description}` : ""}`
      );
    }
    lines.push("");
  }

  lines.push(
    "## Agent signup",
    "",
    `- [auth.md](${serviceUrl}/auth.md): Agents can register and obtain a scoped API key programmatically — no human required. POST ${serviceUrl}/agent-auth`,
    ""
  );

  const byTag = new Map();
  for (const op of ops) {
    const tag = op.tags[0] ?? "Endpoints";
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(op);
  }
  for (const [tag, list] of byTag) {
    lines.push(`## ${tag}`, "");
    for (const op of list) {
      lines.push(`- ${op.method} ${op.path} (${op.name}): ${op.description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
