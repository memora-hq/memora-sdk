/**
 * Optional agent precommit signer for verified-mode writes.
 * Private keys stay client-side; only address + signature are transmitted.
 */

import { Wallet } from "ethers";
import {
  getAgentSigningDigestBytes,
  type AgentCanonicalSigningFields,
} from "@memora-hq/memora-protocol/dist/envelope.js";

/** EIP-191 personal_sign over the raw 32-byte agent precommit digest. */
export interface AgentEventSigner {
  /** Public EVM address placed in `agent_signer`. */
  readonly address: string;
  /**
   * Sign the established agent-domain digest bytes.
   * Must not log, persist, or transmit the private key.
   */
  signDigest(digest: Uint8Array): Promise<string>;
}

const ZERO_TASK = "0x" + "0".repeat(64);

export function absentTaskSentinel(): string {
  return ZERO_TASK;
}

/** Build the exact precommit fields the indexer verifies. */
export function buildAgentPrecommitFields(input: {
  agentId: string;
  signerAddress: string;
  parentIds: string[];
  payloadHash: string;
  taskId?: string;
}): AgentCanonicalSigningFields {
  return {
    agent_id: input.agentId,
    agent_signer: input.signerAddress,
    parent_event_ids: [...input.parentIds],
    payload_hash: input.payloadHash,
    task_id: input.taskId && input.taskId.length > 0 ? input.taskId : ZERO_TASK,
  };
}

export async function signAgentPrecommit(
  signer: AgentEventSigner,
  fields: AgentCanonicalSigningFields,
): Promise<string> {
  const digest = getAgentSigningDigestBytes({
    ...fields,
    agent_signer: signer.address,
  });
  return signer.signDigest(digest);
}

/**
 * Local private-key signer for development and tests.
 * Prefer hardware/HSM callbacks in production; this never sends the key.
 */
export function createPrivateKeyAgentSigner(privateKey: string): AgentEventSigner {
  if (!privateKey || typeof privateKey !== "string") {
    throw new Error("createPrivateKeyAgentSigner: privateKey is required");
  }
  const wallet = new Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  return {
    address: wallet.address,
    async signDigest(digest: Uint8Array) {
      return wallet.signMessage(digest);
    },
  };
}
