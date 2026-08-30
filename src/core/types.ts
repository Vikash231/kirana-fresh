import type { Paise } from "./money.js";

export interface CatalogItem {
  sku: string;
  title: string;
  category: string;
  unitPaise: Paise;
  taxBps: number;
  inStock: number;
  /** Machine-readable attributes an agent can filter on without scraping a page. */
  attributes: Record<string, string | number | boolean>;
}

/** A priced, time-boxed, merchant-signed commitment. The unit of agent-readable commerce. */
export interface Offer {
  offerId: string;
  merchantId: string;
  sku: string;
  title: string;
  qty: number;
  unitPaise: Paise;
  subtotalPaise: Paise;
  taxPaise: Paise;
  totalPaise: Paise;
  currency: "INR";
  category: string;
  /** ISO-8601. An offer past this instant is rejected at the gate, not at checkout. */
  expiresAt: string;
  terms: string;
}

export interface SignedOffer {
  offer: Offer;
  merchantSig: string;
  merchantKeyId: string;
}

/** Signed by the human. Defines the outer bounds of everything the agent may spend. */
export interface IntentMandate {
  mandateId: string;
  principalId: string;
  agentId: string;
  purpose: string;
  merchantAllowlist: string[];
  categoriesAllowed: string[];
  /** Total the agent may spend under this mandate, across all transactions. */
  budgetPaise: Paise;
  /** Ceiling for any single transaction. */
  perTxnCapPaise: Paise;
  /** At or above this amount, a human must approve before capture. */
  approvalThresholdPaise: Paise;
  notBefore: string;
  expiresAt: string;
  nonce: string;
}

export interface SignedIntentMandate {
  mandate: IntentMandate;
  principalSig: string;
  principalKeyId: string;
}

export interface CartLine {
  sku: string;
  title: string;
  qty: number;
  unitPaise: Paise;
  totalPaise: Paise;
  offerId: string;
  category: string;
}

/** Signed by the agent. Binds a specific basket to a specific intent mandate. */
export interface CartMandate {
  cartMandateId: string;
  intentMandateId: string;
  agentId: string;
  merchantId: string;
  lines: CartLine[];
  totalPaise: Paise;
  currency: "INR";
  createdAt: string;
  /** Idempotency key for the whole money path: order create, capture, and refund. */
  idempotencyKey: string;
}

export interface SignedCartMandate {
  mandate: CartMandate;
  agentSig: string;
  agentKeyId: string;
}

/**
 * A human's signed "yes" to one specific cart. The human sits on the buyer's
 * side, so approval is collected there — this is the artefact that travels to
 * the merchant as proof it happened, rather than the merchant taking it on trust.
 */
export interface ApprovalAttestation {
  cartMandateId: string;
  intentMandateId: string;
  /** Bound to the exact amount, so a ₹200 approval cannot settle a ₹2,000 cart. */
  approvedTotalPaise: Paise;
  approver: string;
  approvedAt: string;
  reason: string;
}

export interface SignedApproval {
  attestation: ApprovalAttestation;
  principalSig: string;
  principalKeyId: string;
}

export type Verdict = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export interface RuleResult {
  rule: string;
  verdict: Verdict;
  /** Human-readable, and stable enough to aggregate on across a batch. */
  reason: string;
  observed?: string;
  limit?: string;
}

export interface PolicyDecision {
  verdict: Verdict;
  rules: RuleResult[];
  /** The single rule that determined the outcome. Never a list — one named cause. */
  decidingRule: string;
}

export type CheckoutOutcome =
  | "COMPLETED"
  | "POLICY_BLOCKED"
  | "APPROVAL_DENIED"
  | "PAYMENT_FAILED"
  | "AWAITING_EXTERNAL_AUTHORIZATION"
  | "RECOVERED_VOID"
  | "UNRECOVERED";

export interface CheckoutResult {
  cartMandateId: string;
  outcome: CheckoutOutcome;
  decision: PolicyDecision;
  totalPaise: Paise;
  orderId?: string;
  paymentId?: string;
  refundId?: string;
  failureReason?: string;
  ledgerSeqs: number[];
}
