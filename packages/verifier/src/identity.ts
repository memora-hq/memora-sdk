import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Wallet } from "ethers";

export interface LocalIdentity {
  agentId: string;
  address: string;
  privateKey: string;
}

export interface LocalKeyProvider {
  load(): Promise<LocalIdentity | null>;
  save(identity: LocalIdentity): Promise<void>;
}

/** Development/file provider. Desktop builds should supply an OS-protected provider. */
export class FileKeyProvider implements LocalKeyProvider {
  constructor(private readonly path: string) {}

  async load(): Promise<LocalIdentity | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as LocalIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(identity: LocalIdentity): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await chmod(this.path, 0o600);
  }
}

export async function getOrCreateIdentity(provider: LocalKeyProvider, label = "local-agent"): Promise<LocalIdentity> {
  const existing = await provider.load();
  if (existing) return existing;
  const wallet = Wallet.createRandom();
  const identity: LocalIdentity = {
    agentId: `local:${label}:${wallet.address.slice(2, 10).toLowerCase()}`,
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
  await provider.save(identity);
  return identity;
}
