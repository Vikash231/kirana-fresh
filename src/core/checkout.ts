import type { Ledger } from "./ledger.js";
import type { Keyring } from "./keyring.js";
import { fmt } from "./money.js";
import { evaluate, type SpendBook } from "./policy.js";
import type {
  CheckoutResult,
  PolicyDecision,
  SignedApproval,
  SignedCartMandate,
  SignedIntentMandate,
  SignedOffer,
} from "./types.js";
import type { RazorpayGateway } from "../razorpay/gateway.js";
import { Reconciler } from "../recon/reconciler.js";

export interface ApprovalRequest {
  cart: SignedCartMandate;
  decision: PolicyDecision;
  summary: string;
}

export type ApprovalResponse =
  /** The human said yes, and their key signed this exact cart. */
  | { approved: true; approval: SignedApproval }
  | { approved: false; approver: string; reason: string };

export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalResponse>;

export interface ExecuteArgs {
  intent: SignedIntentMandate;
  cart: SignedCartMandate;
  offers: Map<string, SignedOffer>;
  /** A human approval collected on the buyer's side and sent along with the cart. */
  approval?: SignedApproval;
  /**
   * Ask a human, in-process. Used by the single-process demo and batch; over MCP
   * the human is on the buyer's side, so an already-signed `approval` arrives instead.
   */
  approvalHandler?: ApprovalHandler;
}

/**
 * The gate. Every rupee this system moves passes through `execute`, in this order:
 *
 *   evaluate policy -> (escalate to human) -> create order -> authorize -> capture
 *
 * Each step writes to the ledger before and after it acts, so the audit trail
 * answers "who authorized this, under what bounds, and what happened" for every
 * transaction — including the ones that were refused, which is most of the value.
 */
export class CheckoutEngine {
  private readonly reconciler: Reconciler;

  constructor(
    private readonly gateway: RazorpayGateway,
    private readonly ledger: Ledger,
    private readonly keyring: Keyring,
    private readonly spendBook: SpendBook,
  ) {
    this.reconciler = new Reconciler(gateway, ledger);
  }

  async execute(args: ExecuteArgs): Promise<CheckoutResult> {
    const { intent, cart, offers } = args;
    const cm = cart.mandate;
    const subjectId = cm.cartMandateId;
    const seqs: number[] = [];
    const log = (actor: string, action: string, payload: Record<string, unknown>) =>
      seqs.push(this.ledger.append({ actor, action, subjectId, payload }).seq);

    log(`agent:${cm.agentId}`, "checkout.requested", {
      merchantId: cm.merchantId,
      intentMandateId: cm.intentMandateId,
      total: fmt(cm.totalPaise),
      lines: cm.lines.map((l) => ({ sku: l.sku, qty: l.qty, total: fmt(l.totalPaise), offerId: l.offerId })),
      idempotencyKey: cm.idempotencyKey,
    });

    // --- Gate 1: policy -------------------------------------------------------
    let approval = args.approval;
    let decision = evaluate({ intent, cart, offers, approval, keyring: this.keyring, spendBook: this.spendBook });
    log("system:policy", "policy.evaluated", {
      verdict: decision.verdict,
      decidingRule: decision.decidingRule,
      rules: decision.rules,
    });

    if (decision.verdict === "DENY") {
      const denyingRule = decision.rules.find((r) => r.rule === decision.decidingRule);
      log("system:policy", "checkout.blocked", { rule: decision.decidingRule, reason: denyingRule?.reason });
      return {
        cartMandateId: subjectId, decision, totalPaise: cm.totalPaise, ledgerSeqs: seqs,
        outcome: "POLICY_BLOCKED", failureReason: denyingRule?.reason,
      };
    }

    // --- Gate 2: human approval ----------------------------------------------
    // Reaching here means rule 12 escalated: the amount is above the threshold and
    // no valid signed approval came with the cart.
    if (decision.verdict === "REQUIRE_APPROVAL") {
      const escalation = decision.rules.find((r) => r.rule === decision.decidingRule);
      const summary = `${cm.lines.length} line(s) from ${cm.merchantId} totalling ${fmt(cm.totalPaise)}`;
      log("system:policy", "approval.requested", { rule: decision.decidingRule, summary, detail: escalation?.reason });

      if (!args.approvalHandler) {
        const reason = escalation?.reason ?? "human approval required";
        log("system:policy", "checkout.blocked", { reason });
        return {
          cartMandateId: subjectId, decision, totalPaise: cm.totalPaise, ledgerSeqs: seqs,
          outcome: "APPROVAL_DENIED", failureReason: reason,
        };
      }

      const response = await args.approvalHandler({ cart, decision, summary });
      if (!response.approved) {
        log(`human:${response.approver}`, "approval.denied", { reason: response.reason });
        return {
          cartMandateId: subjectId, decision, totalPaise: cm.totalPaise, ledgerSeqs: seqs,
          outcome: "APPROVAL_DENIED", failureReason: response.reason,
        };
      }

      approval = response.approval;
      log(`human:${approval.attestation.approver}`, "approval.granted", {
        cartMandateId: approval.attestation.cartMandateId,
        approvedTotal: fmt(approval.attestation.approvedTotalPaise),
        reason: approval.attestation.reason,
      });

      // Re-run the rules with the signature in hand — the approval has to satisfy
      // rule 12 like any other input, not bypass it.
      decision = evaluate({ intent, cart, offers, approval, keyring: this.keyring, spendBook: this.spendBook });
      log("system:policy", "policy.reevaluated", {
        verdict: decision.verdict,
        decidingRule: decision.decidingRule,
      });
      if (decision.verdict !== "ALLOW") {
        const blocking = decision.rules.find((r) => r.rule === decision.decidingRule);
        return {
          cartMandateId: subjectId, decision, totalPaise: cm.totalPaise, ledgerSeqs: seqs,
          outcome: "APPROVAL_DENIED", failureReason: blocking?.reason,
        };
      }
    }

    const base = { cartMandateId: subjectId, decision, totalPaise: cm.totalPaise, ledgerSeqs: seqs };

    // --- Money path -----------------------------------------------------------
    const order = await this.gateway.createOrder({
      amountPaise: cm.totalPaise,
      receipt: subjectId,
      idempotencyKey: cm.idempotencyKey,
      // These notes are the join key between our ledger and the Razorpay dashboard.
      notes: {
        cart_mandate_id: cm.cartMandateId,
        intent_mandate_id: cm.intentMandateId,
        agent_id: cm.agentId,
      },
    });
    log("system:gateway", "payment.order_created", { orderId: order.id, amount: fmt(order.amount), mode: this.gateway.mode });

    const auth = await this.gateway.authorize({
      orderId: order.id,
      amountPaise: cm.totalPaise,
      idempotencyKey: cm.idempotencyKey,
    });

    if (auth.kind === "failed") {
      log("system:gateway", "payment.authorization_failed", { orderId: order.id, code: auth.code, description: auth.description });
      // A clean decline moved no money, but we still confirm that with the gateway
      // rather than trusting the response we happened to receive.
      const recon = await this.reconciler.reconcile({
        subjectId,
        orderId: order.id,
        expectedPaise: cm.totalPaise,
        idempotencyKey: cm.idempotencyKey,
        cause: `authorization_failed:${auth.code}`,
      });
      if (recon.kind === "compensated") {
        return { ...base, outcome: "RECOVERED_VOID", orderId: order.id, refundId: recon.refundId, failureReason: auth.description };
      }
      return { ...base, outcome: "PAYMENT_FAILED", orderId: order.id, failureReason: `${auth.code}: ${auth.description}` };
    }

    if (auth.kind === "pending_external") {
      log("system:gateway", "payment.awaiting_external_authorization", { orderId: order.id, url: auth.url });
      return { ...base, outcome: "AWAITING_EXTERNAL_AUTHORIZATION", orderId: order.id, failureReason: `awaiting buyer authorization at ${auth.url}` };
    }

    if (auth.kind === "indeterminate") {
      log("system:gateway", "payment.indeterminate", { orderId: order.id, description: auth.description });
      const recon = await this.reconciler.reconcile({
        subjectId,
        orderId: order.id,
        expectedPaise: cm.totalPaise,
        idempotencyKey: cm.idempotencyKey,
        cause: "indeterminate_authorization",
      });
      if (recon.kind === "compensated") {
        log("system:reconciler", "checkout.recovered", { orderId: order.id, refundId: recon.refundId });
        return { ...base, outcome: "RECOVERED_VOID", orderId: order.id, paymentId: recon.paymentId, refundId: recon.refundId, failureReason: auth.description };
      }
      if (recon.kind === "nothing_to_do") {
        return { ...base, outcome: "PAYMENT_FAILED", orderId: order.id, failureReason: auth.description };
      }
      return { ...base, outcome: "UNRECOVERED", orderId: order.id, failureReason: recon.detail };
    }

    // --- Capture --------------------------------------------------------------
    try {
      const captured = await this.gateway.capture({
        paymentId: auth.payment.id,
        amountPaise: cm.totalPaise,
        idempotencyKey: cm.idempotencyKey,
      });
      this.spendBook.record(cm.intentMandateId, cm.totalPaise, cm.idempotencyKey);
      log("system:gateway", "payment.captured", { orderId: order.id, paymentId: captured.id, amount: fmt(captured.amount) });
      log("system:policy", "budget.debited", {
        intentMandateId: cm.intentMandateId,
        debited: fmt(cm.totalPaise),
        spentToDate: fmt(this.spendBook.spentOn(cm.intentMandateId)),
      });
      log(`agent:${cm.agentId}`, "checkout.completed", { orderId: order.id, paymentId: captured.id, total: fmt(cm.totalPaise) });
      return { ...base, outcome: "COMPLETED", orderId: order.id, paymentId: captured.id };
    } catch (err) {
      const message = (err as Error).message;
      log("system:gateway", "payment.capture_failed", { orderId: order.id, paymentId: auth.payment.id, error: message });
      const recon = await this.reconciler.reconcile({
        subjectId,
        orderId: order.id,
        expectedPaise: cm.totalPaise,
        idempotencyKey: cm.idempotencyKey,
        cause: "capture_failed",
      });
      if (recon.kind === "compensated") {
        log("system:reconciler", "checkout.recovered", { orderId: order.id, refundId: recon.refundId });
        return { ...base, outcome: "RECOVERED_VOID", orderId: order.id, paymentId: recon.paymentId, refundId: recon.refundId, failureReason: message };
      }
      if (recon.kind === "nothing_to_do") {
        return { ...base, outcome: "PAYMENT_FAILED", orderId: order.id, failureReason: message };
      }
      return { ...base, outcome: "UNRECOVERED", orderId: order.id, failureReason: recon.detail };
    }
  }
}
