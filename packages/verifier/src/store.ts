import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  EncryptedPayloadBundle,
  LocalEventRecordV1,
  LocalExecutionManifestV1,
} from "@smritheon/memora-protocol";

/** Event payloads are content-addressed by the sha256 of their serialized ciphertext. */
export function localObjectId(commit: { cid_ciphertext: string }): string {
  return commit.cid_ciphertext.replace("local:sha256:", "");
}

export class LocalEvidenceStore {
  constructor(readonly root: string) {}

  sessionDir(sessionId: string): string {
    return join(this.root, "sessions", sessionId);
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.root, "sessions"), { recursive: true, mode: 0o700 });
  }

  async createSession(sessionId: string): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await mkdir(join(dir, "payloads"), { recursive: true, mode: 0o700 });
  }

  async appendEvent(sessionId: string, event: LocalEventRecordV1): Promise<void> {
    await appendFile(join(this.sessionDir(sessionId), "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
  }

  async putPayload(sessionId: string, objectId: string, payload: EncryptedPayloadBundle): Promise<void> {
    const path = join(this.sessionDir(sessionId), "payloads", `${objectId}.json`);
    await writeFile(path, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
  }

  async writeManifest(sessionId: string, manifest: LocalExecutionManifestV1): Promise<void> {
    const dir = this.sessionDir(sessionId);
    const temp = join(dir, `.manifest-${process.pid}.tmp`);
    await writeFile(temp, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, join(dir, "manifest.json"));
  }

  async readManifest(sessionId: string): Promise<LocalExecutionManifestV1> {
    return JSON.parse(await readFile(join(this.sessionDir(sessionId), "manifest.json"), "utf8")) as LocalExecutionManifestV1;
  }

  async readEvents(sessionId: string): Promise<LocalEventRecordV1[]> {
    const text = await readFile(join(this.sessionDir(sessionId), "events.jsonl"), "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LocalEventRecordV1);
  }

  async readPayload(sessionId: string, objectId: string): Promise<EncryptedPayloadBundle> {
    return JSON.parse(await readFile(join(this.sessionDir(sessionId), "payloads", `${objectId}.json`), "utf8")) as EncryptedPayloadBundle;
  }

  async listSessions(): Promise<LocalExecutionManifestV1[]> {
    await this.initialize();
    const entries = await readdir(join(this.root, "sessions"), { withFileTypes: true });
    const manifests: LocalExecutionManifestV1[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        manifests.push(await this.readManifest(entry.name));
      } catch {
        // Interrupted sessions without a readable manifest are recovered separately.
      }
    }
    return manifests.sort((a, b) => b.started_at.localeCompare(a.started_at));
  }
}
