import { FakeRazorpay, type FakeConfig } from "./fake.js";
import type { RazorpayGateway } from "./gateway.js";
import { LiveRazorpay } from "./live.js";

export * from "./gateway.js";
export { FakeRazorpay } from "./fake.js";
export type { FakeConfig, FaultMode } from "./fake.js";

/**
 * Live when test-mode keys are present, fake otherwise. The batch harness always
 * forces the fake — fault injection is what makes the failure numbers meaningful.
 */
export function makeGateway(opts: { forceFake?: boolean; fake?: FakeConfig } = {}): RazorpayGateway {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!opts.forceFake && id && secret && id.startsWith("rzp_test_")) {
    return new LiveRazorpay(id, secret);
  }
  if (!opts.forceFake && id && !id.startsWith("rzp_test_")) {
    throw new Error("Refusing to run: RAZORPAY_KEY_ID is not a test-mode key (expected rzp_test_ prefix).");
  }
  return new FakeRazorpay(opts.fake ?? { seed: 42, faultRates: {} });
}
