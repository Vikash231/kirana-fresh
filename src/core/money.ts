/** All money is integer paise (1 INR = 100 paise), matching Razorpay's `amount` field. */
export type Paise = number;

export const rupees = (r: number): Paise => Math.round(r * 100);
export const fmt = (p: Paise): string =>
  `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Tax in basis points (1800 = 18% GST), rounded half-up to the paise. */
export const taxOn = (base: Paise, bps: number): Paise => Math.round((base * bps) / 10_000);

export function assertPaise(n: number, label: string): Paise {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer paise, got ${n}`);
  return n;
}
