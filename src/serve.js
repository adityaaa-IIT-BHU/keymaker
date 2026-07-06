import { createServer } from "node:http";
import { keymakerGateway } from "./gateway.js";

export async function startSignupServer({ dir, port = 8787 }) {
  const gateway = await keymakerGateway({ dir });
  const server = createServer(async (req, res) => {
    if (await gateway(req, res)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: "not found", hint: "GET /auth.md for agent registration instructions" })
    );
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, resolve);
  });
  return server;
}
