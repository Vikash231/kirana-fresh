import { bootstrapKeys } from "../core/keyring.js";
import { issueCartMandate, issueIntentMandate } from "../core/mandate.js";
import { fmt, rupees } from "../core/money.js";
import type { CartLine, SignedCartMandate, SignedIntentMandate, SignedOffer } from "../core/types.js";
import { MERCHANT_ID } from "../merchant/catalog.js";
import { BuyerGate } from "./gate.js";
import { MerchantClient } from "./mcp-client.js";

/**
 * The same end-to-end flow the LLM agent drives, with the language removed:
 * discover -> quote -> ask for a bounded add-on -> review on our own gate -> settle.
 *
 * Two independent checks happen here. The buyer runs the twelve rules before it
 * sends anything, and the merchant runs them again on arrival. A cart the buyer
 * refuses is never transmitted at all.
 */
export async function scriptedMcpRun(onEvent: (s: string) => void) {
  const { principal, agent } = bootstrapKeys();
  const merchant = await MerchantClient.connect("npx", ["tsx", "src/merchant/mcp-server.ts"]);
  const gate = new BuyerGate(principal, agent);

  const lineOf = (s: SignedOffer): CartLine => ({
    sku: s.offer.sku,
    title: s.offer.title,
    qty: s.offer.qty,
    unitPaise: s.offer.unitPaise,
    totalPaise: s.offer.totalPaise,
    offerId: s.offer.offerId,
    category: s.offer.category,
  });

  try {
    onEvent(`connected · merchant tools: ${(await merchant.listTools()).join(", ")}`);

    // Pin the merchant's public key over the wire. Without this the buyer cannot
    // verify offer signatures — and its own gate would refuse every cart.
    const mk = await merchant.call<{ keyId: string; publicKeyPem: string; gatewayMode: string }>(
      "get_merchant_key",
      {},
    );
    gate.trustMerchantKey(mk.keyId, mk.publicKeyPem);
    onEvent(`get_merchant_key → pinned ${mk.keyId} · merchant gateway = ${mk.gatewayMode.toUpperCase()}`);

    const intent = issueIntentMandate(principal, {
      principalId: "asha.menon",
      agentId: "agent-buyer-01",
      purpose: "Weekly household restock, over MCP",
      merchantAllowlist: [MERCHANT_ID],
      categoriesAllowed: ["groceries", "household"],
      budgetPaise: rupees(3_000),
      perTxnCapPaise: rupees(1_200),
      approvalThresholdPaise: rupees(800),
      ttlMinutes: 15,
    });
    const im = intent.mandate;
    onEvent(`mandate ${im.mandateId} · budget ${fmt(im.budgetPaise)} · cap ${fmt(im.perTxnCapPaise)} · approval at ${fmt(im.approvalThresholdPaise)}`);

    const buildCart = (offers: SignedOffer[]): SignedCartMandate =>
      issueCartMandate(agent, {
        intentMandateId: im.mandateId,
        agentId: im.agentId,
        merchantId: MERCHANT_ID,
        lines: offers.map(lineOf),
      });

    const submit = async (
      label: string,
      intentM: SignedIntentMandate,
      offers: SignedOffer[],
      askHuman?: Parameters<BuyerGate["review"]>[0]["askHuman"],
    ) => {
      const cart = buildCart(offers);
      const offerMap = new Map(offers.map((o) => [o.offer.offerId, o]));
      onEvent(`\n${label} · cart ${cart.mandate.cartMandateId} · ${fmt(cart.mandate.totalPaise)}`);

      // ── Buyer-side gate ────────────────────────────────────────────────────
      const review = await gate.review({ intent: intentM, cart, offers: offerMap, askHuman });
      if (review.action === "refuse") {
        onEvent(`  buyer gate  → REFUSED · ${review.rule}`);
        onEvent(`                ${review.reason}`);
        onEvent(`                nothing sent — the merchant never saw this cart`);
        return;
      }
      onEvent(`  buyer gate  → cleared${review.approval ? " (human approved, signature attached)" : ""}`);

      // ── Merchant-side gate ─────────────────────────────────────────────────
      const settled = await merchant.call<{
        outcome: string;
        decidingRule: string;
        total: string;
        orderId?: string;
        paymentId?: string;
        failureReason?: string;
      }>("settle_cart", { intentMandate: intentM, cartMandate: cart, approval: review.approval });

      onEvent(`  merchant    → ${settled.outcome} · ${settled.decidingRule} · ${settled.total}`);
      if (settled.orderId) onEvent(`                order ${settled.orderId}${settled.paymentId ? ` · payment ${settled.paymentId}` : ""}`);
      if (settled.failureReason) onEvent(`                ${settled.failureReason}`);
      if (settled.outcome === "COMPLETED") gate.recordSettled(cart);
      return { cart, settled };
    };

    // ── 1. A basket the buyer is happy with ─────────────────────────────────
    const found = await merchant.call<{ items: Array<{ sku: string }> }>("search_products", {
      category: "groceries",
      limit: 3,
    });
    onEvent(`search_products → ${found.items.map((i) => i.sku).join(", ")}`);

    const basket: SignedOffer[] = [];
    for (const item of found.items.slice(0, 2)) {
      const so = await merchant.call<SignedOffer>("get_quote", { sku: item.sku, qty: 1 });
      basket.push(so);
      onEvent(`get_quote ${so.offer.sku} → ${so.offer.offerId} ${fmt(so.offer.totalPaise)}`);
    }

    const subtotal = basket.reduce((s, o) => s + o.offer.totalPaise, 0);
    const addon = await merchant.call<{ proposal: { offer: SignedOffer; rationale: string } | null; reason?: string }>(
      "propose_upsell",
      {
        lines: basket.map((o) => ({ sku: o.offer.sku, qty: o.offer.qty, totalPaise: o.offer.totalPaise })),
        declaredHeadroomPaise: Math.max(0, im.perTxnCapPaise - subtotal),
        allowedCategories: im.categoriesAllowed,
      },
    );
    if (addon.proposal) {
      basket.push(addon.proposal.offer);
      onEvent(`propose_upsell → accepted: ${addon.proposal.rationale}`);
    } else {
      onEvent(`propose_upsell → declined: ${addon.reason}`);
    }

    const first = await submit("① in-mandate basket, above the approval threshold", intent, basket, async ({ summary }) => {
      onEvent(`  human       ⇧ "${summary}" → approved`);
      return { approved: true, reason: "this is the weekly restock I asked for" };
    });

    // ── 2. A basket the buyer refuses on its own ────────────────────────────
    const kettle = await merchant.call<SignedOffer>("get_quote", { sku: "ELC-KETTLE-1L", qty: 1 });
    onEvent(`\nget_quote ELC-KETTLE-1L → ${fmt(kettle.offer.totalPaise)} (electronics — outside the mandate)`);
    await submit("② out-of-mandate basket", intent, [kettle]);

    // ── 3. The audit trail the merchant holds ──────────────────────────────
    if (first) {
      const trail = await merchant.call<{ chainIntact: boolean; entries: Array<{ seq: number; action: string }> }>(
        "get_audit_trail",
        { cartMandateId: first.cart.mandate.cartMandateId },
      );
      onEvent(`\nget_audit_trail → ${trail.entries.length} entries, chain ${trail.chainIntact ? "intact" : "BROKEN"}`);
      for (const e of trail.entries) onEvent(`  #${e.seq} ${e.action}`);
    }

    return { cartMandateId: first?.cart.mandate.cartMandateId };
  } finally {
    await merchant.close();
  }
}
