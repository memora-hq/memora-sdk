import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LocalEvidenceBundleV2 } from "@smritheon/memora-protocol";
import { exportLocalBundle, readLocalBundle, verifyBundle } from "./bundle.js";
import { FileKeyProvider, getOrCreateIdentity } from "./identity.js";
import { LocalSession } from "./session.js";
import { LocalEvidenceStore, localObjectId } from "./store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memora-bundle-"));
  const store = new LocalEvidenceStore(root);
  const identity = await getOrCreateIdentity(new FileKeyProvider(join(root, "identity", "key.json")), "test");
  const session = new LocalSession({ store, identity, captureRoot: root });
  await session.start();
  await session.record("prompt_submitted", { provider: "claude" }, "adapter_reported");
  await session.record("tool_completed", { tool_name: "Edit", tool_input: { file_path: "src/app.ts" } }, "adapter_reported");
  const manifest = await session.finish("complete");
  return { root, store, identity, manifest };
}

async function readBundleFile(path: string): Promise<LocalEvidenceBundleV2> {
  return JSON.parse(await readFile(path, "utf8")) as LocalEvidenceBundleV2;
}

describe("portable evidence bundles", () => {
  it("exports a sealed v2 bundle that verifies with no key at all", async () => {
    const { root, store, identity, manifest } = await fixture();
    const path = join(root, "sealed.memora");
    const result = await exportLocalBundle(store, manifest.session_id, path);

    expect(result.disclosure).toBe("none");
    expect(result.disclosedCount).toBe(0);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const bundle = await readLocalBundle(path);
    expect(bundle.version).toBe(2);
    expect(await readFile(path, "utf8")).not.toContain(identity.privateKey);

    const verification = verifyBundle(bundle);
    expect(verification.valid).toBe(true);
    expect(verification.errors).toEqual([]);
    expect(verification.integrity).toBe("verified");
    expect(verification.disclosure).toBe("none");
    expect(verification.signer).toBe(manifest.signer);
  });

  it("still reads and verifies a version 1 bundle", async () => {
    const { root, store, manifest } = await fixture();
    const path = join(root, "legacy.memora");
    await exportLocalBundle(store, manifest.session_id, path);
    const bundle = await readBundleFile(path);
    delete bundle.disclosed;
    await writeFile(path, JSON.stringify({ ...bundle, version: 1 }));

    const legacy = await readLocalBundle(path);
    expect(legacy.version).toBe(1);
    expect(verifyBundle(legacy).valid).toBe(true);
  });

  it("discloses plaintext a recipient can bind back to the signed hashes", async () => {
    const { root, store, identity, manifest } = await fixture();
    const path = join(root, "readable.memora");
    const result = await exportLocalBundle(store, manifest.session_id, path, { disclose: "all", identity });

    expect(result.disclosure).toBe("full");
    expect(result.disclosedCount).toBe(manifest.event_ids.length);
    expect(await readFile(path, "utf8")).not.toContain(identity.privateKey);

    const verification = verifyBundle(await readLocalBundle(path));
    expect(verification.valid).toBe(true);
    expect(verification.disclosure).toBe("full");
    expect(verification.checks.find((check) => check.name === "disclosed content")?.status).toBe("passed");
  });

  it("discloses only the records that were asked for", async () => {
    const { root, store, identity, manifest } = await fixture();
    const path = join(root, "partial.memora");
    const result = await exportLocalBundle(store, manifest.session_id, path, {
      disclose: [manifest.event_ids[1]],
      identity,
    });

    expect(result.disclosure).toBe("partial");
    expect(result.disclosedCount).toBe(1);
    const verification = verifyBundle(await readLocalBundle(path));
    expect(verification.valid).toBe(true);
    expect(verification.disclosure).toBe("partial");
    expect(verification.disclosedCount).toBe(1);
  });

  it("refuses to disclose without a local identity", async () => {
    const { root, store, manifest } = await fixture();
    await expect(exportLocalBundle(store, manifest.session_id, join(root, "no.memora"), { disclose: "all" }))
      .rejects.toThrow(/local identity is required/i);
  });

  it("refuses to disclose an event that is not in the session", async () => {
    const { root, store, identity, manifest } = await fixture();
    await expect(exportLocalBundle(store, manifest.session_id, join(root, "no.memora"), {
      disclose: ["evt_does_not_exist"],
      identity,
    })).rejects.toThrow(/no such evidence record/i);
  });

  it("fails when the stored ciphertext was altered", async () => {
    const { root, store, manifest } = await fixture();
    const path = join(root, "tampered-payload.memora");
    await exportLocalBundle(store, manifest.session_id, path);
    const bundle = await readBundleFile(path);
    const objectId = localObjectId(bundle.events[0].commit);
    bundle.payloads[objectId].ciphertext = bundle.payloads[objectId].ciphertext.slice(0, -2) + "AA";
    await writeFile(path, JSON.stringify(bundle));

    const verification = verifyBundle(await readLocalBundle(path));
    expect(verification.valid).toBe(false);
    expect(verification.errors.some((error) => error.startsWith("payload modified:"))).toBe(true);
  });

  it("fails when the manifest was edited after signing", async () => {
    const { root, store, manifest } = await fixture();
    const path = join(root, "tampered-manifest.memora");
    await exportLocalBundle(store, manifest.session_id, path);
    const bundle = await readBundleFile(path);
    bundle.manifest.capture_status = "complete";
    bundle.manifest.agent_id = "local:someone-else:00000000";
    await writeFile(path, JSON.stringify(bundle));

    const verification = verifyBundle(await readLocalBundle(path));
    expect(verification.valid).toBe(false);
    expect(verification.identity).toBe("failed");
    expect(verification.checks.find((check) => check.name === "manifest signature")?.status).toBe("failed");
  });

  it("fails when disclosed plaintext is not what was signed", async () => {
    const { root, store, identity, manifest } = await fixture();
    const path = join(root, "lying.memora");
    await exportLocalBundle(store, manifest.session_id, path, { disclose: "all", identity });
    const bundle = await readBundleFile(path);
    const objectId = Object.keys(bundle.disclosed!)[0];
    bundle.disclosed![objectId].content = { tool_name: "Read", tool_input: { file_path: "harmless.txt" } };
    await writeFile(path, JSON.stringify(bundle));

    const verification = verifyBundle(await readLocalBundle(path));
    expect(verification.valid).toBe(false);
    expect(verification.errors.some((error) => error.startsWith("disclosed content does not match"))).toBe(true);
    expect(verification.checks.find((check) => check.name === "disclosed content")?.status).toBe("failed");
  });

  it("fails when disclosed content is attached to no event at all", async () => {
    const { root, store, manifest } = await fixture();
    const path = join(root, "orphan-disclosure.memora");
    await exportLocalBundle(store, manifest.session_id, path);
    const bundle = await readBundleFile(path);
    bundle.disclosed = { ["0".repeat(64)]: { contentType: "application/json", content: {} } };
    await writeFile(path, JSON.stringify(bundle));

    const verification = verifyBundle(await readLocalBundle(path));
    expect(verification.valid).toBe(false);
    expect(verification.errors.some((error) => error.startsWith("disclosed content has no matching event"))).toBe(true);
  });

  it("rejects files that are not readable Memora bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-bundle-"));
    const path = join(root, "not-a-bundle.memora");

    await writeFile(path, JSON.stringify({ format: "memora.local.bundle", version: 9 }));
    await expect(readLocalBundle(path)).rejects.toThrow(/unsupported/i);

    await writeFile(path, JSON.stringify({ format: "memora.local.bundle", version: 2, manifest: {}, events: [] }));
    await expect(readLocalBundle(path)).rejects.toThrow(/no readable execution manifest/i);

    await writeFile(path, "x".repeat(2048));
    await expect(readLocalBundle(path, 1024)).rejects.toThrow(/too large/i);
  });
});
