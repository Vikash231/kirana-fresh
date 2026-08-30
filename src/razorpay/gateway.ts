import type { Paise } from "../core/money.js";

export interface RzpOrder {
  id: string;
  amount: Paise;
  amount_paid: Paise;
  currency: "INR";
  receipt: string;
  status: "created" | "attempted" | "paid";
  notes: Record<string, string>;
}

export interface RzpPayment {
  id: string;
  order_id: string;
  amount: Paise;
  currency: "INR";
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  error_code?: string;
  error_description?: string;
}

export interface RzpRefund {
  id: string;
  payment_id: string;
  amount: Paise;
  status: "processed" | "pending" | "failed";
}

export type AuthorizeResult =
  | { kind: "authorized"; payment: RzpPayment }
  | { kind: "failed"; code: string; description: string }
  /** Authorization was initiated but the outcome is unknown to us — the orphan case. */
  | { kind: "indeterminate"; description: string }
  /** Live mode: the buyer must complete authorization out-of-band. */
  | { kind: "pending_external"; url: string; referenceId: string };

/**
 * The subset of Razorpay we touch. Both the fake and the live adapter satisfy it,
 * so the gate, the reconciler, and the batch harness are identical in either mode.
 */
export interface RazorpayGateway {
  readonly mode: "fake" | "live";
  createOrder(args: { amountPaise: Paise; receipt: string; idempotencyKey: string; notes: Record<string, string> }): Promise<RzpOrder>;
  authorize(args: { orderId: string; amountPaise: Paise; idempotencyKey: string }): Promise<AuthorizeResult>;
  capture(args: { paymentId: string; amountPaise: Paise; idempotencyKey: string }): Promise<RzpPayment>;
  refund(args: { paymentId: string; amountPaise: Paise; idempotencyKey: string }): Promise<RzpRefund>;
  fetchOrder(orderId: string): Promise<RzpOrder>;
  /** Payments Razorpay knows about for this order — the reconciler's source of truth. */
  fetchOrderPayments(orderId: string): Promise<RzpPayment[]>;
}
