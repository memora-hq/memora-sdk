/**
 * Golden conformance vector — frozen `.memora` bundle.
 *
 * `vectors/bundle-v2-sealed.memora` is a real sealed v2 bundle exported by this
 * package's own machinery at the moment the vectors were frozen. This suite is the
 * offline/public verifier's forward-compatibility pin: whatever changes later, a
 * bundle produced under today's format must still read and verify with no key, no
 * account, and no network.
 *
 * @memora-hq/memora-protocol is a real npm dependency in this repo (not a workspace
 * sibling directory, unlike the private monorepo this package was extracted from), and
 * it publishes its vectors/ directory as part of the package — resolve the vector
 * through Node's own module resolution rather than a relative filesystem path.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLocalBundle, verifyBundle } from "./bundle.js";

const require = createRequire(import.meta.url);
const protocolPackageJson = require.resolve("@memora-hq/memora-protocol/package.json");
const VECTOR_PATH = join(dirname(protocolPackageJson), "vectors", "bundle-v2-sealed.memora");

/** Hardhat dev account #1 — the public, test-only key the vector was signed with. */
const VECTOR_SIGNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("golden vector — frozen .memora bundle", () => {
  it("still reads as a v2 bundle", async () => {
    const bundle = await readLocalBundle(VECTOR_PATH);
    expect(bundle.format).toBe("memora.local.bundle");
    expect(bundle.version).toBe(2);
    expect(bundle.manifest.signer).toBe(VECTOR_SIGNER);
    expect(bundle.manifest.capture_status).toBe("complete");
    expect(bundle.manifest.event_ids).toHaveLength(4);
    expect(bundle.events).toHaveLength(4);
  });

  it("still verifies end to end with no key and no network", async () => {
    const verification = verifyBundle(await readLocalBundle(VECTOR_PATH));
    expect(verification.errors).toEqual([]);
    expect(verification.valid).toBe(true);
    expect(verification.integrity).toBe("verified");
    expect(verification.identity).toBe("self-issued-continuity-verified");
    expect(verification.completeness).toBe("complete");
    expect(verification.anchoring).toBe("local-only");
    expect(verification.disclosure).toBe("none");
    expect(verification.disclosedCount).toBe(0);
    expect(verification.signer).toBe(VECTOR_SIGNER);
    expect(verification.eventCount).toBe(4);
    expect(verification.checks.every((check) => check.status === "passed")).toBe(true);
  });

  it("carries no plaintext payloads and no private key", async () => {
    const bundle = await readLocalBundle(VECTOR_PATH);
    expect((bundle as { disclosed?: unknown }).disclosed).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain("privateKey");
  });

  it("detects tampering with the frozen bundle", async () => {
    // Proves the "valid" assertion above is doing real work, not vacuously
    // passing on a verifier that accepts anything.
    const bundle = await readLocalBundle(VECTOR_PATH);
    bundle.events[1].commit.payload_hash = "0".repeat(64);
    const verification = verifyBundle(bundle);
    expect(verification.valid).toBe(false);
    expect(verification.integrity).toBe("failed");
    expect(verification.errors.length).toBeGreaterThan(0);
  });
});
