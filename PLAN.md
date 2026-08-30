# Handover

Everything a developer picking this up on a fresh machine needs: what runs, what
doesn't, which decisions are load-bearing, and what to do next. The README covers
*what this is* and *how to use it* — this file covers *where it stands and why*.

Last verified: 2026-08-31. Every number below is measured on this codebase, not
estimated. Where something is a prediction, it says so.

---

## 1. Get it running (5 minutes)

```bash
git clone https://github.com/Vikash231/kirana-fresh.git
cd kirana-fresh
npm install
npm run demo
```

That works with **zero configuration** — no keys, no accounts. Four of the six
commands do. It was tested from a bare clone with `keys/` and `audit/` deleted;
both regenerate.

Then, in order, to see the whole thing:

```bash
npm run demo       # five scenarios in one process — the fastest tour
npm run mcp-demo   # a real purchase across two processes over MCP
npm run bench      # 50 transactions with injected payment faults
npm run verify     # recompute the ledger hash chain
```

### Credentials, if you want the other two commands

Both are free and neither needs a card.

| Variable | Where | Unlocks |
|---|---|---|
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `npm run agent` — the LLM buyer |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | [razorpay.com](https://razorpay.com) → dashboard is in Test Mode by default → Account & Settings → API Keys | the live test-mode gateway |

Put them in `.env` at the repo root (gitignored). Razorpay test keys work
immediately after signup — no KYC, no business documents.

`npm run bench` deliberately ignores Razorpay keys and always uses the fake
gateway. Fault injection is the entire point of that command, and a live test
account will not produce a timeout-after-authorization on demand.

---

## 2. Decisions that are load-bearing

Change these only deliberately. Each exists for a reason that isn't obvious from
the code alone.

### The model never touches money

The LLM can search, request quotes, and nominate **offer IDs**. It cannot name a
price, sign a cart, or call anything that moves funds. `build_and_submit_cart` is
our code: it assembles the cart from offers the merchant actually signed, runs the
buyer's gate, signs with the agent key, and only then submits.

This is the whole thesis. If you find yourself adding a tool that takes an amount
as a parameter, stop — that reintroduces exactly the failure mode the project
exists to prevent.

A consequence worth knowing: **exactly one file imports an LLM SDK**
(`src/buyer/agent.ts`). Nothing in `core/`, `razorpay/`, `recon/` or `merchant/`
references a model provider. Swapping Gemini for anything else is a one-file
change. It was Claude first and moved to Gemini in about an hour.

### Two gates, run by different parties

The same twelve rules run twice — once in the buyer's process before anything is
transmitted, once inside the merchant's `settle_cart` on arrival.

This looks redundant until you ask what the merchant gate is *for*: a buyer that
has been compromised will not refuse itself. The batch includes a
`rogue_buyer_bypass` scenario that skips the buyer's gate precisely so the
merchant-side number isn't zero. Without those cases the second gate looks
decorative.

### The buyer learns the merchant's key over the wire

`get_merchant_key` exists so the buyer can verify offer signatures without
reading the merchant's key off a shared disk. If both sides share a filesystem,
"the buyer verified the merchant's signature" proves nothing. Don't shortcut this.

### Approval is collected on the buyer's side

The human is the buyer, not the shop. When the amount crosses the mandate's
threshold, the buyer asks the human, the principal's key signs an attestation
bound to **one cart id and one exact amount**, and that signature travels with
the cart. The merchant verifies it rather than trusting that approval happened.

Bound to the amount for a reason — measured:

```
approval covering ₹210.00, replayed onto a ₹430.50 cart
  → APPROVAL_DENIED · "approval covers ₹210.00 but the cart totals ₹430.50"
```

### Everything is integer paise

`1 INR = 100 paise`, matching Razorpay's `amount` field. No floats anywhere in the
money path. `rupees(285)` converts once, at catalog-definition time.

---

## 3. What is actually verified

Measured by running it, not by reading the code.

| | Status |
|---|---|
| `npm run demo` | ✅ five scenarios, chain intact |
| `npm run mcp-demo` | ✅ full purchase across two processes |
| `npm run mcp` | ✅ answers JSON-RPC on stdio, seven tools |
| `npm run bench` | ✅ 50 transactions, numbers below |
| `npm run audit` / `verify` | ✅ including tamper detection |
| `npm run agent` | ✅ Gemini 3.5 Flash-Lite completed a purchase end to end |
| Razorpay live test API | ✅ real Payment Link created — see §5 |
| `tsc --noEmit` | ✅ 26 files, ~3,100 lines, clean |

Batch, seed `20260830`, reproducible:

```
COMPLETED 23 · POLICY_BLOCKED 22 · PAYMENT_FAILED 3 · RECOVERED_VOID 1 · APPROVAL_DENIED 1

Refusals:  buyer-side 20 · merchant-side 3
Money:     attempted ₹71,783 · captured ₹28,525 · compensated ₹1,234 · leaked ₹0.00
Upsell:    25 proposed · 12 accepted (₹2,503 — 8.8% of captured) · 13 refused by the gate
Faults:    4 injected · 4 recovered · 100%
Ledger:    chain intact, 173 entries
```

### What is NOT verified

**There are no tests.** This is the biggest gap and it is not theoretical — the
`category_allowlist` rule was deleted entirely as an experiment and `npm run demo`
still exited 0, because a different rule happened to catch the cart. A silent
security regression, completely invisible. A test suite is ~2 hours: twelve rules,
one assertion each, plus the recovery path. No credentials needed.

**The code has had no adversarial review.** A review was started and died on an
API session limit before producing any findings. Everything verified so far is
behavioural — "it runs and prints the right thing" — which is not the same as
"the code is correct".

---

## 4. Known bugs

### The agent reports "forbidden" as "absent"

Asked to buy an electric kettle, the agent searched only the categories its
mandate allows, found nothing, and told the user:

> *"they do not carry appliances in their catalog"*

False. The merchant stocks 25 (`ELC-KETTLE-1L`), in `electronics`, which the
mandate excludes. The two answers are very different and it gave the wrong one.

**Root cause:** we hide out-of-mandate items from the model, so it cannot tell
"absent" from "forbidden". That is backwards for a project whose thesis is *the
model proposes, the policy engine disposes* — filtering before the model sees
anything is a second, hidden control, and it produced a false statement.

**Fix (~20 min):** let the agent search everything and label what it may not buy.

```
search_products "kettle"
  → Electric kettle, 1 L · ₹1,532.82
    inMandate: false — "electronics" is not in your allowed categories
```

It also unblocks something: the buyer-gate refusal path *inside the agent* has
never fired, because the agent can't construct a refusable cart today.

### Live authorization cannot complete

`authorize()` creates a real Payment Link and returns `pending_external`. Nothing
resumes the flow when the buyer pays, so a live run ends at
`AWAITING_EXTERNAL_AUTHORIZATION` and the ledger's last word is "awaiting" even if
money moved. See §6 for why this is deliberately unbuilt.

---

## 5. Traps already hit — don't pay for these twice

**The MCP SDK does not forward your environment.** It passes only
`HOME/LOGNAME/PATH/SHELL/TERM/USER` to a spawned server. A sound security default,
and it silently starved the merchant of its Razorpay credentials — so a "live" run
fell back to the fake gateway and produced output *indistinguishable from a real
one*. `src/buyer/mcp-client.ts` now forwards the two Razorpay variables explicitly,
and `get_merchant_key` reports `gatewayMode` on the handshake so no run has to
guess. **If you add a credential the merchant needs, add it to that list too.**

**Gemini retires model names quickly.** `gemini-2.5-flash-lite` returns 404 for new
keys; the current one is `gemini-3.5-flash-lite`. If `npm run agent` 404s, that's
why. Override with `GEMINI_MODEL`.

**`.env` needs loading.** Node does not read it automatically — every npm script
carries `tsx --env-file-if-exists=.env`. A new script without that flag silently
sees no keys.

**`keys/` was not gitignored initially.** It is now. It holds Ed25519 private keys;
never commit it. `.env` likewise.

**Live keys change what a demo shows.** With `RAZORPAY_*` set, `mcp-demo` and
`agent` end at `AWAITING_EXTERNAL_AUTHORIZATION` rather than `COMPLETED` — correct,
since authorization is buyer-side, but it reads as a failure on camera. Use
`npm run mcp-demo:fake` / `npm run agent:fake` (`FORCE_FAKE=1`) to show a purchase
completing, and the plain commands to show a real Payment Link being created. A
walkthrough wants both, in that order.

**Razorpay Payment Links return `payments: null`**, not an empty array, when no
payment exists. The `?? []` guard in `live.ts` handles it. Whether it populates
after a real payment is untested — this matters, because `fetchOrderPayments` is
what the reconciler uses to decide whether money moved.

---

## 6. What to do next

In priority order. Effort figures are estimates.

| # | Task | Why | Effort |
|---|---|---|---|
| 1 | **5-minute pitch video** | Submission requirement, not started | — |
| 2 | Fix "forbidden vs absent" (§4) | A wrong answer a judge could hit in one prompt | 20 min |
| 3 | Re-run a code review | ~3,100 lines with no adversarial read | 1 hr |
| 4 | Test suite over the twelve rules | Rules can currently be deleted silently | 2 hrs |
| 5 | Add a LICENSE | Repo has none; MIT is the usual pick | 5 min |
| 6 | `FAULT_MODE` env var on `npm run mcp` | Payment failures aren't reachable over the protocol | 10 min |
| 7 | `payment_link.paid` webhook | Completes live mode — see below | ½ day |

### On #7, and why it's last

It needs a public HTTP server, HMAC signature verification, splitting `execute()`
into two halves with durable state between them, webhook idempotency, and an
abandoned-payment sweep. Six hours, and it is arguably the wrong shape anyway: a
human clicking a payment page is backwards for an *agentic* commerce demo. The
right long-term answer is a UPI autopay or e-mandate so no browser is involved —
which is what NPCI's UAP is about, and what the mandate structure here already
models. That needs merchant onboarding well beyond a buildathon.

The cheaper alternative (~1 hr): register pending orders in a file and add
`npm run reconcile` to sweep them. The reconciler already does the work and is
already idempotent; it just needs a second trigger. That closes the
money-goes-missing hole without building the webhook.

---

## 7. Deliberately not built

Named rather than hidden, because a reviewer will ask.

- **Keys live on disk** under `keys/`. Production keeps the principal's key in the
  user's wallet and the merchant's in an HSM. The agent should hold a key that
  attests to a cart, never one that authorizes spend.
- **One merchant, one currency, one principal.** The policy engine is written to
  generalise; nothing proves that it does.
- **No settlement or refund webhooks.** Reconciliation is pull-based and runs only
  on the failure path. A process that dies between `authorize` and `capture`
  leaves an order nothing will ever sweep.
- **Not wire-compatible with AP2, ACP or x402.** The mandate structure is
  AP2-*shaped* — human-signed intent, agent-signed cart — and that is all.

---

## 8. Repo conventions

- **Commits are unsigned and authored as `Vikash231 <97658160+Vikash231@users.noreply.github.com>`**,
  set repo-locally. If you clone this on a machine with a different global git
  identity, set `user.email` locally before committing or your personal address
  ends up in a public log.
- **TypeScript, Node 22+, ESM.** `tsx` runs sources directly; there is no build step.
- **`npm run typecheck`** before committing. It is currently clean and worth keeping so.
