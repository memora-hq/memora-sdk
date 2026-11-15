import { readFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { expect, it } from "vitest";
const commit = JSON.parse(readFileSync(new URL("./fixtures/event-id-metadata-v1.json", import.meta.url), "utf8"))[0].commit;
it.each([false, true])("hosted CLI uses original raw fields, with altered references=%s", async altered => {
  const requested: string[] = [];
  const raw = altered ? { ...commit, parent_event_ids: ["a", "b", "b"] } : commit;
  const ref = { ...commit, agent_id: "derived-index-identity", parent_ids: ["projection-only"], workspace_id: "workspace-a", hcs_topic_id: "0.0.synthetic", hcs_sequence: "2", hcs_timestamp: "2026-11-01T00:00:00Z", valid_signature: true, agent_sig_verified: true, contract_tx_hash: null, batch_id: null };
  const server = createServer((req, res) => {
    requested.push(req.url ?? "");res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/api/v1/topics/")) { res.end(JSON.stringify({ message: Buffer.from(JSON.stringify(raw)).toString("base64") }));return; }
    if (req.url === "/v1/events/" + commit.memory_id) { res.end(JSON.stringify(ref));return; }
    if (req.url === "/v1/events/a" || req.url === "/v1/events/b") { const id = req.url.slice(-1);res.end(JSON.stringify({ ...ref, memory_id: id, event_id: id, hcs_sequence: "1", parent_ids: [] }));return; }
    res.statusCode=404;res.end("{}");
  });
  await new Promise<void>((resolve,reject) => {server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  try {
    const address=server.address();if(!address || typeof address==="string")throw new Error("missing port");
    const base=`http://127.0.0.1:${address.port}`;
    const scratch=mkdtempSync(join(tmpdir(),"memora-slice07-cli-"));const cwd=join(scratch,"work","dir");mkdirSync(cwd,{recursive:true});
    const output=await new Promise<string>((resolve,reject) => {
      const child=spawn(process.execPath,[fileURLToPath(new URL("../dist/cli.js",import.meta.url)),"replay","verify","--memory",commit.memory_id,"--signer",commit.signer],{
        cwd, env:{PATH:process.env.PATH,NODE_ENV:"test",MEMORA_BASE_URL:base,MEMORA_API_KEY:"synthetic-cli-key",HEDERA_MIRROR_URL:base},
      });
      let text="";child.stdout.on("data",b=>text+=b);child.stderr.on("data",b=>text+=b);child.on("error",reject);
      const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("CLI timed out"));},10000);
      child.on("close",()=>{clearTimeout(timer);resolve(text);});
    });
    expect(output).toMatch(altered ? /✗ off-chain agent signature \(from HCS, standard domain\)/ : /✓ off-chain agent signature \(from HCS, standard domain\)/);
    expect(output).toMatch(altered ? /✗ off-chain operator signature \(from HCS\)/ : /✓ off-chain operator signature \(from HCS\)/);
    expect(requested.filter(p=>p==="/v1/events/a"||p==="/v1/events/b")).toHaveLength(3);
    expect(requested).not.toContain("/v1/events/projection-only");
  } finally { server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
},15000);
