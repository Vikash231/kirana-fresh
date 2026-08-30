import type { Keypair } from "../core/crypto.js";
import { Keyring } from "../core/keyring.js";
import { signApproval } from "../core/mandate.js";
import { fmt } from "../core/money.js";
import { evaluate, SpendBook } from "../core/policy.js";
import type {
  PolicyDecision,
  SignedApproval,
  SignedCartMandate,
  SignedIntentMandate,
  SignedOffer,
} from "../core/types.js";

export interface ApprovalPrompt {
  cart: SignedCartMandate;
  decision: PolicyDecision;
  summary: string;
}

/** Ask the human. Returning false is a refusal, not an error. */
export type AskHuman = (prompt: ApprovalPrompt) => Promise<{ approved: boolean; reason: string }>;

export type BuyerReview =
  /** Safe to submit. `approval` is present only when the amount needed one. */
  | { action: "submit"; decision: PolicyDecision; approval?: SignedApproval }
  /** Refused here. Nothing is sent, and the merchant never sees this cart. */
  | { action: "refuse"; decision: PolicyDecision; rule: string; reason: string };

/**
 * The buyer's own copy of the gate.
 *
 * It runs the identical twelve rules the merchant runs, before anything leaves
 * the process. Two things follow from that. A cart that breaches the mandate is
 * refused locally — no call, no order, no money path touched. And when the amount
 * needs a human, the human is asked *here*, on the side they actually belong to,
 * and their signature travels with the cart as proof.
 *
 * The merchant still checks everything again. That is the point: a buyer that has
 * been compromised will not refuse itself, so neither side relies on the other
 * having done its job.
 */
export class BuyerGate {
  private readonly keyring = new Keyring();
  private readonly spendBook = new SpendBook();

  constructor(
    private readonly principal: Keypair,
    agent: Keypair,
  ) {
    this.keyring.register(principal);
    this.keyring.register(agent);
  }

  /**
   * Pin the merchant's public key, fetched over the protocol rather than read
   * off a shared disk. Without this the buyer cannot verify offer signatures and
   * `offer_provenance` will refuse every cart — which is the correct failure.
   */
  trustMerchantKey(keyId: string, publicKeyPem: string): void {
    this.keyring.registerPublic(keyId, publicKeyPem);
  }

  /** Mirror a settled purchase so the local budget and replay checks stay honest. */
  recordSettled(cart: SignedCartMandate): void {
    this.spendBook.record(cart.mandate.intentMandateId, cart.mandate.totalPaise, cart.mandate.idempotencyKey);
  }

  async review(args: {
    intent: SignedIntentMandate;
    cart: SignedCartMandate;
    offers: Map<string, SignedOffer>;
    askHuman?: AskHuman;
  }): Promise<BuyerReview> {
    const { intent, cart, offers } = args;
    const cm = cart.mandate;

    const decision = evaluate({
      intent,
      cart,
      offers,
      keyring: this.keyring,
      spendBook: this.spendBook,
    });

    const deciding = decision.rules.find((r) => r.rule === decision.decidingRule);

    if (decision.verdict === "DENY") {
      return {
        action: "refuse",
        decision,
        rule: decision.decidingRule,
        reason: deciding?.reason ?? "refused by the buyer's policy engine",
      };
    }

    if (decision.verdict === "REQUIRE_APPROVAL") {
      const summary = `${cm.lines.length} line(s) from ${cm.merchantId} totalling ${fmt(cm.totalPaise)}`;

      if (!args.askHuman) {
        return {
          action: "refuse",
          decision,
          rule: decision.decidingRule,
          reason: `${summary} needs human approval and no approver is available on this side`,
        };
      }

      const answer = await args.askHuman({ cart, decision, summary });
      if (!answer.approved) {
        return { action: "refuse", decision, rule: decision.decidingRule, reason: answer.reason };
      }

      const approval = signApproval(this.principal, {
        cartMandateId: cm.cartMandateId,
        intentMandateId: cm.intentMandateId,
        approvedTotalPaise: cm.totalPaise,
        approver: intent.mandate.principalId,
        reason: answer.reason,
      });

      // Re-run with the signature in hand. The approval has to satisfy rule 12
      // like any other input — it is checked, not trusted.
      const confirmed = evaluate({
        intent,
        cart,
        offers,
        approval,
        keyring: this.keyring,
        spendBook: this.spendBook,
      });
      if (confirmed.verdict !== "ALLOW") {
        const blocking = confirmed.rules.find((r) => r.rule === confirmed.decidingRule);
        return {
          action: "refuse",
          decision: confirmed,
          rule: confirmed.decidingRule,
          reason: blocking?.reason ?? "approval did not satisfy the policy",
        };
      }
      return { action: "submit", decision: confirmed, approval };
    }

    return { action: "submit", decision };
  }
}
