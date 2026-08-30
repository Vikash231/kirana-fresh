import Razorpay from "razorpay";
import type { Paise } from "../core/money.js";
import type { AuthorizeResult, RazorpayGateway, RzpOrder, RzpPayment, RzpRefund } from "./gateway.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Live test-mode adapter.
 *
 * One deliberate difference from the fake: authorization is buyer-side. Razorpay
 * has no server-side "charge this card now" call, so `authorize` creates a
 * Payment Link and returns `pending_external` with its URL — the AI buyer (or a
 * human) completes it, and the reconciler picks the payment up from the link.
 * Everything downstream — capture, refund, reconciliation — is the real API.
 *
 * The Payment Link is the order primitive here precisely because it is the one
 * Razorpay object that is both order-backed and completable without a browser SDK.
 */
export class LiveRazorpay implements RazorpayGateway {
  readonly mode = "live" as const;
  private readonly rzp: any;

  constructor(keyId: string, keySecret: string) {
    this.rzp = new (Razorpay as any)({ key_id: keyId, key_secret: keySecret });
  }

  async createOrder(args: {
    amountPaise: Paise;
    receipt: string;
    idempotencyKey: string;
    notes: Record<string, string>;
  }): Promise<RzpOrder> {
    const link = await this.rzp.paymentLink.create({
      amount: args.amountPaise,
      currency: "INR",
      accept_partial: false,
      // Razorpay rejects a duplicate reference_id, which gives us idempotency for free.
      reference_id: args.idempotencyKey,
      description: args.receipt,
      notes: args.notes,
      reminder_enable: false,
    });
    return this.toOrder(link);
  }

  async authorize(args: { orderId: string; amountPaise: Paise; idempotencyKey: string }): Promise<AuthorizeResult> {
    const link = await this.rzp.paymentLink.fetch(args.orderId);
    const paid = (link.payments ?? []).find((p: any) => p.status === "captured" || p.status === "authorized");
    if (paid) {
      return {
        kind: "authorized",
        payment: {
          id: paid.payment_id ?? paid.id,
          order_id: args.orderId,
          amount: paid.amount,
          currency: "INR",
          status: paid.status,
        },
      };
    }
    return { kind: "pending_external", url: link.short_url, referenceId: link.reference_id };
  }

  async capture(args: { paymentId: string; amountPaise: Paise }): Promise<RzpPayment> {
    const p = await this.rzp.payments.capture(args.paymentId, args.amountPaise, "INR");
    return this.toPayment(p);
  }

  async refund(args: { paymentId: string; amountPaise: Paise; idempotencyKey: string }): Promise<RzpRefund> {
    const r = await this.rzp.payments.refund(args.paymentId, {
      amount: args.amountPaise,
      speed: "normal",
      notes: { idempotency_key: args.idempotencyKey },
    });
    return { id: r.id, payment_id: r.payment_id, amount: r.amount, status: r.status };
  }

  async fetchOrder(orderId: string): Promise<RzpOrder> {
    return this.toOrder(await this.rzp.paymentLink.fetch(orderId));
  }

  async fetchOrderPayments(orderId: string): Promise<RzpPayment[]> {
    const link = await this.rzp.paymentLink.fetch(orderId);
    return (link.payments ?? []).map((p: any) => ({
      id: p.payment_id ?? p.id,
      order_id: orderId,
      amount: p.amount,
      currency: "INR" as const,
      status: p.status,
    }));
  }

  private toOrder(link: any): RzpOrder {
    return {
      id: link.id,
      amount: link.amount,
      amount_paid: link.amount_paid ?? 0,
      currency: "INR",
      receipt: link.description ?? "",
      status: link.status === "paid" ? "paid" : link.amount_paid > 0 ? "attempted" : "created",
      notes: link.notes ?? {},
    };
  }

  private toPayment(p: any): RzpPayment {
    return {
      id: p.id,
      order_id: p.order_id,
      amount: p.amount,
      currency: "INR",
      status: p.status,
      error_code: p.error_code ?? undefined,
      error_description: p.error_description ?? undefined,
    };
  }
}
