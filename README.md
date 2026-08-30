# Agentic Commerce Rails

**Razorpay AI Buildathon — Track 01: AI Growth & Agentic Commerce**

A merchant made transactable by an AI buyer end to end, where the product is the
**mandate + policy + audit** layer between them.

> The LLM proposes. The policy engine disposes. Every rupee moves through one
> gate, and the gate writes down what it decided and why — including the refusals.

**Picking this up to work on it?** Read [PLAN.md](PLAN.md) — what runs, what
doesn't, which decisions are load-bearing, and the traps already paid for.

---

## The thesis

The easy version of this track is a conversational checkout: a chatbot that takes
an order and calls Razorpay. That clears the "working product" bar and fails the
evidence bar, because the interesting question in agent-to-agent commerce is not
*can an agent buy something*. It is **on whose authority, within what bounds, and
what happens when the payment goes wrong halfway through.**

So the model here never touches money. It can search a catalog, request signed
quotes, and nominate offer IDs. It cannot name a price, cannot sign a cart, and
has no tool that moves funds. Assembling, signing, and settling is deterministic
code sitting behind a policy engine — which means a confused or adversarial model
cannot spend outside its mandate, because it never holds the pen.

One consequence is worth stating plainly: **exactly one file imports an LLM SDK**
(`src/buyer/agent.ts`). Nothing under `core/`, `razorpay/`, `recon/` or `merchant/`
references a model provider at all. The agent currently runs on Gemini Flash-Lite
because its free tier is generous; swapping providers is a one-file change and
touches no rule, no signature, and no money path.

---

## Architecture

```
        ┌──────────────┐   signs intent mandate (budget, caps, allowlists)
        │    Human     │──────────────────────────┐
        └──────────────┘                          ▼
                                        ┌────────────────────┐
        ┌──────────────┐   MCP tools    │   AI buyer agent   │
        │   Merchant   │◀──────────────▶│ (gemini-flash-lite)│
        │  MCP server  │                │  proposes baskets  │
        │              │                └─────────┬──────────┘
        │ search       │                          │ offer IDs only
        │ get_quote ───┼── signed Offer ──────────▼
        │ get_merchant_key ─ pubkey ──▶ ┌──────────────────────┐
        │ propose_upsell                │  GATE 1 — buyer side │
        │                               │  12 rules, locally   │
        │                               │  refuse ⇒ never sent │
        │                               └──────────┬───────────┘
        │ settle_cart ─┼─────────▶  ┌──────────────▼───────────┐
        │ get_audit    │            │  GATE 2 — merchant side  │
        └──────┬───────┘            │  the same 12 rules       │
               │                    │  ALLOW / DENY / ESCALATE │
               │                    └───────┬──────────────────┘
               │                            │ only if ALLOW
               │                            ▼
               │                    ┌──────────────────┐
               │                    │  Razorpay        │
               │                    │  order→auth→capture
               │                    └───────┬──────────┘
               │                            │ on failure / timeout
               │                            ▼
               │                    ┌──────────────────┐
               │                    │   Reconciler     │
               │                    │ idempotent void  │
               └───────────────────▶└───────┬──────────┘
                                            ▼
                              ┌────────────────────────────┐
                              │  Hash-chained audit ledger │
                              │  every step, before+after  │
                              └────────────────────────────┘
```

### Two mandates, two signers

| | Signed by | Answers |
|---|---|---|
| **Intent mandate** | the human (Ed25519) | *May this agent spend at all, where, on what, up to how much?* |
| **Cart mandate** | the agent (Ed25519) | *Is this specific basket the one the agent actually committed to?* |
| **Offer** | the merchant (Ed25519) | *Is this price real, current, and honoured?* |

There is a fourth signature, produced only when it is needed: above the mandate's
approval threshold the human signs an **approval attestation** bound to one cart
id and one exact amount, so it cannot be replayed onto a different basket or
scaled up to a larger one.

### Two gates, run independently

The same twelve rules run twice, by parties with different interests:

| | Runs where | Catches |
|---|---|---|
| **Gate 1 — buyer** | in the buyer's process, before anything is transmitted | its own mistakes: wrong category, over cap, over budget, stale offer. A refusal here is never sent, so no order is created and no money path is touched. |
| **Gate 2 — merchant** | inside `settle_cart`, on arrival | a buyer that has been compromised and skipped its own gate — the only reason this second check earns its place. |

The buyer learns the merchant's public key over the protocol (`get_merchant_key`)
rather than off a shared disk, so it verifies offer signatures itself. Neither
side has to trust that the other did its job, and the batch below reports which
gate caught what.

---

## The gate: 12 rules

Every money action runs all twelve and records all twelve — the audit trail shows
the rules that *passed*, not only the one that failed.

| # | Rule | Refuses |
|---|---|---|
| 1 | `intent_mandate_signature` | a mandate the human did not sign |
| 2 | `cart_mandate_signature` | a cart tampered with after signing |
| 3 | `mandate_binding` | a cart pointing at a different mandate or agent |
| 4 | `mandate_validity_window` | an expired or not-yet-valid mandate |
| 5 | `merchant_allowlist` | a merchant the human never approved |
| 6 | `category_allowlist` | an out-of-scope item smuggled into an in-scope basket |
| 7 | `offer_provenance` | invented prices, altered prices, stale prices |
| 8 | `cart_arithmetic` | a stated total that isn't the sum of its lines |
| 9 | `idempotency` | replay of an already-settled cart |
| 10 | `per_transaction_cap` | a single transaction above the ceiling |
| 11 | `cumulative_budget` | spend past the mandate's total budget |
| 12 | `human_approval_threshold` | *escalates* rather than refuses — clears only on a principal-signed approval bound to this cart id and this exact amount |

Rule 12 is the only one that returns `REQUIRE_APPROVAL`. A `DENY` from any rule
beats an escalation, and the result names **one** deciding rule — not a list.

Because the human sits on the buyer's side, approval is collected there and the
signature travels with the cart. Measured, over MCP:

```
threshold ₹200.00 · cart ₹430.50

A. no approval attached      → APPROVAL_DENIED
                               "at or above the threshold and no human approval was presented"
B. valid approval attached   → COMPLETED · order_bb48021f… · pay_6bbb2b89…
C. ₹210 approval replayed
   onto the ₹430.50 cart     → APPROVAL_DENIED
                               "approval covers ₹210.00 but the cart totals ₹430.50"
```

---

## Revenue growth, bounded

The merchant runs an upsell agent (`propose_upsell`). It proposes **at most one**
complementary add-on, capped at a fraction of the headroom the buyer declares, and
confined to the categories the buyer says it can accept. Cheapest-first, because an
upsell that fits is worth more than one that gets refused.

That cap is courtesy, and a merchant is free to ignore it — `proposeUpsell` has a
`greedy` mode that does exactly that, sizing a bulk quantity past the declared
headroom. The gate is the enforcement. The buyer's policy engine re-checks every
add-on against the mandate regardless, and refuses it with a machine-readable
reason if it doesn't fit:

```
3. Merchant proposes an out-of-mandate add-on
   → POLICY_BLOCKED · ₹1,963.32 · deciding rule: category_allowlist
     DENY category_allowlist: line categories outside mandate: electronics
                              (observed electronics vs limit groceries,household)
     DENY per_transaction_cap: transaction exceeds the per-transaction cap
                              (observed ₹1,963.32 vs limit ₹1,500.00)
     REQUIRE_APPROVAL human_approval_threshold: at or above the approval threshold
                              (observed ₹1,963.32 vs limit ₹1,200.00)
```

---

## The failure that matters

A clean decline is easy: no money moved, log it, done. The dangerous case is
**authorization that succeeds while the response is lost** — Razorpay holds an
authorized payment and the buyer has no idea.

The system does not guess. It asks the gateway what payments it actually holds for
the order and compensates anything it cannot account for, idempotently:

```
4. Authorization goes indeterminate mid-payment
   → RECOVERED_VOID · ₹223.02
     network timeout after authorization was sent
     order order_af659ee… · payment pay_e445f49… · refund rfnd_2972d2a…

   #13 recon.started         {"cause":"indeterminate_authorization","expected":"₹223.02"}
   #14 recon.orphan_detected {"paymentId":"pay_e445f49…","status":"authorized","strandedCount":1}
   #15 recon.compensated     {"refundId":"rfnd_2972d2a…","amount":"₹223.02"}
```

Reconciliation also runs after a *clean* decline — we confirm no money moved with
the gateway rather than trusting the response we happened to receive.

---

## Batch evidence

`npm run bench` — 50 agentic checkouts, deterministic seed, injected payment faults
(8% decline, 6% indeterminate authorization, 4% capture failure) and deliberate
policy breaches. All figures below are **measured**, from seed `20260830`:

```
Outcomes
  COMPLETED                           23   46.0%
  POLICY_BLOCKED                      22   44.0%
  PAYMENT_FAILED                       3    6.0%
  RECOVERED_VOID                       1    2.0%
  APPROVAL_DENIED                      1    2.0%

Refusals, by which gate caught them
  buyer-side                          20     refused locally — never transmitted
  merchant-side                        3     a compromised agent skipped its own gate

Policy blocks, by deciding rule
  category_allowlist                   7     (4 in-buyer + 3 rogue-agent bypasses)
  offer_provenance                     6     (3 expired offers + 3 re-signed price tampers)
  per_transaction_cap                  4
  cart_mandate_signature               2     (tampered without re-signing)
  idempotency                          2     (replayed settled carts)
  human_approval_threshold             1     (human declined)
  cumulative_budget                    1

Money
  attempted    ₹71,783.24
  captured     ₹28,525.31
  compensated  ₹1,234.31
  leaked       ₹0.00

Upsell performance
  proposed by merchant                25
  accepted by buyer                   12     ₹2,503.20 — 8.8% of captured revenue
  declined — would breach the mandate 13

Payment-fault recovery
  injected failures 4 · recovered 4 · unrecovered 0 · 100.0%

Ledger  chain intact · 173 entries
```

**Upsell performance is the revenue-growth half of the track, measured.** Half the
baskets meet a merchant that proposes a bulk quantity sized past the headroom the
buyer declared — ordinary retail behaviour, and exactly why a buyer's cap has to be
enforced rather than requested politely. It pushed 25 times: 12 landed and earned
₹2,503.20, and the buyer's own gate refused the other 13. Growth and bounds, on
the same line.

The two rows under **Refusals** are the point. Twenty violations never left the
buyer's process. Three did, because the batch includes a `rogue_buyer_bypass`
scenario — an agent that skips its own gate entirely — and the merchant caught
every one. Without that scenario the merchant row reads zero, which would make
the second gate look decorative; it isn't, and the number now shows why.

Every case's outcome, deciding rule, and failure reason is written to
`bench-out/batch-<seed>.json`. Nothing here is cherry-picked: the batch composition
is fixed in code, the PRNG is seeded, and re-running reproduces these numbers exactly.

The batch runs against the **fake** gateway on purpose — a live Razorpay test
account will not produce a timeout-after-authorization on demand, and that is the
failure worth proving.

---

## Audit trail

Append-only, hash-chained (`sha256(prevHash ‖ canonicalJSON(entry))`). Editing or
dropping any entry breaks every hash after it, and `npm run verify` recomputes the
whole chain.

```
$ npm run audit -- cm_23747a86-f16

#0 checkout.requested          agent:agent-buyer-01
#1 policy.evaluated            system:policy
     ALLOW  intent_mandate_signature    intent mandate signed by a known principal
     ALLOW  cart_mandate_signature      cart mandate signed by a known agent
     ALLOW  offer_provenance            all lines trace to live merchant-signed offers
     ALLOW  per_transaction_cap         within the per-transaction cap
     …
#2 payment.order_created       system:gateway
#3 payment.captured            system:gateway
#4 budget.debited              system:policy
#5 checkout.completed          agent:agent-buyer-01
```

Every Razorpay order carries `notes.cart_mandate_id` / `intent_mandate_id` /
`agent_id`, so the ledger and the Razorpay dashboard join on a single key.

---

## Running it

```bash
npm install
cp .env.example .env      # optional — omit for the built-in fake gateway

npm run demo              # 5-step walkthrough: mandate → purchase → refusal → recovery → replay
npm run mcp-demo          # full transaction over MCP, scripted buyer (no LLM, no API key)
npm run mcp-demo:fake     # same, forced onto the fake gateway so it completes end to end
npm run agent             # LLM buyer shopping over MCP — needs GEMINI_API_KEY (free, no card)
npm run bench             # 50-transaction evidence batch
npm run audit -- <cartId> # read one transaction end to end
npm run verify            # recompute the ledger hash chain
npm run mcp               # run the merchant MCP server on stdio (for any MCP client)
```

### The buyer agent's model

`GEMINI_API_KEY` from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) —
free, no card. `GEMINI_MODEL` defaults to `gemini-3.5-flash-lite` (the most generous
free tier: 15 req/min, 1,000/day, roughly 80+ agent runs a day). Set it to
`gemini-3.5-flash` if you want more headroom on reasoning.

Without a key, every other command still works — the deterministic planner in
`src/buyer/planner.ts` drives the same flow.

### Razorpay modes

| | Gateway |
|---|---|
| No keys set | built-in fake, mirrors the Razorpay API shape, supports fault injection |
| `RAZORPAY_KEY_ID=rzp_test_…` | live **test-mode** API |
| Any non-`rzp_test_` key | **refused at startup** — this never touches live money |

**Verified against the live test API.** Measured, not predicted:

```
get_merchant_key → pinned merchant-kirana-fresh · merchant gateway = LIVE
merchant → AWAITING_EXTERNAL_AUTHORIZATION · ₹916.65
           order plink_TW5DlyyPmIYZf5
           awaiting buyer authorization at https://rzp.io/rzp/BRWQyTs
```

**One honest difference in live mode.** Razorpay has no server-side "charge this
card now" call — authorization is buyer-side. So `authorize()` creates a real
Payment Link and returns `pending_external` with its URL for the buyer to complete,
and the flow stops there; order creation, capture, refund, and reconciliation are
all the real API. The fake implements the full loop so the batch can exercise it.

**A trap worth knowing if you fork this.** The MCP SDK forwards only
`HOME/LOGNAME/PATH/SHELL/TERM/USER` to a spawned server — a sound default that
silently starved the merchant of its Razorpay credentials, so an early "live" run
was really on the fake and looked identical. `src/buyer/mcp-client.ts` now forwards
the two Razorpay variables explicitly, and `get_merchant_key` reports
`gatewayMode` on the handshake so no caller has to assume which gateway is about
to move its money.

### Wiring the merchant into any MCP client

```json
{
  "mcpServers": {
    "kirana-fresh": { "command": "npx", "args": ["tsx", "src/merchant/mcp-server.ts"] }
  }
}
```

Tools exposed: `search_products`, `get_product`, `get_merchant_key`, `get_quote`,
`propose_upsell`, `settle_cart`, `get_audit_trail`.

---

## Layout

```
src/
  core/          money · canonical JSON · Ed25519 · mandates · policy engine · gate · ledger
  razorpay/      gateway interface · fake (fault injection) · live test-mode adapter
  merchant/      catalog · signed quotes · bounded upsell agent · MCP server
  buyer/         buyer-side gate · LLM agent (tool runner) · MCP client · planner
  recon/         orphan detection + idempotent compensation
  bench/         50-transaction batch harness and metrics
```

---

## What this does not do

Stated plainly, because a submission that hides its edges is worse than one that names them:

- **Live authorization cannot complete without a webhook.** `authorize()` returns a
  real Payment Link and stops; nothing resumes the flow when the buyer pays. Until
  that exists, a live run ends at `AWAITING_EXTERNAL_AUTHORIZATION` by design.
- **The agent can't distinguish "absent" from "forbidden".** Asked for a kettle, it
  searched only its allowed categories, found nothing, and reported that the
  merchant does not stock kettles. It stocks 25 — they are in a category the
  mandate excludes. The honest answer was "outside your mandate", not "not sold".
- **Keys live on disk** under `keys/`. A real deployment keeps the principal's key
  in the user's wallet and the merchant's in an HSM; the agent should never hold a
  key that can authorize spend, only one that can attest to a cart.
- **Single merchant, single currency (INR), single principal.** The policy engine
  is written to generalize; nothing has been built to prove that it does.
- **No settlement/refund webhooks.** Reconciliation is pull-based on the failure
  path only. Production wants Razorpay webhooks driving a periodic sweep.
- **Not an implementation of AP2, ACP, or x402.** The mandate structure is
  AP2-shaped — human-signed intent, agent-signed cart — but this is not wire-
  compatible with any published spec.
