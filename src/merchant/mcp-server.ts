#!/usr/bin/env -S npx tsx
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildApp } from "../app.js";
import { fmt } from "../core/money.js";
import type { SignedApproval, SignedCartMandate, SignedIntentMandate, SignedOffer } from "../core/types.js";
import { CATALOG, MERCHANT_ID, MERCHANT_NAME, bySku, search } from "./catalog.js";
import { quote } from "./quote.js";
import { proposeUpsell } from "./upsell.js";

/**
 * Kirana Fresh, exposed as an MCP server: an agent-readable storefront that any
 * AI buyer can discover, price, and transact against without scraping a page.
 *
 * `settle_cart` deliberately re-runs the full mandate + policy check on the
 * merchant side. Both parties verify: the buyer will not pay outside its
 * mandate, and the merchant will not accept an order it cannot prove a human
 * authorized. Neither side has to trust the other's word for it.
 */
const app = buildApp({ ledgerFile: "mcp.jsonl" });

/** Offers this server has signed, so `settle_cart` can check provenance itself. */
const issuedOffers = new Map<string, SignedOffer>();

const server = new McpServer({ name: "kirana-fresh", version: "0.1.0" });

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

server.registerTool(
  "search_products",
  {
    title: "Search the catalog",
    description:
      "Search Kirana Fresh's catalog. Returns typed products with machine-comparable attributes and prices in paise (1 INR = 100 paise). Prices here are indicative — call get_quote for a signed, honoured price.",
    inputSchema: {
      q: z.string().optional().describe("free-text match on title, sku, or category"),
      category: z.enum(["groceries", "household", "personal_care", "electronics"]).optional(),
      maxUnitPaise: z.number().int().positive().optional().describe("exclude items priced above this, in paise"),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async (args) => ok({ merchantId: MERCHANT_ID, count: search(args).length, items: search(args) }),
);

server.registerTool(
  "get_merchant_key",
  {
    title: "Fetch the merchant's public signing key",
    description:
      "Returns the Ed25519 public key this merchant signs offers with. Pin it once on connect, then verify every offer signature yourself — you never have to take the merchant's prices on trust, and you never need access to its private key.",
    inputSchema: {},
  },
  async () =>
    ok({
      merchantId: MERCHANT_ID,
      keyId: app.merchant.id,
      publicKeyPem: app.merchant.publicKeyPem,
      // Stated on the handshake so a caller is never guessing whether the money
      // it is about to move is real.
      gatewayMode: app.gateway.mode,
    }),
);

server.registerTool(
  "get_product",
  {
    title: "Fetch one product",
    description: "Fetch a single catalog item by SKU, including stock and tax rate in basis points.",
    inputSchema: { sku: z.string() },
  },
  async ({ sku }) => {
    const item = bySku(sku);
    return item ? ok(item) : ok({ error: `unknown sku: ${sku}`, knownSkus: CATALOG.map((c) => c.sku) });
  },
);

server.registerTool(
  "get_quote",
  {
    title: "Get a signed, time-boxed offer",
    description:
      "Price a SKU at a quantity and return a merchant-signed Offer. The signature and expiry are what let a buyer's policy engine prove the price is real and current. Put the returned offerId on the matching cart line.",
    inputSchema: { sku: z.string(), qty: z.number().int().min(1) },
  },
  async ({ sku, qty }) => {
    try {
      const so = quote(app.merchant, sku, qty);
      issuedOffers.set(so.offer.offerId, so);
      return ok(so);
    } catch (err) {
      return ok({ error: (err as Error).message });
    }
  },
);

server.registerTool(
  "propose_upsell",
  {
    title: "Ask the merchant for a bounded add-on",
    description:
      "Given the current cart and the headroom the buyer is willing to declare, returns at most one complementary add-on as a signed offer, capped at a fraction of that headroom and confined to the categories the buyer allows. Returns null when nothing fits — the merchant will not propose something the buyer cannot accept.",
    inputSchema: {
      lines: z
        .array(z.object({ sku: z.string(), qty: z.number().int().min(1), totalPaise: z.number().int().min(0) }))
        .describe("the cart as it stands"),
      declaredHeadroomPaise: z.number().int().min(0).describe("what the buyer says it may still spend, in paise"),
      allowedCategories: z.array(z.string()).describe("categories the buyer's mandate permits"),
    },
  },
  async ({ lines, declaredHeadroomPaise, allowedCategories }) => {
    const enriched = lines.map((l) => {
      const item = bySku(l.sku);
      return {
        sku: l.sku,
        title: item?.title ?? l.sku,
        qty: l.qty,
        unitPaise: item?.unitPaise ?? 0,
        totalPaise: l.totalPaise,
        offerId: "",
        category: item?.category ?? "unknown",
      };
    });
    const proposal = proposeUpsell(app.merchant, { lines: enriched, declaredHeadroomPaise, allowedCategories });
    if (!proposal) return ok({ proposal: null, reason: "no eligible add-on within the declared headroom and categories" });
    issuedOffers.set(proposal.offer.offer.offerId, proposal.offer);
    return ok({ proposal, reason: null });
  },
);

server.registerTool(
  "settle_cart",
  {
    title: "Submit a signed cart mandate for settlement",
    description:
      "Submit the human-signed intent mandate and the agent-signed cart mandate. The merchant re-verifies both signatures, checks every line against the offer it signed, evaluates the full policy set, and only then moves money on Razorpay. Returns the outcome, the deciding rule, and every rule that was evaluated — including the ones that passed.",
    inputSchema: {
      intentMandate: z.unknown().describe("SignedIntentMandate, exactly as issued by the principal"),
      cartMandate: z.unknown().describe("SignedCartMandate, signed by the agent"),
      approval: z
        .unknown()
        .optional()
        .describe(
          "SignedApproval — required when the cart total is at or above the mandate's approval threshold. Collect it on your side from the human and send it here; the merchant verifies the signature covers this exact cart and amount.",
        ),
    },
  },
  async ({ intentMandate, cartMandate, approval }) => {
    const intent = intentMandate as SignedIntentMandate;
    const cart = cartMandate as SignedCartMandate;
    const offers = new Map<string, SignedOffer>();
    for (const line of cart.mandate?.lines ?? []) {
      const so = issuedOffers.get(line.offerId);
      if (so) offers.set(line.offerId, so);
    }

    const result = await app.engine.execute({
      intent,
      cart,
      offers,
      approval: approval as SignedApproval | undefined,
    });
    return ok({
      outcome: result.outcome,
      decidingRule: result.decision.decidingRule,
      verdict: result.decision.verdict,
      total: fmt(result.totalPaise),
      orderId: result.orderId,
      paymentId: result.paymentId,
      refundId: result.refundId,
      failureReason: result.failureReason,
      rules: result.decision.rules,
      auditLedgerEntries: result.ledgerSeqs,
    });
  },
);

server.registerTool(
  "get_audit_trail",
  {
    title: "Read the audit trail for one cart",
    description:
      "Every entry the hash-chained ledger holds for a cart mandate, in order — request, policy evaluation with all rules, approval, order, authorization, capture or reconciliation. This is the record the merchant and the buyer can both check.",
    inputSchema: { cartMandateId: z.string() },
  },
  async ({ cartMandateId }) => {
    const entries = app.ledger.forSubject(cartMandateId);
    const chain = app.ledger.verify();
    return ok({ cartMandateId, chainIntact: chain.ok, entries });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[${MERCHANT_NAME}] MCP server ready on stdio · gateway=${app.gateway.mode} · ${CATALOG.length} SKUs`);
