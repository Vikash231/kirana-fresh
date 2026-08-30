import { randomUUID } from "node:crypto";
import { signPayload, type Keypair } from "../core/crypto.js";
import { taxOn } from "../core/money.js";
import type { Offer, SignedOffer } from "../core/types.js";
import { bySku, MERCHANT_ID } from "./catalog.js";

/** How long a quoted price is honoured. Short enough that stale prices die at the gate. */
export const OFFER_TTL_SECONDS = 300;

export function quote(kp: Keypair, sku: string, qty: number, opts: { ttlSeconds?: number } = {}): SignedOffer {
  const item = bySku(sku);
  if (!item) throw new Error(`unknown sku: ${sku}`);
  if (qty < 1 || !Number.isInteger(qty)) throw new Error(`qty must be a positive integer, got ${qty}`);
  if (qty > item.inStock) throw new Error(`insufficient stock for ${sku}: requested ${qty}, available ${item.inStock}`);

  const subtotalPaise = item.unitPaise * qty;
  const taxPaise = taxOn(subtotalPaise, item.taxBps);
  const offer: Offer = {
    offerId: `off_${randomUUID().slice(0, 12)}`,
    merchantId: MERCHANT_ID,
    sku: item.sku,
    title: item.title,
    qty,
    unitPaise: item.unitPaise,
    subtotalPaise,
    taxPaise,
    totalPaise: subtotalPaise + taxPaise,
    currency: "INR",
    category: item.category,
    expiresAt: new Date(Date.now() + (opts.ttlSeconds ?? OFFER_TTL_SECONDS) * 1000).toISOString(),
    terms: `Price valid until expiry. GST ${item.taxBps / 100}% included. Returns accepted within 7 days of delivery.`,
  };
  return { offer, merchantSig: signPayload(kp, offer), merchantKeyId: kp.id };
}
