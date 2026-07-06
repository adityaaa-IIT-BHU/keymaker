import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const READ_METHODS = new Set(["GET", "HEAD"]);

function allowedTools(tools, scopes) {
  const canWrite = scopes.includes("write");
  const canRead = canWrite || scopes.includes("read");
  return tools.filter((t) => (READ_METHODS.has(t.method) ? canRead : canWrite));
}

async function proxyCall(tool, args, baseUrl, agentKey) {
  let path = tool.path;
  const query = new URLSearchParams();
  // Forward the agent's own key upstream so the vendor's API (e.g. keymakerAuth
  // middleware) sees the same identity that authenticated at /mcp.
  const headers = { "content-type": "application/json", authorization: `Bearer ${agentKey}` };
  const body = {};
  let hasBody = false;
  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined || value === null) continue;
    const loc = tool.paramLocs[key];
    if (loc === "path") path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
    else if (loc === "query") query.set(key, String(value));
    else if (loc === "header") headers[key.toLowerCase()] = String(value);
    else {
      if (key === "body" && typeof value === "object") Object.assign(body, value);
      else body[key] = value;
      hasBody = true;
    }
  }
  const url = `${baseUrl}${path}${[...query].length ? `?${query}` : ""}`;
  const res = await fetch(url, {
    method: tool.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return {
    content: [{ type: "text", text: `HTTP ${res.status} ${tool.method} ${url}\n${text.slice(0, 20000)}` }],
    isError: res.status >= 400,
  };
}

/**
 * Handle one HTTP request to /mcp (stateless Streamable HTTP).
 * `agent` is the authenticated key record; tool visibility and calls are
 * scope-filtered, and `meter()` is invoked on every successful tool call.
 */
export async function handleMcpRequest(req, res, body, { meta, agent, meter }) {
  const visible = allowedTools(meta.tools, agent.scopes);
  const server = new Server(
    { name: `${meta.title} (agent-ready)`, version: meta.version ?? "0.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visible.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = visible.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool or insufficient scope: ${request.params.name}` }],
        isError: true,
      };
    }
    const result = await proxyCall(tool, request.params.arguments, meta.baseUrl, agent.api_key);
    // When the upstream API is keymaker-protected, its middleware already meters
    // this key; meter at the gateway only for hosted-only setups that opt in.
    if (!result.isError && meta.meter_at_gateway) await meter();
    return result;
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
