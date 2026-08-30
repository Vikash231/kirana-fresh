import type { Keypair } from "../core/crypto.js";
import { issueCartMandate } from "../core/mandate.js";
import type { CartLine, SignedCartMandate, SignedIntentMandate, SignedOffer } from "../core/types.js";
import { MERCHANT_ID, search } from "../merchant/catalog.js";
import { quote } from "../merchant/quote.js";
import { proposeUpsell } from "../merchant/upsell.js";

export interface PlanRequest {
  /** What the human asked for, as SKU + qty pairs or a free-text category sweep. */
  want: Array<{ sku: string; qty: number }>;
  acceptUpsell: boolean;
  /** Let the merchant propose past the declared headroom, so the gate is exercised. */
  greedyMerchant?: boolean;
}

export interface Plan {
  cart: SignedCartMandate;
  offers: Map<string, SignedOffer>;
  /** The merchant made a proposal at all. */
  upsellProposed: boolean;
  upsellAccepted: boolean;
  /** Rupees the accepted add-on contributed to this cart. */
  upsellPaise: number;
  upsellRejectedReason?: string;
}

/**
 * Deterministic buyer, used for the evidence batch. It makes the same
 * discover -> quote -> (consider upsell) -> sign-cart moves as the LLM agent,
 * minus the language. Money decisions are identical either way: both hand the
 * signed cart to the same gate.
 */
export function planCart(
  agentKp: Keypair,
  merchantKp: Keypair,
  intent: SignedIntentMandate,
  req: PlanRequest,
): Plan {
  const offers = new Map<string, SignedOffer>();
  const lines: CartLine[] = [];

  for (const w of req.want) {
    const so = quote(merchantKp, w.sku, w.qty);
    offers.set(so.offer.offerId, so);
    lines.push({
      sku: so.offer.sku,
      title: so.offer.title,
      qty: so.offer.qty,
      unitPaise: so.offer.unitPaise,
      totalPaise: so.offer.totalPaise,
      offerId: so.offer.offerId,
      category: so.offer.category,
    });
  }

  let upsellProposed = false;
  let upsellAccepted = false;
  let upsellPaise = 0;
  let upsellRejectedReason: string | undefined;

  if (req.acceptUpsell) {
    const im = intent.mandate;
    const subtotal = lines.reduce((s, l) => s + l.totalPaise, 0);
    const headroom = Math.min(im.perTxnCapPaise, im.budgetPaise) - subtotal;
    const proposal = headroom > 0
      ? proposeUpsell(merchantKp, {
          lines,
          declaredHeadroomPaise: headroom,
          allowedCategories: im.categoriesAllowed,
          greedy: req.greedyMerchant,
        })
      : null;

    if (!proposal) {
      upsellRejectedReason = headroom <= 0 ? "no headroom left under the mandate" : "no eligible add-on within the cap";
    } else {
      upsellProposed = true;
      const wouldTotal = subtotal + proposal.offer.offer.totalPaise;
      // The buyer's own pre-check. The gate re-checks anyway — this only saves a
      // round trip, it is never the thing that keeps us inside the mandate.
      if (wouldTotal > im.perTxnCapPaise) {
        upsellRejectedReason = `add-on would take the cart to ${wouldTotal} paise, past the per-transaction cap of ${im.perTxnCapPaise}`;
      } else {
        offers.set(proposal.offer.offer.offerId, proposal.offer);
        lines.push({
          sku: proposal.offer.offer.sku,
          title: proposal.offer.offer.title,
          qty: proposal.offer.offer.qty,
          unitPaise: proposal.offer.offer.unitPaise,
          totalPaise: proposal.offer.offer.totalPaise,
          offerId: proposal.offer.offer.offerId,
          category: proposal.offer.offer.category,
        });
        upsellAccepted = true;
        upsellPaise = proposal.offer.offer.totalPaise;
      }
    }
  }

  const cart = issueCartMandate(agentKp, {
    intentMandateId: intent.mandate.mandateId,
    agentId: intent.mandate.agentId,
    merchantId: MERCHANT_ID,
    lines,
  });

  return { cart, offers, upsellProposed, upsellAccepted, upsellPaise, upsellRejectedReason };
}

/**
 * Helper for the batch: pick a basket by index, deterministically.
 * Restricted to the mandate's categories so a "clean" case is genuinely clean —
 * the deliberate breaches below are what should produce policy denials.
 */
export function basketFor(i: number, categories: string[] = ["groceries", "household", "personal_care"]): Array<{ sku: string; qty: number }> {
  const pool = categories.flatMap((c) => search({ category: c, limit: 50 }));
  const a = pool[i % pool.length]!;
  const b = pool[(i * 7 + 3) % pool.length]!;
  if (a.sku === b.sku) return [{ sku: a.sku, qty: 1 + (i % 3) }];
  return [
    { sku: a.sku, qty: 1 + (i % 3) },
    { sku: b.sku, qty: 1 + ((i + 1) % 2) },
  ];
}
