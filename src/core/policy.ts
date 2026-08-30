import { verifyPayload } from "./crypto.js";
import type { Keyring } from "./keyring.js";
import { fmt, type Paise } from "./money.js";
import type {
  PolicyDecision,
  RuleResult,
  SignedApproval,
  SignedCartMandate,
  SignedIntentMandate,
  SignedOffer,
  Verdict,
} from "./types.js";

/** Cumulative spend and settled idempotency keys, per intent mandate. */
export class SpendBook {
  private readonly spent = new Map<string, Paise>();
  private readonly settled = new Set<string>();

  spentOn(mandateId: string): Paise {
    return this.spent.get(mandateId) ?? 0;
  }

  record(mandateId: string, amount: Paise, idempotencyKey: string): void {
    this.spent.set(mandateId, this.spentOn(mandateId) + amount);
    this.settled.add(idempotencyKey);
  }

  /** Release a reserved amount when a transaction is voided or refunded. */
  release(mandateId: string, amount: Paise, idempotencyKey: string): void {
    this.spent.set(mandateId, Math.max(0, this.spentOn(mandateId) - amount));
    this.settled.delete(idempotencyKey);
  }

  isSettled(idempotencyKey: string): boolean {
    return this.settled.has(idempotencyKey);
  }
}

export interface PolicyInput {
  intent: SignedIntentMandate;
  cart: SignedCartMandate;
  offers: Map<string, SignedOffer>;
  keyring: Keyring;
  spendBook: SpendBook;
  /** A human's signed approval for this exact cart, when one was collected. */
  approval?: SignedApproval;
  now?: Date;
}

/**
 * Every money action passes through here. The LLM proposes; this disposes.
 * Rules run in order and all of them are recorded — the audit trail shows the
 * rules that passed, not just the one that failed.
 */
export function evaluate(input: PolicyInput): PolicyDecision {
  const { intent, cart, offers, keyring, spendBook, approval } = input;
  const now = input.now ?? new Date();
  const im = intent.mandate;
  const cm = cart.mandate;
  const rules: RuleResult[] = [];

  const add = (rule: string, verdict: Verdict, reason: string, observed?: string, limit?: string) =>
    rules.push({ rule, verdict, reason, observed, limit });

  // 1. The human actually authorized this mandate.
  const principalKey = keyring.publicKey(intent.principalKeyId);
  const intentSigOk = principalKey ? verifyPayload(principalKey, im, intent.principalSig) : false;
  add(
    "intent_mandate_signature",
    intentSigOk ? "ALLOW" : "DENY",
    intentSigOk ? "intent mandate signed by a known principal" : "intent mandate signature invalid or key unknown",
    intent.principalKeyId,
  );

  // 2. The agent actually authored this cart.
  const agentKey = keyring.publicKey(cart.agentKeyId);
  const cartSigOk = agentKey ? verifyPayload(agentKey, cm, cart.agentSig) : false;
  add(
    "cart_mandate_signature",
    cartSigOk ? "ALLOW" : "DENY",
    cartSigOk ? "cart mandate signed by a known agent" : "cart mandate signature invalid or key unknown",
    cart.agentKeyId,
  );

  // 3. The cart is bound to this mandate, held by this agent.
  const bound = cm.intentMandateId === im.mandateId && cm.agentId === im.agentId;
  add(
    "mandate_binding",
    bound ? "ALLOW" : "DENY",
    bound ? "cart is bound to the presented intent mandate" : "cart references a different mandate or agent",
    `${cm.intentMandateId}/${cm.agentId}`,
    `${im.mandateId}/${im.agentId}`,
  );

  // 4. The mandate is live right now.
  const t = now.getTime();
  const inWindow = t >= Date.parse(im.notBefore) && t <= Date.parse(im.expiresAt);
  add(
    "mandate_validity_window",
    inWindow ? "ALLOW" : "DENY",
    inWindow ? "mandate is within its validity window" : "mandate is expired or not yet valid",
    now.toISOString(),
    `${im.notBefore} .. ${im.expiresAt}`,
  );

  // 5. Merchant is on the human's allowlist.
  const merchantOk = im.merchantAllowlist.includes(cm.merchantId);
  add(
    "merchant_allowlist",
    merchantOk ? "ALLOW" : "DENY",
    merchantOk ? "merchant is on the principal's allowlist" : "merchant is not on the principal's allowlist",
    cm.merchantId,
    im.merchantAllowlist.join(","),
  );

  // 6. Every line sits in an allowed category. This is what stops an upsell
  //    from smuggling an out-of-scope item into an in-scope basket.
  const badCategories = [...new Set(cm.lines.filter((l) => !im.categoriesAllowed.includes(l.category)).map((l) => l.category))];
  add(
    "category_allowlist",
    badCategories.length === 0 ? "ALLOW" : "DENY",
    badCategories.length === 0
      ? "every line is in an allowed category"
      : `line categories outside mandate: ${badCategories.join(", ")}`,
    badCategories.join(",") || "-",
    im.categoriesAllowed.join(","),
  );

  // 7. Prices trace back to a live, merchant-signed offer. An agent cannot
  //    invent a price, and a stale price cannot be redeemed later.
  const offerProblems: string[] = [];
  for (const line of cm.lines) {
    const so = offers.get(line.offerId);
    if (!so) {
      offerProblems.push(`${line.sku}: no signed offer presented`);
      continue;
    }
    const mk = keyring.publicKey(so.merchantKeyId);
    if (!mk || !verifyPayload(mk, so.offer, so.merchantSig)) {
      offerProblems.push(`${line.sku}: offer signature invalid`);
      continue;
    }
    if (Date.parse(so.offer.expiresAt) < t) {
      offerProblems.push(`${line.sku}: offer expired at ${so.offer.expiresAt}`);
      continue;
    }
    if (so.offer.totalPaise !== line.totalPaise || so.offer.qty !== line.qty) {
      offerProblems.push(
        `${line.sku}: cart line ${fmt(line.totalPaise)}×${line.qty} != signed offer ${fmt(so.offer.totalPaise)}×${so.offer.qty}`,
      );
    }
  }
  add(
    "offer_provenance",
    offerProblems.length === 0 ? "ALLOW" : "DENY",
    offerProblems.length === 0 ? "all lines trace to live merchant-signed offers" : offerProblems.join("; "),
  );

  // 8. The stated total is the sum of the lines.
  const lineSum = cm.lines.reduce((s, l) => s + l.totalPaise, 0);
  const arithmeticOk = lineSum === cm.totalPaise;
  add(
    "cart_arithmetic",
    arithmeticOk ? "ALLOW" : "DENY",
    arithmeticOk ? "cart total equals the sum of its lines" : "cart total does not equal the sum of its lines",
    fmt(cm.totalPaise),
    fmt(lineSum),
  );

  // 9. Replay protection.
  const fresh = !spendBook.isSettled(cm.idempotencyKey);
  add(
    "idempotency",
    fresh ? "ALLOW" : "DENY",
    fresh ? "idempotency key not previously settled" : "idempotency key already settled — replay refused",
    cm.idempotencyKey,
  );

  // 10. Per-transaction ceiling.
  const underTxnCap = cm.totalPaise <= im.perTxnCapPaise;
  add(
    "per_transaction_cap",
    underTxnCap ? "ALLOW" : "DENY",
    underTxnCap ? "transaction is within the per-transaction cap" : "transaction exceeds the per-transaction cap",
    fmt(cm.totalPaise),
    fmt(im.perTxnCapPaise),
  );

  // 11. Cumulative budget.
  const alreadySpent = spendBook.spentOn(im.mandateId);
  const withinBudget = alreadySpent + cm.totalPaise <= im.budgetPaise;
  add(
    "cumulative_budget",
    withinBudget ? "ALLOW" : "DENY",
    withinBudget ? "transaction fits the remaining mandate budget" : "transaction would exceed the mandate budget",
    `${fmt(alreadySpent)} spent + ${fmt(cm.totalPaise)}`,
    fmt(im.budgetPaise),
  );

  // 12. Human-in-the-loop above a threshold. Not a denial — an escalation, which
  //     a signed approval from the principal resolves. The approval is bound to
  //     this cart and this amount, so it cannot be reused or scaled up.
  const needsApproval = cm.totalPaise >= im.approvalThresholdPaise;
  if (!needsApproval) {
    add(
      "human_approval_threshold",
      "ALLOW",
      "amount is below the principal's approval threshold",
      fmt(cm.totalPaise),
      fmt(im.approvalThresholdPaise),
    );
  } else {
    const check = checkApproval(approval, im, cm, keyring);
    add(
      "human_approval_threshold",
      check.ok ? "ALLOW" : "REQUIRE_APPROVAL",
      check.reason,
      fmt(cm.totalPaise),
      fmt(im.approvalThresholdPaise),
    );
  }

  const denied = rules.find((r) => r.verdict === "DENY");
  const escalate = rules.find((r) => r.verdict === "REQUIRE_APPROVAL");
  if (denied) return { verdict: "DENY", rules, decidingRule: denied.rule };
  if (escalate) return { verdict: "REQUIRE_APPROVAL", rules, decidingRule: escalate.rule };
  return { verdict: "ALLOW", rules, decidingRule: "all_rules_passed" };
}

/**
 * Is there a human signature that authorizes *this* cart at *this* amount?
 * Every field is bound so an approval cannot be replayed onto another basket,
 * reused after the amount changes, or produced by anyone but the principal.
 */
function checkApproval(
  approval: SignedApproval | undefined,
  im: SignedIntentMandate["mandate"],
  cm: SignedCartMandate["mandate"],
  keyring: Keyring,
): { ok: boolean; reason: string } {
  if (!approval) {
    return { ok: false, reason: "amount is at or above the approval threshold and no human approval was presented" };
  }
  const a = approval.attestation;
  const key = keyring.publicKey(approval.principalKeyId);
  if (!key || !verifyPayload(key, a, approval.principalSig)) {
    return { ok: false, reason: "approval signature is invalid or the signing key is unknown" };
  }
  if (a.approver !== im.principalId) {
    return { ok: false, reason: `approval signed by ${a.approver}, but the mandate belongs to ${im.principalId}` };
  }
  if (a.cartMandateId !== cm.cartMandateId || a.intentMandateId !== cm.intentMandateId) {
    return { ok: false, reason: "approval refers to a different cart or mandate" };
  }
  if (a.approvedTotalPaise !== cm.totalPaise) {
    return {
      ok: false,
      reason: `approval covers ${fmt(a.approvedTotalPaise)} but the cart totals ${fmt(cm.totalPaise)}`,
    };
  }
  return { ok: true, reason: `approved by ${a.approver} at ${a.approvedAt}` };
}
