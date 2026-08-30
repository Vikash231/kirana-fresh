import { randomUUID } from "node:crypto";
import type { Paise } from "../core/money.js";
import type { AuthorizeResult, RazorpayGateway, RzpOrder, RzpPayment, RzpRefund } from "./gateway.js";

export type FaultMode = "none" | "declined" | "indeterminate_authorize" | "capture_failed";

/** Deterministic PRNG so a batch run is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FakeConfig {
  seed: number;
  /** Probability of each fault per transaction. Remainder is a clean success. */
  faultRates: Partial<Record<Exclude<FaultMode, "none">, number>>;
}

/**
 * Mirrors the Razorpay API shape closely enough that swapping in the live
 * adapter changes no calling code — and lets us inject the failures a live
 * test account will not produce on demand.
 */
export class FakeRazorpay implements RazorpayGateway {
  readonly mode = "fake" as const;
  private readonly rand: () => number;
  private readonly orders = new Map<string, RzpOrder>();
  private readonly payments = new Map<string, RzpPayment>();
  private readonly refunds = new Map<string, RzpRefund>();
  private readonly byIdempotency = new Map<string, string>();
  /** Payments the gateway holds that the caller may never have learned about. */
  private readonly orderPayments = new Map<string, string[]>();

  private forced: FaultMode | null = null;

  constructor(private readonly cfg: FakeConfig) {
    this.rand = mulberry32(cfg.seed);
  }

  /** Force the next fault roll. Used by the demo to stage a specific failure. */
  forceNextFault(mode: FaultMode): void {
    this.forced = mode;
  }

  private rollFault(): FaultMode {
    if (this.forced !== null) {
      const f = this.forced;
      this.forced = null;
      return f;
    }
    const r = this.rand();
    let acc = 0;
    for (const [mode, rate] of Object.entries(this.cfg.faultRates)) {
      acc += rate ?? 0;
      if (r < acc) return mode as FaultMode;
    }
    return "none";
  }

  async createOrder(args: { amountPaise: Paise; receipt: string; idempotencyKey: string; notes: Record<string, string> }): Promise<RzpOrder> {
    const existing = this.byIdempotency.get(`order:${args.idempotencyKey}`);
    if (existing) return this.orders.get(existing)!;

    const order: RzpOrder = {
      id: `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      amount: args.amountPaise,
      amount_paid: 0,
      currency: "INR",
      receipt: args.receipt,
      status: "created",
      notes: args.notes,
    };
    this.orders.set(order.id, order);
    this.byIdempotency.set(`order:${args.idempotencyKey}`, order.id);
    return order;
  }

  async authorize(args: { orderId: string; amountPaise: Paise; idempotencyKey: string }): Promise<AuthorizeResult> {
    const order = this.orders.get(args.orderId);
    if (!order) return { kind: "failed", code: "BAD_REQUEST_ERROR", description: "order not found" };

    const fault = this.rollFault();
    if (fault === "declined") {
      order.status = "attempted";
      return { kind: "failed", code: "GATEWAY_ERROR", description: "Payment was declined by the issuing bank" };
    }

    // The payment exists at Razorpay either way — that is what makes the
    // indeterminate case dangerous, and what the reconciler is for.
    const payment: RzpPayment = {
      id: `pay_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      order_id: order.id,
      amount: args.amountPaise,
      currency: "INR",
      status: "authorized",
    };
    this.payments.set(payment.id, payment);
    this.orderPayments.set(order.id, [...(this.orderPayments.get(order.id) ?? []), payment.id]);
    order.status = "attempted";

    if (fault === "indeterminate_authorize") {
      return { kind: "indeterminate", description: "network timeout after authorization was sent" };
    }
    return { kind: "authorized", payment };
  }

  async capture(args: { paymentId: string; amountPaise: Paise; idempotencyKey: string }): Promise<RzpPayment> {
    const payment = this.payments.get(args.paymentId);
    if (!payment) throw new Error(`payment ${args.paymentId} not found`);
    if (payment.status === "captured") return payment; // idempotent

    if (this.rollFault() === "capture_failed") {
      payment.status = "failed";
      payment.error_code = "SERVER_ERROR";
      payment.error_description = "capture failed at the gateway";
      throw Object.assign(new Error(payment.error_description), { code: payment.error_code });
    }

    payment.status = "captured";
    const order = this.orders.get(payment.order_id);
    if (order) {
      order.amount_paid = payment.amount;
      order.status = "paid";
    }
    return payment;
  }

  async refund(args: { paymentId: string; amountPaise: Paise; idempotencyKey: string }): Promise<RzpRefund> {
    const existing = this.byIdempotency.get(`refund:${args.idempotencyKey}`);
    if (existing) return this.refunds.get(existing)!;

    const payment = this.payments.get(args.paymentId);
    if (!payment) throw new Error(`payment ${args.paymentId} not found`);

    const refund: RzpRefund = {
      id: `rfnd_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      payment_id: payment.id,
      amount: args.amountPaise,
      status: "processed",
    };
    payment.status = "refunded";
    this.refunds.set(refund.id, refund);
    this.byIdempotency.set(`refund:${args.idempotencyKey}`, refund.id);
    return refund;
  }

  async fetchOrder(orderId: string): Promise<RzpOrder> {
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`order ${orderId} not found`);
    return o;
  }

  async fetchOrderPayments(orderId: string): Promise<RzpPayment[]> {
    return (this.orderPayments.get(orderId) ?? []).map((id) => this.payments.get(id)!);
  }
}
