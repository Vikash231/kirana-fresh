import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { canonical } from "./canonical.js";
import { sha256 } from "./crypto.js";

export interface LedgerEntry {
  seq: number;
  ts: string;
  /** Who caused this. `human:*`, `agent:*`, `merchant:*`, or `system:*`. */
  actor: string;
  action: string;
  /** The cart mandate this entry belongs to, so a whole transaction is one grep. */
  subjectId: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

/**
 * Append-only, hash-chained audit log. Every money action writes here before and
 * after it happens; `verify()` proves nothing was edited or dropped after the fact.
 */
export class Ledger {
  private entries: LedgerEntry[] = [];

  constructor(private readonly path: string, opts: { truncate?: boolean } = {}) {
    mkdirSync(dirname(path), { recursive: true });
    if (opts.truncate && existsSync(path)) rmSync(path);
    if (existsSync(path)) {
      this.entries = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as LedgerEntry);
    }
  }

  append(e: Omit<LedgerEntry, "seq" | "ts" | "prevHash" | "hash">): LedgerEntry {
    const prevHash = this.entries.at(-1)?.hash ?? GENESIS;
    const body = { seq: this.entries.length, ts: new Date().toISOString(), prevHash, ...e };
    const entry: LedgerEntry = { ...body, hash: sha256(prevHash + canonical(body)) };
    this.entries.push(entry);
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    return entry;
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  forSubject(subjectId: string): LedgerEntry[] {
    return this.entries.filter((e) => e.subjectId === subjectId);
  }

  /** Recompute the chain. Returns the first broken link, or null if intact. */
  verify(): { ok: true; length: number } | { ok: false; brokenAtSeq: number; detail: string } {
    let prevHash = GENESIS;
    for (const e of this.entries) {
      if (e.prevHash !== prevHash) {
        return { ok: false, brokenAtSeq: e.seq, detail: `prevHash mismatch: expected ${prevHash}, found ${e.prevHash}` };
      }
      const { hash, ...body } = e;
      const recomputed = sha256(prevHash + canonical(body));
      if (recomputed !== hash) {
        return { ok: false, brokenAtSeq: e.seq, detail: `entry hash mismatch: recomputed ${recomputed}, stored ${hash}` };
      }
      prevHash = hash;
    }
    return { ok: true, length: this.entries.length };
  }
}
