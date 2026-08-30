import { randomUUID } from "node:crypto";
import { signPayload, type Keypair } from "./crypto.js";
import type {
  ApprovalAttestation,
  CartLine,
  CartMandate,
  IntentMandate,
  SignedApproval,
  SignedCartMandate,
  SignedIntentMandate,
} from "./types.js";
import type { Paise } from "./money.js";

export interface IntentMandateSpec {
  principalId: string;
  agentId: string;
  purpose: string;
  merchantAllowlist: string[];
  categoriesAllowed: string[];
  budgetPaise: Paise;
  perTxnCapPaise: Paise;
  approvalThresholdPaise: Paise;
  ttlMinutes: number;
}

/** Human-signed. This is the only place a human authorizes spend. */
export function issueIntentMandate(kp: Keypair, spec: IntentMandateSpec): SignedIntentMandate {
  const now = Date.now();
  const mandate: IntentMandate = {
    mandateId: `im_${randomUUID().slice(0, 12)}`,
    principalId: spec.principalId,
    agentId: spec.agentId,
    purpose: spec.purpose,
    merchantAllowlist: spec.merchantAllowlist,
    categoriesAllowed: spec.categoriesAllowed,
    budgetPaise: spec.budgetPaise,
    perTxnCapPaise: spec.perTxnCapPaise,
    approvalThresholdPaise: spec.approvalThresholdPaise,
    notBefore: new Date(now).toISOString(),
    expiresAt: new Date(now + spec.ttlMinutes * 60_000).toISOString(),
    nonce: randomUUID(),
  };
  return { mandate, principalSig: signPayload(kp, mandate), principalKeyId: kp.id };
}

/** Agent-signed. Binds this specific basket to the human's mandate. */
export function issueCartMandate(
  kp: Keypair,
  args: { intentMandateId: string; agentId: string; merchantId: string; lines: CartLine[] },
): SignedCartMandate {
  const totalPaise = args.lines.reduce((s, l) => s + l.totalPaise, 0);
  const cartMandateId = `cm_${randomUUID().slice(0, 12)}`;
  const mandate: CartMandate = {
    cartMandateId,
    intentMandateId: args.intentMandateId,
    agentId: args.agentId,
    merchantId: args.merchantId,
    lines: args.lines,
    totalPaise,
    currency: "INR",
    createdAt: new Date().toISOString(),
    // Derived from the cart mandate id, so a retry of the same cart can never double-charge.
    idempotencyKey: `idem_${cartMandateId}`,
  };
  return { mandate, agentSig: signPayload(kp, mandate), agentKeyId: kp.id };
}

/** Signed by the human, on the buyer's side, for one exact cart. */
export function signApproval(
  kp: Keypair,
  args: { cartMandateId: string; intentMandateId: string; approvedTotalPaise: number; approver: string; reason: string },
): SignedApproval {
  const attestation: ApprovalAttestation = {
    cartMandateId: args.cartMandateId,
    intentMandateId: args.intentMandateId,
    approvedTotalPaise: args.approvedTotalPaise,
    approver: args.approver,
    approvedAt: new Date().toISOString(),
    reason: args.reason,
  };
  return { attestation, principalSig: signPayload(kp, attestation), principalKeyId: kp.id };
}
