import { GoogleGenAI, Type, type FunctionDeclaration } from "@google/genai";
import { issueCartMandate } from "../core/mandate.js";
import { fmt } from "../core/money.js";
import type { CartLine, SignedIntentMandate, SignedOffer } from "../core/types.js";
import type { Keypair } from "../core/crypto.js";
import { BuyerGate, type AskHuman } from "./gate.js";
import { MerchantClient } from "./mcp-client.js";

/** Flash-Lite has the most generous free tier and ample headroom for this task. */
export const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
const MAX_TURNS = 16;

const SYSTEM = `You are a buying agent shopping on behalf of a person who has signed an intent mandate.

The mandate is the boundary of your authority. You cannot exceed it and you should not try:
every cart you submit is checked against it by a policy engine that will refuse anything outside
the bounds, with a reason. Being refused is not a failure state you should route around — if a
merchant proposes something the mandate does not permit, decline it and say why.

How to work:
1. Search the catalog for what the person asked for.
2. Get a signed quote for each line you intend to buy. Only quoted offers can go in a cart.
3. You may ask the merchant for one bounded add-on. Accept it only if it fits the mandate:
   it must be in an allowed category and must not take the cart past the per-transaction cap.
   Merchants sometimes propose far more than you asked for — check the amount before accepting.
4. Submit the cart. Your own policy engine checks it before anything is sent — if it
   refuses, you get the rule and the reason back and nothing reaches the merchant.
   Fix the basket and try again rather than resubmitting the same cart.
5. When you are done, reply with a short plain-text summary: what you bought, the total,
   and the outcome.

Prices are in paise: 100 paise = 1 rupee. Never invent a price — a cart line's amount comes
from the signed offer, and a mismatch will be refused at the gate.`;

export interface BuyerRunResult {
  transcript: string[];
  submitted: boolean;
}

/**
 * The LLM proposes; the policy engine disposes.
 *
 * Note what the model is *not* given: no tool that moves money, no ability to
 * sign a cart, no way to name a price. It can search, quote, and nominate offer
 * IDs. `build_and_submit_cart` is our code — it assembles the cart only from
 * offers the merchant actually issued, runs the buyer's own gate, signs with the
 * agent key, and only then submits. A confused or adversarial model cannot spend
 * outside the mandate, because it never holds the pen.
 *
 * The model provider is therefore an implementation detail. Nothing under
 * `core/`, `razorpay/`, `recon/` or `merchant/` imports an LLM SDK at all.
 */
export async function runBuyerAgent(args: {
  goal: string;
  intent: SignedIntentMandate;
  agentKp: Keypair;
  /** Needed so the buyer can sign a human approval on its own side. */
  principalKp: Keypair;
  merchantCommand: string;
  merchantArgs: string[];
  askHuman?: AskHuman;
  onEvent?: (line: string) => void;
}): Promise<BuyerRunResult> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Set GEMINI_API_KEY to run the buyer agent. Get a free key at https://aistudio.google.com/apikey — no card required.",
    );
  }

  const ai = new GoogleGenAI({ apiKey });
  const merchant = await MerchantClient.connect(args.merchantCommand, args.merchantArgs);
  const gate = new BuyerGate(args.principalKp, args.agentKp);
  const transcript: string[] = [];
  const emit = (line: string) => {
    transcript.push(line);
    args.onEvent?.(line);
  };

  /** Offers the merchant has actually signed for us. The model cannot add to this. */
  const seenOffers = new Map<string, SignedOffer>();
  let submitted = false;

  const im = args.intent.mandate;

  // Pin the merchant's signing key over the protocol. Without it the buyer's own
  // gate cannot verify offer provenance and would refuse every cart.
  const mk = await merchant.call<{ keyId: string; publicKeyPem: string; gatewayMode: string }>(
    "get_merchant_key",
    {},
  );
  gate.trustMerchantKey(mk.keyId, mk.publicKeyPem);
  emit(`pinned merchant key ${mk.keyId} · merchant gateway = ${mk.gatewayMode.toUpperCase()}`);

  const askHuman: AskHuman =
    args.askHuman ??
    (async ({ summary }) => {
      emit(`  human ⇧ "${summary}" → approved`);
      return { approved: true, reason: "matches what I asked the agent to buy" };
    });

  const declarations: FunctionDeclaration[] = [
    {
      name: "search_products",
      description:
        "Search the merchant's catalog. Returns typed products with attributes and indicative prices in paise.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          q: { type: Type.STRING, description: "free-text match on title, sku, or category" },
          category: {
            type: Type.STRING,
            description: "one of: groceries, household, personal_care, electronics",
          },
          limit: { type: Type.INTEGER, description: "max results, 1-20" },
        },
      },
    },
    {
      name: "get_quote",
      description:
        "Get a merchant-signed, time-boxed offer for a SKU at a quantity. You must quote a line before you can buy it; the returned offerId is what goes in the cart.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          sku: { type: Type.STRING },
          qty: { type: Type.INTEGER },
        },
        required: ["sku", "qty"],
      },
    },
    {
      name: "ask_merchant_for_addon",
      description:
        "Ask the merchant to propose one complementary add-on, bounded by the headroom you declare and the categories your mandate allows. Returns a signed offer or null. The merchant may propose more than fits — you decide whether to accept it.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          currentOfferIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "offer IDs already in your cart",
          },
          declaredHeadroomPaise: { type: Type.INTEGER },
        },
        required: ["currentOfferIds", "declaredHeadroomPaise"],
      },
    },
    {
      name: "get_mandate",
      description:
        "Read the bounds you are operating under: budget, per-transaction cap, approval threshold, allowed merchants and categories.",
      parameters: { type: Type.OBJECT, properties: {} },
    },
    {
      name: "build_and_submit_cart",
      description:
        "Assemble a cart from offer IDs you have already been quoted, check it against your own policy engine, sign it, and submit it. Amounts come from the signed offers — you do not supply them. Returns the outcome and the deciding rule.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          offerIds: { type: Type.ARRAY, items: { type: Type.STRING } },
          reasoning: { type: Type.STRING, description: "one line on why this basket meets the request" },
        },
        required: ["offerIds", "reasoning"],
      },
    },
  ];

  /** Everything the model is allowed to cause. Note none of it moves money directly. */
  async function dispatch(name: string, rawArgs: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "search_products": {
        emit(`search_products ${JSON.stringify(rawArgs)}`);
        return merchant.call("search_products", rawArgs);
      }

      case "get_mandate":
        return im;

      case "get_quote": {
        const res = await merchant.call<SignedOffer & { error?: string }>("get_quote", rawArgs);
        if (!res.error) {
          seenOffers.set(res.offer.offerId, res);
          emit(`get_quote ${res.offer.sku} ×${res.offer.qty} → ${res.offer.offerId} ${fmt(res.offer.totalPaise)}`);
        }
        return res;
      }

      case "ask_merchant_for_addon": {
        const ids = (rawArgs.currentOfferIds as string[] | undefined) ?? [];
        const lines = ids
          .map((id) => seenOffers.get(id))
          .filter((s): s is SignedOffer => Boolean(s))
          .map((s) => ({ sku: s.offer.sku, qty: s.offer.qty, totalPaise: s.offer.totalPaise }));
        const res = await merchant.call<{
          proposal: { offer: SignedOffer; rationale: string } | null;
          reason?: string;
        }>("propose_upsell", {
          lines,
          declaredHeadroomPaise: rawArgs.declaredHeadroomPaise ?? 0,
          allowedCategories: im.categoriesAllowed,
        });
        if (res.proposal) {
          seenOffers.set(res.proposal.offer.offer.offerId, res.proposal.offer);
          emit(`ask_merchant_for_addon → ${res.proposal.rationale}`);
        } else {
          emit(`ask_merchant_for_addon → none (${res.reason ?? "no fit"})`);
        }
        return res;
      }

      case "build_and_submit_cart": {
        const offerIds = (rawArgs.offerIds as string[] | undefined) ?? [];
        const reasoning = (rawArgs.reasoning as string) ?? "";
        const missing = offerIds.filter((id) => !seenOffers.has(id));
        if (missing.length > 0) {
          return { error: `no signed offer held for: ${missing.join(", ")}. Quote it first.` };
        }

        const lines: CartLine[] = offerIds.map((id) => {
          const o = seenOffers.get(id)!.offer;
          return {
            sku: o.sku, title: o.title, qty: o.qty, unitPaise: o.unitPaise,
            totalPaise: o.totalPaise, offerId: o.offerId, category: o.category,
          };
        });
        const cart = issueCartMandate(args.agentKp, {
          intentMandateId: im.mandateId,
          agentId: im.agentId,
          merchantId: im.merchantAllowlist[0]!,
          lines,
        });
        const offerMap = new Map(offerIds.map((id) => [id, seenOffers.get(id)!]));
        emit(`build_and_submit_cart ${cart.mandate.cartMandateId} · ${fmt(cart.mandate.totalPaise)} · ${reasoning}`);

        // Buyer-side gate. A refusal here never reaches the merchant, and the
        // model is told which rule stopped it so it can correct the basket.
        const review = await gate.review({ intent: args.intent, cart, offers: offerMap, askHuman });
        if (review.action === "refuse") {
          emit(`  buyer gate → REFUSED · ${review.rule} — nothing sent`);
          return {
            submitted: false,
            refusedBy: "your own policy engine, before anything was sent",
            rule: review.rule,
            reason: review.reason,
            hint: "Change the basket so it satisfies this rule, then submit again.",
          };
        }
        emit(`  buyer gate → cleared${review.approval ? " (human approved)" : ""}`);

        const result = await merchant.call<Record<string, unknown>>("settle_cart", {
          intentMandate: args.intent,
          cartMandate: cart,
          approval: review.approval,
        });
        submitted = true;
        if (result.outcome === "COMPLETED") gate.recordSettled(cart);
        emit(`  merchant   → ${result.outcome} · deciding rule: ${result.decidingRule}`);
        return result;
      }

      default:
        return { error: `unknown tool: ${name}` };
    }
  }

  const contents: Array<{ role: string; parts: unknown[] }> = [
    {
      role: "user",
      parts: [
        {
          text: `${args.goal}\n\nYour mandate: budget ${fmt(im.budgetPaise)}, per-transaction cap ${fmt(im.perTxnCapPaise)}, human approval needed at or above ${fmt(im.approvalThresholdPaise)}. Allowed categories: ${im.categoriesAllowed.join(", ")}. Allowed merchants: ${im.merchantAllowlist.join(", ")}.`,
        },
      ],
    },
  ];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: contents as never,
        config: {
          systemInstruction: SYSTEM,
          tools: [{ functionDeclarations: declarations }],
        },
      });

      const calls = response.functionCalls ?? [];
      if (calls.length === 0) {
        const text = response.text?.trim();
        if (text) emit(`\n${text}`);
        break;
      }

      // Echo the model's turn back before answering it, or the next request
      // loses the context of what it asked for.
      const modelParts = response.candidates?.[0]?.content?.parts ?? [];
      contents.push({ role: "model", parts: modelParts });

      const replies: unknown[] = [];
      for (const call of calls) {
        const out = await dispatch(call.name ?? "", (call.args ?? {}) as Record<string, unknown>);
        replies.push({
          functionResponse: { name: call.name, response: { result: out } },
        });
      }
      contents.push({ role: "user", parts: replies });
    }
  } finally {
    await merchant.close();
  }

  return { transcript, submitted };
}
