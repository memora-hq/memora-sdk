import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyOriginalEvent, EVENT_ID_PROFILES } from "./index.js";
const vectors: Array<{ name: string; preimage: string; commit: Record<string, any> }> = JSON.parse(readFileSync(new URL("./fixtures/hosted-event-id-v1.json", import.meta.url), "utf8"));
describe("original event verification", () => {
  it.each(vectors)("verifies stored $name bytes with a caller-pinned profile and signer", (v) => {
    const original = { commit_bytes_b64: Buffer.from(JSON.stringify(v.commit)).toString("base64"), event_id_preimage_b64: Buffer.from(v.preimage).toString("base64") };
    const policy = { profile: EVENT_ID_PROFILES.hosted, expectedOperatorSigner: v.commit.signer };
    expect(verifyOriginalEvent(original, policy).valid).toBe(true);
    expect(verifyOriginalEvent(original, { ...policy, expectedOperatorSigner: "" }).valid).toBe(false);
    expect(verifyOriginalEvent(original, { ...policy, profile: "untrusted-label" as any }).valid).toBe(false);
    for (const bad of ["!", original.commit_bytes_b64 + "\n", Buffer.from([255]).toString("base64")]) {
      expect(verifyOriginalEvent({ ...original, commit_bytes_b64: bad }, policy).valid).toBe(false);
      expect(verifyOriginalEvent({ ...original, event_id_preimage_b64: bad }, policy).valid).toBe(false);
    }
    const commit = { ...v.commit, task_id: "tampered" };
    expect(verifyOriginalEvent({ ...original, commit_bytes_b64: Buffer.from(JSON.stringify(commit)).toString("base64") }, policy).valid).toBe(false);
  });
});
