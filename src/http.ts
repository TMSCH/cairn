import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Gateway } from "./core.js";
export function httpServer(
  gateway: Gateway,
  clients: { tokenSha256: string; tools: string[] }[],
  port: number,
) {
  let active = 0;
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const reject = (status: number) => {
      res.writeHead(status);
      res.end();
    };
    if (req.url !== "/mcp") {
      reject(404);
      return;
    }
    if (
      req.headers.host !== `127.0.0.1:${port}` &&
      req.headers.host !== `localhost:${port}`
    ) {
      reject(403);
      return;
    }
    if (req.headers.origin) {
      reject(403);
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (!/^Bearer [A-Za-z0-9_-]{43,128}$/.test(auth)) {
      reject(401);
      return;
    }
    const digest = createHash("sha256").update(auth.slice(7)).digest();
    const client = clients.find((c) =>
      timingSafeEqual(Buffer.from(c.tokenSha256, "hex"), digest),
    );
    if (!client) {
      reject(401);
      return;
    }
    if (req.method !== "POST") {
      reject(405);
      return;
    }
    if (active >= 2) {
      reject(429);
      return;
    }
    active++;
    let server: ReturnType<Gateway["mcp"]> | undefined;
    try {
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 64_000) {
          reject(413);
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      server = gateway.mcp(client.tools);
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) reject(400);
      else res.end();
    } finally {
      active--;
      await server?.close();
    }
  });
}
