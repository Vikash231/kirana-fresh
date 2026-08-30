import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "./canonical.js";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface Keypair {
  id: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

const KEY_DIR = join(process.cwd(), "keys");

/**
 * Ed25519 keypair, persisted so mandates signed in one run verify in the next.
 * Demo keys only — a real deployment keeps principal keys in the user's wallet
 * or an HSM, never on the agent's disk.
 */
export function loadOrCreateKeypair(id: string): Keypair {
  mkdirSync(KEY_DIR, { recursive: true });
  const path = join(KEY_DIR, `${id}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Keypair;

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kp: Keypair = {
    id,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  writeFileSync(path, JSON.stringify(kp, null, 2));
  return kp;
}

/** Sign the canonical form of `payload`. Returns base64. */
export function signPayload(kp: Keypair, payload: unknown): string {
  const key = createPrivateKey(kp.privateKeyPem);
  return sign(null, Buffer.from(canonical(payload)), key).toString("base64");
}

export function verifyPayload(publicKeyPem: string, payload: unknown, signature: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
