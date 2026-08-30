import type { Ledger } from "../core/ledger.js";
import { fmt, type Paise } from "../core/money.js";
import type { RazorpayGateway } from "../razorpay/gateway.js";

export interface ReconcileRequest {
  subjectId: string;
  orderId: string;
  expectedPaise: Paise;
  idempotencyKey: string;
  cause: string;
}

export type ReconcileOutcome =
  | { kind: "nothing_to_do"; detail: string }
  | { kind: "compensated"; refundId: string; paymentId: string; amountPaise: Paise }
  | { kind: "unrecovered"; detail: string };

/**
 * The safety net for money we may have moved without knowing it.
 *
 * When authorization returns indeterminate, or capture throws, we do not guess.
 * We ask Razorpay what payments it actually holds for the order and compensate
 * anything we cannot account for — idempotently, so re-running is free.
 */
export class Reconciler {
  constructor(
    private readonly gateway: RazorpayGateway,
    private readonly ledger: Ledger,
  ) {}

  async reconcile(req: ReconcileRequest): Promise<ReconcileOutcome> {
    this.ledger.append({
      actor: "system:reconciler",
      action: "recon.started",
      subjectId: req.subjectId,
      payload: { orderId: req.orderId, cause: req.cause, expected: fmt(req.expectedPaise) },
    });

    let payments;
    try {
      payments = await this.gateway.fetchOrderPayments(req.orderId);
    } catch (err) {
      const detail = `could not read payments for ${req.orderId}: ${(err as Error).message}`;
      this.ledger.append({
        actor: "system:reconciler",
        action: "recon.unrecovered",
        subjectId: req.subjectId,
        payload: { orderId: req.orderId, detail },
      });
      return { kind: "unrecovered", detail };
    }

    const stranded = payments.filter((p) => p.status === "authorized" || p.status === "captured");
    if (stranded.length === 0) {
      const detail = "gateway holds no authorized or captured payment for this order — no money moved";
      this.ledger.append({
        actor: "system:reconciler",
        action: "recon.clean",
        subjectId: req.subjectId,
        payload: { orderId: req.orderId, detail, paymentsSeen: payments.length },
      });
      return { kind: "nothing_to_do", detail };
    }

    // One stranded payment is the expected case; more than one means the caller
    // retried without an idempotency key, which is itself worth flagging loudly.
    const target = stranded[0]!;
    this.ledger.append({
      actor: "system:reconciler",
      action: "recon.orphan_detected",
      subjectId: req.subjectId,
      payload: {
        orderId: req.orderId,
        paymentId: target.id,
        status: target.status,
        amount: fmt(target.amount),
        strandedCount: stranded.length,
      },
    });

    try {
      const refund = await this.gateway.refund({
        paymentId: target.id,
        amountPaise: target.amount,
        idempotencyKey: `void_${req.idempotencyKey}`,
      });
      this.ledger.append({
        actor: "system:reconciler",
        action: "recon.compensated",
        subjectId: req.subjectId,
        payload: { orderId: req.orderId, paymentId: target.id, refundId: refund.id, amount: fmt(refund.amount) },
      });
      return { kind: "compensated", refundId: refund.id, paymentId: target.id, amountPaise: refund.amount };
    } catch (err) {
      const detail = `compensating refund failed for ${target.id}: ${(err as Error).message}`;
      this.ledger.append({
        actor: "system:reconciler",
        action: "recon.unrecovered",
        subjectId: req.subjectId,
        payload: { orderId: req.orderId, paymentId: target.id, detail },
      });
      return { kind: "unrecovered", detail };
    }
  }
}
