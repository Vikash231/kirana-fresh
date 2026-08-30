/**
 * Deterministic JSON: object keys sorted recursively. Signatures and the ledger
 * hash chain are computed over this, so byte-identical payloads always hash the same.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(sort(value));
}

function sort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sort(src[k]);
    return out;
  }
  return v;
}
