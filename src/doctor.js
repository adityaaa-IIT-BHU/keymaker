const UA = "keymaker-doctor/0.1 (+https://github.com/adityaaa-IIT-BHU/keymaker)";

async function probe(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": UA, ...(init.headers ?? {}) },
    });
    const text = await res.text().catch(() => "");
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: text.slice(0, 2000) };
  } catch {
    return { status: 0, type: "", body: "" };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeMarkdownDoc(r) {
  if (r.status !== 200) return false;
  const body = r.body.trimStart();
  // SPA catch-alls return 200 HTML for any path — that's a miss, not a hit
  if (body.startsWith("<") || r.type.includes("text/html")) return false;
  return body.startsWith("#") || /\[[^\]]+\]\([^)]+\)/.test(body);
}

function looksLikeMcp(r) {
  if (r.status === 0 || r.status === 404) return false;
  if (r.type.includes("text/html")) return false;
  // A real MCP endpoint answers POSTs with JSON-RPC (or auth/method errors), not a marketing page
  return [400, 401, 405, 406].includes(r.status) || r.body.includes("jsonrpc") || r.type.includes("json") || r.type.includes("event-stream");
}

/** Check a live host for the three agent surfaces. Returns presence + evidence. */
export async function checkSite(base) {
  const origin = base.replace(/\/$/, "").replace(/^(?!https?:\/\/)/, "https://");
  const [llms, llmsFull, authmd, wellKnown, mcp] = await Promise.all([
    probe(`${origin}/llms.txt`),
    probe(`${origin}/llms-full.txt`),
    probe(`${origin}/auth.md`),
    probe(`${origin}/.well-known/auth.md`),
    probe(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "keymaker-doctor", version: "0.1" } } }),
    }),
  ]);
  return {
    host: origin.replace(/^https?:\/\//, ""),
    llms_txt: looksLikeMarkdownDoc(llms) || looksLikeMarkdownDoc(llmsFull),
    auth_md: looksLikeMarkdownDoc(authmd) || looksLikeMarkdownDoc(wellKnown),
    mcp: looksLikeMcp(mcp),
  };
}

export function formatDoctor(result) {
  const mark = (b) => (b ? "✓" : "✗");
  const count = [result.llms_txt, result.auth_md, result.mcp].filter(Boolean).length;
  return `${result.host}: ${count}/3 agent surfaces   llms.txt ${mark(result.llms_txt)}   auth.md ${mark(result.auth_md)}   /mcp ${mark(result.mcp)}`;
}
