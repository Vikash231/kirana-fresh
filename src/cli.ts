import { buildApp } from "./app.js";
import { issueIntentMandate, signApproval } from "./core/mandate.js";
import { fmt, rupees } from "./core/money.js";
import type { ApprovalHandler } from "./core/checkout.js";
import { MERCHANT_ID, MERCHANT_NAME } from "./merchant/catalog.js";
import { planCart } from "./buyer/planner.js";
import { runBatch, writeReport } from "./bench/batch.js";
import type { FakeRazorpay } from "./razorpay/fake.js";
import { Ledger } from "./core/ledger.js";
import { join } from "node:path";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const verdictColor = (v: string) => (v === "ALLOW" ? green(v) : v === "DENY" ? red(v) : yellow(v));

async function demo() {
  const app = buildApp({
    ledgerFile: "demo.jsonl",
    forceFake: true,
    truncateLedger: true,
    fake: { seed: 7, faultRates: {} },
  });
  console.log(bold(`\nAgentic Commerce Rails — ${MERCHANT_NAME} (${app.gateway.mode} gateway)\n`));

  // 1. The human signs a mandate. This is the only human authorization step.
  const intent = issueIntentMandate(app.principal, {
    principalId: "asha.menon",
    agentId: "agent-buyer-01",
    purpose: "Weekly household restock",
    merchantAllowlist: [MERCHANT_ID],
    categoriesAllowed: ["groceries", "household"],
    budgetPaise: rupees(5_000),
    perTxnCapPaise: rupees(1_500),
    approvalThresholdPaise: rupees(1_200),
    ttlMinutes: 30,
  });
  const im = intent.mandate;
  console.log(`${bold("1. Human signs an intent mandate")} ${dim(im.mandateId)}`);
  console.log(`   budget ${fmt(im.budgetPaise)} · per-txn cap ${fmt(im.perTxnCapPaise)} · approval at ${fmt(im.approvalThresholdPaise)}`);
  console.log(`   merchants ${im.merchantAllowlist.join(", ")} · categories ${im.categoriesAllowed.join(", ")}\n`);

  const approvalHandler: ApprovalHandler = async ({ cart, summary }) => {
    console.log(`   ${yellow("⇧ escalated to human")}: ${summary} → approved`);
    return {
      approved: true,
      approval: signApproval(app.principal, {
        cartMandateId: cart.mandate.cartMandateId,
        intentMandateId: cart.mandate.intentMandateId,
        approvedTotalPaise: cart.mandate.totalPaise,
        approver: "asha.menon",
        reason: "matches the weekly restock I asked for",
      }),
    };
  };

  // 2. Clean purchase, with the merchant's bounded upsell in play.
  console.log(bold("2. Agent shops, merchant upsells, gate decides"));
  const plan = planCart(app.agent, app.merchant, intent, {
    want: [{ sku: "GRC-ATTA-5KG", qty: 1 }],
    acceptUpsell: true,
  });
  for (const l of plan.cart.mandate.lines) console.log(`   · ${l.title} ×${l.qty} — ${fmt(l.totalPaise)} ${dim(l.offerId)}`);
  console.log(
    plan.upsellAccepted
      ? `   ${green("upsell accepted")} — within the mandate`
      : `   ${yellow("upsell refused")} — ${plan.upsellRejectedReason}`,
  );
  const r1 = await app.engine.execute({ intent, cart: plan.cart, offers: plan.offers, approvalHandler });
  printResult(r1);

  // 3. The merchant tries an upsell that would breach the mandate. The buyer's
  //    gate refuses it with a machine-readable reason — the demo's best moment.
  console.log(bold("3. Merchant proposes an out-of-mandate add-on"));
  const overreach = planCart(app.agent, app.merchant, intent, {
    want: [{ sku: "GRC-RICE-5KG", qty: 1 }, { sku: "ELC-KETTLE-1L", qty: 1 }],
    acceptUpsell: false,
  });
  const r2 = await app.engine.execute({ intent, cart: overreach.cart, offers: overreach.offers, approvalHandler });
  printResult(r2);

  // 4. Payment fails mid-flow. The reconciler asks the gateway what actually
  //    happened and compensates what it finds.
  console.log(bold("4. Authorization goes indeterminate mid-payment"));
  (app.gateway as FakeRazorpay).forceNextFault("indeterminate_authorize");
  const plan3 = planCart(app.agent, app.merchant, intent, { want: [{ sku: "HHD-DISH-750ML", qty: 1 }], acceptUpsell: false });
  const r3 = await app.engine.execute({ intent, cart: plan3.cart, offers: plan3.offers, approvalHandler });
  printResult(r3);
  for (const e of app.ledger.forSubject(plan3.cart.mandate.cartMandateId).filter((e) => e.action.startsWith("recon."))) {
    console.log(`   ${dim(`#${e.seq}`)} ${e.action} ${dim(JSON.stringify(e.payload))}`);
  }

  // 5. Replay the completed cart. Idempotency refuses it before any money moves.
  console.log(`\n${bold("5. Replaying a settled cart")}`);
  const r4 = await app.engine.execute({ intent, cart: plan.cart, offers: plan.offers, approvalHandler });
  printResult(r4);

  const v = app.ledger.verify();
  console.log(
    `\n${bold("Audit trail")}: ${app.ledger.all().length} entries · chain ${v.ok ? green("intact") : red(`broken at #${v.brokenAtSeq}`)}`,
  );
  console.log(dim(`   audit/demo.jsonl — run \`npm run audit -- ${plan.cart.mandate.cartMandateId}\` to read one transaction end to end\n`));
}

function printResult(r: Awaited<ReturnType<import("./core/checkout.js").CheckoutEngine["execute"]>>) {
  const ok = r.outcome === "COMPLETED";
  const tag = ok ? green(r.outcome) : r.outcome === "UNRECOVERED" ? red(r.outcome) : yellow(r.outcome);
  console.log(`   → ${tag} · ${fmt(r.totalPaise)} · deciding rule: ${bold(r.decision.decidingRule)}`);
  if (r.failureReason) console.log(`     ${dim(r.failureReason)}`);
  const failing = r.decision.rules.filter((x) => x.verdict !== "ALLOW");
  for (const f of failing) console.log(`     ${verdictColor(f.verdict)} ${f.rule}: ${f.reason}${f.limit ? dim(` (observed ${f.observed} vs limit ${f.limit})`) : ""}`);
  if (r.orderId) console.log(dim(`     order ${r.orderId}${r.paymentId ? ` · payment ${r.paymentId}` : ""}${r.refundId ? ` · refund ${r.refundId}` : ""}`));
  console.log();
}

async function bench() {
  console.log(bold("\nRunning batch of 50 agentic checkouts with injected payment faults…\n"));
  const report = await runBatch();
  const path = writeReport(report);

  console.log(bold("Outcomes"));
  for (const [k, v] of Object.entries(report.outcomes).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${k.padEnd(34)} ${String(v.count).padStart(3)}  ${v.pct.padStart(6)}`);
  }
  console.log(`\n${bold("Refusals, by which gate caught them")}`);
  console.log(`  buyer-side    ${String(report.caughtBy.buyer).padStart(3)}  ${dim("refused locally — never transmitted")}`);
  console.log(`  merchant-side ${String(report.caughtBy.merchant).padStart(3)}  ${dim("refused on arrival — the buyer had been bypassed")}`);
  console.log(`\n${bold("Policy blocks, by deciding rule")}`);
  for (const [k, v] of Object.entries(report.blockedByRule).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(34)} ${String(v).padStart(3)}`);
  }
  console.log(`\n${bold("Money")}`);
  console.log(`  attempted    ${report.money.attempted}`);
  console.log(`  captured     ${report.money.captured}`);
  console.log(`  compensated  ${report.money.compensated}`);
  console.log(`  leaked       ${report.money.leaked === "₹0.00" ? green(report.money.leaked) : red(report.money.leaked)}`);
  console.log(`\n${bold("Upsell performance")}  ${dim("— the revenue-growth half of the track")}`);
  console.log(`  proposed by merchant   ${String(report.upsell.proposed).padStart(3)}`);
  console.log(`  accepted by buyer      ${String(report.upsell.accepted).padStart(3)}`);
  console.log(`  declined — would breach the mandate  ${String(report.upsell.declinedByBuyer).padStart(3)}`);
  console.log(`  revenue on settled carts  ${green(report.upsell.revenueOnCompleted)}  ${dim(`(${report.upsell.upliftPct} of captured)`)}`);
  console.log(`\n${bold("Payment-fault recovery")}`);
  console.log(`  injected failures ${report.faultRecovery.injectedFailures} · recovered ${report.faultRecovery.recovered} · unrecovered ${report.faultRecovery.unrecovered} · ${report.faultRecovery.recoveryPct}`);
  console.log(`\n${bold("Ledger")}  ${report.ledger.intact ? green("chain intact") : red(`broken at #${report.ledger.entries}`)} · ${report.ledger.entries} entries`);
  console.log(dim(`\nFull per-case report: ${path}\n`));
}

function audit(subjectId?: string) {
  const ledger = new Ledger(join(process.cwd(), "audit", process.env.LEDGER ?? "demo.jsonl"));
  const entries = subjectId ? ledger.forSubject(subjectId) : ledger.all();
  if (entries.length === 0) {
    console.log(`no ledger entries${subjectId ? ` for ${subjectId}` : ""}`);
    return;
  }
  for (const e of entries) {
    console.log(`${dim(`#${String(e.seq).padStart(4)} ${e.ts}`)}  ${bold(e.action.padEnd(38))} ${dim(e.actor)}`);
    if (e.action === "policy.evaluated") {
      for (const r of e.payload.rules as Array<{ rule: string; verdict: string; reason: string }>) {
        console.log(`        ${verdictColor(r.verdict).padEnd(20)} ${r.rule.padEnd(28)} ${dim(r.reason)}`);
      }
    } else {
      console.log(`        ${dim(JSON.stringify(e.payload))}`);
    }
  }
}

function verify() {
  const file = process.env.LEDGER ?? "demo.jsonl";
  const ledger = new Ledger(join(process.cwd(), "audit", file));
  const v = ledger.verify();
  if (v.ok) console.log(green(`✔ ${file}: hash chain intact across ${v.length} entries`));
  else console.log(red(`✘ ${file}: chain broken at entry #${v.brokenAtSeq} — ${v.detail}`));
  process.exit(v.ok ? 0 : 1);
}

async function mcpDemo() {
  console.log(bold("\nMerchant over MCP — scripted AI buyer (no LLM)\n"));
  const { scriptedMcpRun } = await import("./buyer/scripted.js");
  await scriptedMcpRun((line) => console.log(`  ${line}`));
  console.log();
}

async function agentDemo(goal?: string) {
  const { runBuyerAgent, MODEL } = await import("./buyer/agent.js");
  const { bootstrapKeys } = await import("./core/keyring.js");
  const { principal, agent } = bootstrapKeys();
  const intent = issueIntentMandate(principal, {
    principalId: "asha.menon",
    agentId: "agent-buyer-01",
    purpose: "Weekly household restock",
    merchantAllowlist: [MERCHANT_ID],
    categoriesAllowed: ["groceries", "household"],
    budgetPaise: rupees(3_000),
    perTxnCapPaise: rupees(1_200),
    approvalThresholdPaise: rupees(1_100),
    ttlMinutes: 30,
  });
  console.log(bold(`\nLLM buyer agent (${MODEL}) shopping over MCP\n`));
  try {
    await runBuyerAgent({
      goal: goal ?? "Restock the kitchen: I need atta and dal for the week. Stay well inside my mandate.",
      intent,
      agentKp: agent,
      principalKp: principal,
      merchantCommand: "npx",
      merchantArgs: ["tsx", "src/merchant/mcp-server.ts"],
      onEvent: (line) => console.log(`  ${line}`),
    });
  } catch (err) {
    console.log(`  ${red("✘")} ${(err as Error).message}`);
    process.exitCode = 1;
  }
  console.log();
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "demo": await demo(); break;
  case "mcp-demo": await mcpDemo(); break;
  case "agent": await agentDemo(arg); break;
  case "bench": await bench(); break;
  case "audit": audit(arg); break;
  case "verify": verify(); break;
  default:
    console.log("usage: tsx src/cli.ts <demo|mcp-demo|agent [goal]|bench|audit [cartMandateId]|verify>");
    process.exit(1);
}
