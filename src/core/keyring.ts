import { loadOrCreateKeypair, type Keypair } from "./crypto.js";

/**
 * Who is allowed to sign what. In production the principal's public key comes
 * from the wallet/identity provider and the merchant's from its well-known
 * endpoint; here we generate and pin them locally.
 */
export class Keyring {
  private readonly pubs = new Map<string, string>();

  register(kp: Keypair): void {
    this.pubs.set(kp.id, kp.publicKeyPem);
  }

  /**
   * Pin a public key learned over the wire — how the buyer trusts the merchant's
   * offer signatures without sharing a filesystem with it.
   */
  registerPublic(keyId: string, publicKeyPem: string): void {
    this.pubs.set(keyId, publicKeyPem);
  }

  publicKey(keyId: string): string | undefined {
    return this.pubs.get(keyId);
  }
}

export const KEY_IDS = {
  principal: "principal-asha",
  agent: "agent-buyer-01",
  merchant: "merchant-kirana-fresh",
} as const;

export function bootstrapKeys(): { keyring: Keyring; principal: Keypair; agent: Keypair; merchant: Keypair } {
  const principal = loadOrCreateKeypair(KEY_IDS.principal);
  const agent = loadOrCreateKeypair(KEY_IDS.agent);
  const merchant = loadOrCreateKeypair(KEY_IDS.merchant);
  const keyring = new Keyring();
  keyring.register(principal);
  keyring.register(agent);
  keyring.register(merchant);
  return { keyring, principal, agent, merchant };
}
