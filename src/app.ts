import { join } from "node:path";
import { CheckoutEngine } from "./core/checkout.js";
import { bootstrapKeys, type Keyring } from "./core/keyring.js";
import { Ledger } from "./core/ledger.js";
import { SpendBook } from "./core/policy.js";
import type { Keypair } from "./core/crypto.js";
import { makeGateway } from "./razorpay/index.js";
import type { FakeConfig } from "./razorpay/fake.js";
import type { RazorpayGateway } from "./razorpay/gateway.js";

export interface App {
  keyring: Keyring;
  principal: Keypair;
  agent: Keypair;
  merchant: Keypair;
  ledger: Ledger;
  gateway: RazorpayGateway;
  spendBook: SpendBook;
  engine: CheckoutEngine;
}

export function buildApp(opts: { ledgerFile: string; forceFake?: boolean; fake?: FakeConfig; truncateLedger?: boolean }): App {
  const { keyring, principal, agent, merchant } = bootstrapKeys();
  const ledger = new Ledger(join(process.cwd(), "audit", opts.ledgerFile), { truncate: opts.truncateLedger });
  const gateway = makeGateway({ forceFake: opts.forceFake, fake: opts.fake });
  const spendBook = new SpendBook();
  const engine = new CheckoutEngine(gateway, ledger, keyring, spendBook);
  return { keyring, principal, agent, merchant, ledger, gateway, spendBook, engine };
}
