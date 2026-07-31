import { createHash } from "node:crypto";
import { Wallet, verifyMessage } from "ethers";
import type { LocalExecutionManifestV1 } from "@smritheon/memora-protocol";

const LOCAL_MANIFEST_DOMAIN = "memora:local:manifest:v1\n";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function unsigned(manifest: LocalExecutionManifestV1): LocalExecutionManifestV1 {
  return { ...manifest, signature: null };
}

export function manifestDigest(manifest: LocalExecutionManifestV1): Buffer {
  return createHash("sha256").update(LOCAL_MANIFEST_DOMAIN + canonical(unsigned(manifest)), "utf8").digest();
}

export async function signManifest(manifest: LocalExecutionManifestV1, privateKey: string): Promise<LocalExecutionManifestV1> {
  const signature = await new Wallet(privateKey).signMessage(manifestDigest(manifest));
  return { ...manifest, signature };
}

export function verifyManifest(manifest: LocalExecutionManifestV1): { valid: boolean; recoveredSigner: string | null; reason?: string } {
  if (!manifest.signature) return { valid: false, recoveredSigner: null, reason: "manifest signature missing" };
  try {
    const recoveredSigner = verifyMessage(manifestDigest(manifest), manifest.signature);
    const valid = recoveredSigner.toLowerCase() === manifest.signer.toLowerCase();
    return { valid, recoveredSigner, reason: valid ? undefined : "manifest signer mismatch" };
  } catch (error) {
    return { valid: false, recoveredSigner: null, reason: (error as Error).message };
  }
}
