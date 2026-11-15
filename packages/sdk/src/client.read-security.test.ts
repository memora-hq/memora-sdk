import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoraClient } from "./client.js";

const servers: Server[] = [];
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local server address");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe.each([false, true])("native fetch credential boundaries (gateway=%s)", (v1Routes) => {
  it.each(["same-origin", "cross-origin"])("rejects all API redirects to %s destinations", async (destination) => {
    const target = vi.fn();
    const targetBase = await serve((req, res) => { target(req.url, req.headers.authorization); res.end("{}"); });
    const sourceRequests: Array<{ url?: string; auth?: string }> = [];
    let redirectStatus = 302;
    let apiBase = "";
    apiBase = await serve((req, res) => {
      sourceRequests.push({ url: req.url, auth: req.headers.authorization });
      if (req.url === "/ciphertext") { target(req.url, req.headers.authorization); res.end("{}"); return; }
      res.writeHead(redirectStatus, { Location: `${destination === "same-origin" ? apiBase : targetBase}/ciphertext` });
      res.end();
    });
    const client = new MemoraClient({ indexerBaseUrl: apiBase, keyBrokerBaseUrl: targetBase, writeSecret: "synthetic-api-key", v1Routes });
    for (const status of [301, 302, 303, 307, 308]) {
      redirectStatus = status;
      await expect(client.query({ agentId: "agent-1" })).rejects.toThrow();
      expect((await client.verify("memory-id")).valid).toBe(false);
      const sign = vi.fn();
      await expect(client.read("memory-id", sign, "wallet")).rejects.toThrow();
      expect(sign).not.toHaveBeenCalled();
    }
    expect(sourceRequests).toHaveLength(15);
    expect(sourceRequests.every((req) => req.auth === "Bearer synthetic-api-key")).toBe(true);
    expect(target).not.toHaveBeenCalled();
  });

  it("leaves ciphertext redirect chains free of the API credential", async () => {
    const seen: Array<string | undefined> = [];
    const payloadBase = await serve((req, res) => { seen.push(req.headers.authorization); res.setHeader("Content-Type", "application/json"); res.end("{}"); });
    let apiBase = "";
    apiBase = await serve((req, res) => {
      if (req.url === "/ciphertext") {
        seen.push(req.headers.authorization);
        res.writeHead(302, { Location: `${payloadBase}/payload` }); res.end();
      } else {
        expect(req.headers.authorization).toBe("Bearer synthetic-api-key");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ storage_provider: "supabase", storage_uri: `${apiBase}/ciphertext` }));
      }
    });
    const client = new MemoraClient({ indexerBaseUrl: apiBase, keyBrokerBaseUrl: payloadBase, writeSecret: "synthetic-api-key", v1Routes });
    await expect(client.read("memory-id", async () => "signature", "wallet")).rejects.toThrow(/Malformed ciphertext bundle/);
    expect(seen).toEqual([undefined, undefined]);
  });
});
