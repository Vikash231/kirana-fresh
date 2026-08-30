import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../app.js";
import { signPayload } from "../core/crypto.js";
import { issueIntentMandate, signApproval } from "../core/mandate.js";
import { fmt, rupees, type Paise } from "../core/money.js";
import type { ApprovalHandler } from "../core/checkout.js";
import type { CheckoutOutcome, CheckoutResult, SignedCartMandate, SignedIntentMandate, SignedOffer } from "../core/types.js";
import { MERCHANT_ID } from "../merchant/catalog.js";
import { quote } from "../merchant/quote.js";
import { basketFor, planCart } from "../buyer/planner.js";
import { BuyerGate } from "../buyer/gate.js";

type Scenario =
  | "clean"
  | "out_of_category"
  | "over_txn_cap"
  | "expired_offer"
  | "price_tamper_resigned"
  | "forged_cart_signature"
  | "replay"
  | "needs_approval_granted"
  | "needs_approval_denied"
  | "budget_exhaustion"
  /** A compromised agent that skips its own gate and submits straight to the merchant. */
  | "rogue_buyer_bypass";

interface Case {
  index: number;
  scenario: Scenario;
  result: CheckoutResult;
  /** Which of the two independent gates refused it, when one did. */
  caughtBy: "buyer" | "merchant" | "none";
  upsell: { proposed: boolean; accepted: boolean; paise: Paise };
}

const PLAN: Scenario[] = [
  ...Array<Scenario>(25).fill("clean"),
  ...Array<Scenario>(3).fill("rogue_buyer_bypass"),
  ...Array<Scenario>(4).fill("out_of_category"),
  ...Array<Scenario>(4).fill("over_txn_cap"),
  ...Array<Scenario>(3).fill("expired_offer"),
  ...Array<Scenario>(3).fill("price_tamper_resigned"),
  ...Array<Scenario>(2).fill("forged_cart_signature"),
  ...Array<Scenario>(2).fill("replay"),
  ...Array<Scenario>(2).fill("needs_approval_granted"),
  ...Array<Scenario>(1).fill("needs_approval_denied"),
  ...Array<Scenario>(1).fill("budget_exhaustion"),
];

export interface BatchOptions {
  seed?: number;
  faultRates?: { declined?: number; indeterminate_authorize?: number; capture_failed?: number };
}

export async function runBatch(opts: BatchOptions = {}) {
  const seed = opts.seed ?? 20260830;
  const faultRates = opts.faultRates ?? { declined: 0.08, indeterminate_authorize: 0.06, capture_failed: 0.04 };

  const app = buildApp({
    ledgerFile: `batch-${seed}.jsonl`,
    // The batch always runs on the fake: a live test account will not produce a
    // timeout-after-authorization on demand, and that is the failure worth proving.
    forceFake: true,
    // Fresh ledger each run so the reported entry count is this batch's, not a running total.
    truncateLedger: true,
    fake: { seed, faultRates },
  });

  const main = issueIntentMandate(app.principal, {
    principalId: "asha.menon",
    agentId: "agent-buyer-01",
    purpose: "Weekly household restock",
    merchantAllowlist: [MERCHANT_ID],
    categoriesAllowed: ["groceries", "household", "personal_care"],
    budgetPaise: rupees(40_000),
    perTxnCapPaise: rupees(2_500),
    approvalThresholdPaise: rupees(2_000),
    ttlMinutes: 60,
  });

  // A second, deliberately tight mandate so the cumulative-budget rule is exercised
  // rather than merely implemented.
  const tight = issueIntentMandate(app.principal, {
    principalId: "asha.menon",
    agentId: "agent-buyer-01",
    purpose: "Small top-up with a hard ceiling",
    merchantAllowlist: [MERCHANT_ID],
    categoriesAllowed: ["groceries", "household", "personal_care"],
    budgetPaise: rupees(500),
    perTxnCapPaise: rupees(2_500),
    approvalThresholdPaise: rupees(2_400),
    ttlMinutes: 60,
  });

  const approvals: Record<string, boolean> = {};
  const approvalHandler: ApprovalHandler = async ({ cart }) => {
    const approved = approvals[cart.mandate.cartMandateId] ?? true;
    if (!approved) {
      return { approved: false, approver: "asha.menon", reason: "larger than I want to spend this week" };
    }
    return {
      approved: true,
      approval: signApproval(app.principal, {
        cartMandateId: cart.mandate.cartMandateId,
        intentMandateId: cart.mandate.intentMandateId,
        approvedTotalPaise: cart.mandate.totalPaise,
        approver: "asha.menon",
        reason: "amount and merchant look right for a weekly restock",
      }),
    };
  };

  // The buyer's own gate, holding the same rules the merchant runs. It learns the
  // merchant's public key the same way a real buyer would — by being told it.
  const buyerGate = new BuyerGate(app.principal, app.agent);
  buyerGate.trustMerchantKey(app.merchant.id, app.merchant.publicKeyPem);

  const cases: Case[] = [];
  let settledForReplay: { intent: SignedIntentMandate; cart: SignedCartMandate; offers: Map<string, SignedOffer> } | null = null;

  for (let i = 0; i < PLAN.length; i++) {
    const scenario = PLAN[i]!;
    let intent = main;
    let cart: SignedCartMandate;
    let offers: Map<string, SignedOffer>;
    let upsell = { proposed: false, accepted: false, paise: 0 };

    if (scenario === "replay" && settledForReplay) {
      ({ intent, cart, offers } = settledForReplay);
    } else if (scenario === "out_of_category") {
      const plan = planCart(app.agent, app.merchant, intent, { want: [{ sku: "ELC-KETTLE-1L", qty: 1 }], acceptUpsell: false });
      ({ cart, offers } = plan);
    } else if (scenario === "over_txn_cap") {
      const plan = planCart(app.agent, app.merchant, intent, { want: [{ sku: "GRC-RICE-5KG", qty: 8 }], acceptUpsell: false });
      ({ cart, offers } = plan);
    } else if (scenario === "expired_offer") {
      const stale = quote(app.merchant, "GRC-DAL-1KG", 2, { ttlSeconds: -60 });
      offers = new Map([[stale.offer.offerId, stale]]);
      const plan = planCart(app.agent, app.merchant, intent, { want: [], acceptUpsell: false });
      cart = { ...plan.cart };
      cart.mandate = {
        ...cart.mandate,
        lines: [{
          sku: stale.offer.sku, title: stale.offer.title, qty: stale.offer.qty,
          unitPaise: stale.offer.unitPaise, totalPaise: stale.offer.totalPaise,
          offerId: stale.offer.offerId, category: stale.offer.category,
        }],
        totalPaise: stale.offer.totalPaise,
      };
      cart.agentSig = signPayload(app.agent, cart.mandate);
    } else if (scenario === "price_tamper_resigned") {
      // The agent halves a line price and re-signs. Its own signature is valid;
      // the merchant-signed offer is what catches it.
      const plan = planCart(app.agent, app.merchant, intent, { want: [{ sku: "GRC-OIL-1L", qty: 1 }], acceptUpsell: false });
      offers = plan.offers;
      const line = plan.cart.mandate.lines[0]!;
      const tampered = { ...line, totalPaise: Math.floor(line.totalPaise / 2) };
      cart = { ...plan.cart, mandate: { ...plan.cart.mandate, lines: [tampered], totalPaise: tampered.totalPaise } };
      cart.agentSig = signPayload(app.agent, cart.mandate);
    } else if (scenario === "forged_cart_signature") {
      // Same tamper, without re-signing: the cart signature itself fails.
      const plan = planCart(app.agent, app.merchant, intent, { want: [{ sku: "GRC-TEA-500G", qty: 1 }], acceptUpsell: false });
      offers = plan.offers;
      const line = plan.cart.mandate.lines[0]!;
      cart = { ...plan.cart, mandate: { ...plan.cart.mandate, lines: [{ ...line, totalPaise: 1 }], totalPaise: 1 } };
    } else if (scenario === "needs_approval_granted" || scenario === "needs_approval_denied") {
      const plan = planCart(app.agent, app.merchant, intent, { want: [{ sku: "GRC-RICE-5KG", qty: 5 }], acceptUpsell: false });
      ({ cart, offers } = plan);
      approvals[cart.mandate.cartMandateId] = scenario === "needs_approval_granted";
    } else if (scenario === "rogue_buyer_bypass") {
      // Out-of-category basket, submitted by an agent that does not run its own
      // gate. This is the only reason the merchant-side check earns its place.
      const plan = planCart(app.agent, app.merchant, intent, { want: [{ sku: "ELC-MIXER-750W", qty: 1 }], acceptUpsell: false });
      ({ cart, offers } = plan);
    } else if (scenario === "budget_exhaustion") {
      intent = tight;
      const plan = planCart(app.agent, app.merchant, tight, { want: [{ sku: "GRC-ATTA-5KG", qty: 3 }], acceptUpsell: false });
      ({ cart, offers } = plan);
    } else {
      const plan = planCart(app.agent, app.merchant, intent, {
        want: basketFor(i),
        acceptUpsell: true,
        // Every other basket meets a merchant that proposes past the headroom the
        // buyer declared. That is what makes the "declined" count meaningful.
        greedyMerchant: i % 2 === 0,
      });
      ({ cart, offers } = plan);
      upsell = { proposed: plan.upsellProposed, accepted: plan.upsellAccepted, paise: plan.upsellPaise };
    }

    // ── Gate 1 of 2: the buyer checks before anything is transmitted ─────────
    // …unless the buyer has been compromised and skips its own check entirely.
    const review = scenario === "rogue_buyer_bypass"
      ? ({ action: "submit" as const, decision: undefined as never, approval: undefined })
      : await buyerGate.review({
      intent,
      cart,
      offers,
      askHuman: async () => {
        const approved = approvals[cart.mandate.cartMandateId] ?? true;
        return {
          approved,
          reason: approved
            ? "amount and merchant look right for a weekly restock"
            : "larger than I want to spend this week",
        };
      },
    });

    if (review.action === "refuse") {
      const blocked = review.decision.rules.find((r) => r.rule === review.rule);
      cases.push({
        index: i,
        scenario,
        caughtBy: "buyer",
        upsell,
        result: {
          cartMandateId: cart.mandate.cartMandateId,
          decision: review.decision,
          totalPaise: cart.mandate.totalPaise,
          outcome: review.decision.verdict === "REQUIRE_APPROVAL" ? "APPROVAL_DENIED" : "POLICY_BLOCKED",
          failureReason: blocked?.reason ?? review.reason,
          ledgerSeqs: [],
        },
      });
      continue;
    }

    // ── Gate 2 of 2: the merchant checks again on arrival ────────────────────
    const result = await app.engine.execute({ intent, cart, offers, approval: review.approval, approvalHandler });
    const caughtBy =
      result.outcome === "POLICY_BLOCKED" || result.outcome === "APPROVAL_DENIED" ? "merchant" : "none";
    cases.push({ index: i, scenario, result, caughtBy, upsell });

    if (result.outcome === "COMPLETED") {
      buyerGate.recordSettled(cart);
      if (!settledForReplay) settledForReplay = { intent, cart, offers };
    }
  }

  return summarize(cases, app.ledger.verify(), { seed, faultRates });
}

export interface BatchReport {
  seed: number;
  faultRates: Record<string, number | undefined>;
  total: number;
  outcomes: Record<string, { count: number; pct: string }>;
  /** Proof that two independent gates ran: refusals attributed to the side that caught them. */
  caughtBy: { buyer: number; merchant: number };
  blockedByRule: Record<string, number>;
  money: { attempted: string; captured: string; compensated: string; leaked: string };
  /** The revenue-growth half of the track, measured rather than asserted. */
  upsell: {
    proposed: number;
    accepted: number;
    declinedByBuyer: number;
    revenueOnCompleted: string;
    upliftPct: string;
  };
  faultRecovery: { injectedFailures: number; recovered: number; unrecovered: number; recoveryPct: string };
  ledger: { intact: boolean; entries: number; detail?: string };
  perScenario: Array<{ scenario: string; count: number; outcomes: Record<string, number> }>;
  cases: Array<{ index: number; scenario: string; outcome: CheckoutOutcome; caughtBy: string; decidingRule: string; total: string; failureReason?: string }>;
}

function summarize(
  cases: Case[],
  ledger: { ok: true; length: number } | { ok: false; brokenAtSeq: number; detail: string },
  cfg: { seed: number; faultRates: Record<string, number | undefined> },
): BatchReport {
  const total = cases.length;
  const outcomes: Record<string, { count: number; pct: string }> = {};
  const blockedByRule: Record<string, number> = {};
  const perScenarioMap = new Map<string, Record<string, number>>();

  const caughtBy = { buyer: 0, merchant: 0 };
  let upsellProposed = 0;
  let upsellAccepted = 0;
  let upsellRevenue: Paise = 0;
  let attempted: Paise = 0;
  let captured: Paise = 0;
  let compensated: Paise = 0;
  let leaked: Paise = 0;

  for (const c of cases) {
    const o = c.result.outcome;
    outcomes[o] ??= { count: 0, pct: "" };
    outcomes[o]!.count++;

    const bucket = perScenarioMap.get(c.scenario) ?? {};
    bucket[o] = (bucket[o] ?? 0) + 1;
    perScenarioMap.set(c.scenario, bucket);

    attempted += c.result.totalPaise;
    if (c.upsell.proposed) upsellProposed++;
    if (c.upsell.accepted) upsellAccepted++;
    // Only count add-on revenue that actually settled — a proposal in a refused
    // cart earned the merchant nothing.
    if (c.upsell.accepted && o === "COMPLETED") upsellRevenue += c.upsell.paise;
    if (c.caughtBy === "buyer") caughtBy.buyer++;
    if (c.caughtBy === "merchant") caughtBy.merchant++;
    if (o === "POLICY_BLOCKED" || o === "APPROVAL_DENIED") {
      blockedByRule[c.result.decision.decidingRule] = (blockedByRule[c.result.decision.decidingRule] ?? 0) + 1;
    }
    if (o === "COMPLETED") captured += c.result.totalPaise;
    if (o === "RECOVERED_VOID") compensated += c.result.totalPaise;
    if (o === "UNRECOVERED") leaked += c.result.totalPaise;
  }

  for (const k of Object.keys(outcomes)) {
    outcomes[k]!.pct = `${((outcomes[k]!.count / total) * 100).toFixed(1)}%`;
  }

  const injectedFailures = cases.filter((c) =>
    ["RECOVERED_VOID", "PAYMENT_FAILED", "UNRECOVERED"].includes(c.result.outcome),
  ).length;
  const recovered = cases.filter((c) => c.result.outcome === "RECOVERED_VOID" || c.result.outcome === "PAYMENT_FAILED").length;
  const unrecovered = cases.filter((c) => c.result.outcome === "UNRECOVERED").length;

  return {
    seed: cfg.seed,
    faultRates: cfg.faultRates,
    total,
    outcomes,
    caughtBy,
    blockedByRule,
    money: { attempted: fmt(attempted), captured: fmt(captured), compensated: fmt(compensated), leaked: fmt(leaked) },
    upsell: {
      proposed: upsellProposed,
      accepted: upsellAccepted,
      declinedByBuyer: upsellProposed - upsellAccepted,
      revenueOnCompleted: fmt(upsellRevenue),
      upliftPct: captured === 0 ? "n/a" : `${((upsellRevenue / captured) * 100).toFixed(1)}%`,
    },
    faultRecovery: {
      injectedFailures,
      recovered,
      unrecovered,
      recoveryPct: injectedFailures === 0 ? "n/a" : `${((recovered / injectedFailures) * 100).toFixed(1)}%`,
    },
    ledger: ledger.ok
      ? { intact: true, entries: ledger.length }
      : { intact: false, entries: ledger.brokenAtSeq, detail: ledger.detail },
    perScenario: [...perScenarioMap.entries()].map(([scenario, o]) => ({
      scenario,
      count: Object.values(o).reduce((a, b) => a + b, 0),
      outcomes: o,
    })),
    cases: cases.map((c) => ({
      index: c.index,
      scenario: c.scenario,
      outcome: c.result.outcome,
      caughtBy: c.caughtBy,
      decidingRule: c.result.decision.decidingRule,
      total: fmt(c.result.totalPaise),
      failureReason: c.result.failureReason,
    })),
  };
}

export function writeReport(report: BatchReport): string {
  const dir = join(process.cwd(), "bench-out");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `batch-${report.seed}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}
