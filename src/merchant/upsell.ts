import type { Keypair } from "../core/crypto.js";
import { fmt, type Paise } from "../core/money.js";
import type { CartLine, SignedOffer } from "../core/types.js";
import { bySku, CATALOG } from "./catalog.js";
import { quote } from "./quote.js";

/** SKUs that genuinely complete a basket, not just anything with margin. */
const COMPLEMENTS: Record<string, string[]> = {
  "GRC-ATTA-5KG": ["GRC-OIL-1L", "GRC-DAL-1KG"],
  "GRC-RICE-5KG": ["GRC-DAL-1KG", "GRC-OIL-1L"],
  "GRC-DAL-1KG": ["GRC-RICE-5KG", "GRC-OIL-1L"],
  "GRC-OIL-1L": ["GRC-ATTA-5KG"],
  "GRC-TEA-500G": ["PCR-SOAP-4X125"],
  "HHD-DETRG-2KG": ["HHD-DISH-750ML"],
  "HHD-DISH-750ML": ["HHD-DETRG-2KG"],
  "ELC-KETTLE-1L": ["GRC-TEA-500G"],
  "ELC-MIXER-750W": ["ELC-KETTLE-1L"],
};

export interface UpsellProposal {
  offer: SignedOffer;
  rationale: string;
  /** The merchant's own self-imposed bound, echoed so the buyer can check it. */
  capPaise: Paise;
}

export interface UpsellContext {
  lines: CartLine[];
  /** What the buyer told us it may still spend. The merchant never sees the mandate. */
  declaredHeadroomPaise: Paise;
  allowedCategories: string[];
  /** Fraction of headroom an upsell may consume. Merchant policy, bounded by design. */
  maxFractionOfHeadroom?: number;
  /**
   * A merchant optimising for its own basket size rather than the buyer's
   * comfort: proposes the most valuable eligible add-on and ignores the
   * headroom the buyer declared. Nothing stops a real merchant behaving this
   * way, which is exactly why the buyer's gate cannot be optional.
   */
  greedy?: boolean;
}

/**
 * Revenue growth, bounded at the source. The merchant proposes at most one
 * add-on, capped as a fraction of the headroom the buyer declared and confined
 * to categories the buyer said it can accept. The buyer's policy engine checks
 * it again anyway — this cap is courtesy, the gate is enforcement.
 */
export function proposeUpsell(kp: Keypair, ctx: UpsellContext): UpsellProposal | null {
  const fraction = ctx.maxFractionOfHeadroom ?? 0.5;
  const capPaise = Math.floor(ctx.declaredHeadroomPaise * fraction);
  if (capPaise <= 0) return null;

  const inCart = new Set(ctx.lines.map((l) => l.sku));
  const candidateSkus = [
    ...new Set(ctx.lines.flatMap((l) => COMPLEMENTS[l.sku] ?? []).filter((s) => !inCart.has(s))),
  ];

  const candidates = (candidateSkus.length > 0 ? candidateSkus : CATALOG.map((c) => c.sku))
    .map((sku) => bySku(sku))
    .filter((i): i is NonNullable<typeof i> => Boolean(i))
    .filter((i) => !inCart.has(i.sku) && i.inStock > 0)
    .filter((i) => ctx.allowedCategories.includes(i.category))
    // Polite: cheapest first, because an upsell that fits is worth more than one
    // that gets refused. Greedy: dearest first, and the cap is ignored below.
    .sort((a, b) => (ctx.greedy ? b.unitPaise - a.unitPaise : a.unitPaise - b.unitPaise));

  for (const item of candidates) {
    // A maximising merchant pushes a bulk quantity sized to the headroom it was
    // told about — and then one unit past it. Perfectly ordinary retail
    // behaviour, and precisely why the buyer's cap has to be enforced rather
    // than requested politely.
    const qty = ctx.greedy
      ? Math.max(1, Math.min(item.inStock, Math.ceil(ctx.declaredHeadroomPaise / item.unitPaise) + 1))
      : 1;
    const offer = quote(kp, item.sku, qty);
    if (ctx.greedy || offer.offer.totalPaise <= capPaise) {
      const because = candidateSkus.includes(item.sku)
        ? `pairs with ${ctx.lines.find((l) => (COMPLEMENTS[l.sku] ?? []).includes(item.sku))?.title ?? "your basket"}`
        : "frequently bought at this basket size";
      return {
        offer,
        rationale: ctx.greedy
          ? `${item.title} — ${because}. ${fmt(offer.offer.totalPaise)}, ignoring the ${fmt(capPaise)} add-on cap.`
          : `${item.title} — ${because}. ${fmt(offer.offer.totalPaise)}, within the ${fmt(capPaise)} add-on cap.`,
        capPaise,
      };
    }
  }
  return null;
}
