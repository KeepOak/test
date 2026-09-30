import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Runtime } from "../runtime.js";
import type { ToolContext } from "../contracts.js";
import { runOrigin } from "../key-context.js";
import { LinkWallet } from "./link.js";
import { stripeChallenge, paymentCredential, type StripeChallenge } from "./mpp.js";

export const purchasesKey = "purchases-link-settings";
const Settings = z.object({ enabled: z.boolean().default(false), freeWithoutMoneyPrompt: z.boolean().default(false),
  secretName: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).default("LINK_AGENT_ACCESS_TOKEN"),
  paymentMethodId: z.string().max(200).default(""), origins: z.array(z.string().url()).max(8).default([]),
  acknowledge: z.literal("single-use Stripe Link USD purchases").optional() }).strict();
export const QuoteInput = z.object({ url: z.string().url().max(2000), item: z.string().trim().min(1).max(200),
  seller: z.string().trim().min(1).max(100) }).strict();
export const SpendInput = z.object({ quoteId: z.string().uuid(), authorizationId: z.string().uuid().optional() }).strict();
type Quote = z.infer<typeof QuoteInput> & { id: string; challenge: StripeChallenge; createdAt: number; settingsHash: string };
type Grant = { id: string; quoteId: string; settingsHash: string; expires: number };
type Deps = { runtime: Runtime; fetch: typeof fetch; secret: (name: string, purpose: string) => Promise<string>; requireOwner: (what: string) => void; refusal: () => string | null };

export class Purchases {
  private readonly quotes = new Map<string, Quote>();
  private readonly grants = new Map<string, Grant>();
  private readonly busy = new Set<string>();
  private readonly pending = new Map<string, { quote: Quote; grant: Grant }>();
  private readonly controllers = new Set<AbortController>();
  constructor(private readonly deps: Deps) {}
  settings() { return Settings.parse(this.deps.runtime.store.get("settings", this.deps.runtime.owner, purchasesKey)?.data ?? {}); }
  private hash() { return createHash("sha256").update(JSON.stringify(this.settings())).digest("hex"); }
  private owner(context?: ToolContext) {
    this.deps.requireOwner("Purchases and money conditions");
    const refusal = this.deps.refusal(); if (refusal) throw new Error(refusal);
    if (!context) return;
    const origin = runOrigin(this.deps.runtime.store, context.runId);
    if (context.source !== "owner" || origin.source !== "owner" || origin.parentRunId || origin.shortLivedKey || origin.personProfileId
      || origin.lentTo || context.trunk || context.isolated) throw new Error("Only an original owner task may purchase.");
    const task = this.deps.runtime.store.run(context.runId);
    const shares = this.deps.runtime.store.get("settings", this.deps.runtime.owner, "people-shares")?.data;
    const tuples = z.object({ tuples: z.array(z.object({ object: z.string() }).passthrough()) }).safeParse(shares ?? { tuples: [] });
    if (!task || !this.deps.runtime.store.ownsSession(this.deps.runtime.owner, task.sessionId) || this.deps.runtime.store.sessionTemporary(task.sessionId) || !tuples.success
      || tuples.data.tuples.some((tuple) => tuple.object === `conversation:${task.sessionId}`)) throw new Error("Shared purchases are refused.");
  }
  configure(input: unknown) {
    this.owner(); const value = Settings.parse(input);
    for (const origin of value.origins) {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error("Choose exact HTTPS seller origins.");
    }
    if (value.enabled && (!value.paymentMethodId || !value.origins.length || value.acknowledge !== "single-use Stripe Link USD purchases"))
      throw new Error("Choose the payment method, origins and explicit purchase acknowledgement.");
    this.clear();
    this.deps.runtime.store.save("settings", this.deps.runtime.owner, purchasesKey, value);
    return this.overview();
  }
  clear() { this.quotes.clear(); this.grants.clear(); this.pending.clear(); for (const controller of this.controllers) controller.abort(); }
  private destination(url: string) {
    const value = new URL(url), settings = this.settings();
    if (!settings.enabled || value.protocol !== "https:" || value.username || value.password || value.hash || value.search
      || !settings.origins.includes(value.origin)) throw new Error("Purchases are off or this exact seller origin is not enabled.");
  }
  private current(id: string) {
    const quote = this.quotes.get(id);
    if (!quote || Date.now() - quote.createdAt > 300000 || quote.challenge.expires <= Date.now() || quote.settingsHash !== this.hash())
      throw new Error("Quote expired or purchase settings changed. Get a fresh quote and approve again.");
    this.destination(quote.url); return quote;
  }
  private view(quote: Quote) {
    return { id: quote.id, item: quote.item, seller: quote.seller, url: quote.url, amountMinor: quote.challenge.amount,
      currency: quote.challenge.currency, networkId: quote.challenge.networkId, challengeHash: quote.challenge.hash,
      expiresAt: new Date(Math.min(quote.createdAt + 300000, quote.challenge.expires)).toISOString(),
      note: "Item/seller labels are owner-supplied; price is the merchant's untrusted MPP challenge, not an invoice total. No purchase or fulfilment is verified." };
  }
  target(id: string) {
    const quote = this.current(id);
    return `${quote.seller}: ${quote.item}; exact ${quote.challenge.amount} USD cents; ${quote.url}; quote ${quote.challenge.hash}`;
  }
  pendingTarget(id: string) {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("No live pending authorization.");
    return `${pending.quote.seller}: ${pending.quote.item}; exact ${pending.quote.challenge.amount} USD cents; ${pending.quote.url}; ${id}`;
  }
  overview() {
    this.owner();
    for (const [id, quote] of this.quotes) if (Date.now() - quote.createdAt > 300000) this.quotes.delete(id);
    return { settings: this.settings(), quotes: [...this.quotes.values()].map((quote) => this.view(quote)), pending: [...this.pending.keys()],
      receipts: this.deps.runtime.store.list("governance", this.deps.runtime.owner).filter((r) => r.id.startsWith("purchase-receipt:")).slice(0, 30).map((r) => r.data) };
  }
  async quote(input: unknown, context?: ToolContext) {
    this.owner(context); const value = QuoteInput.parse(input); this.destination(value.url);
    for (const [id, old] of this.quotes) if (Date.now() - old.createdAt > 300000 || old.challenge.expires <= Date.now()) this.quotes.delete(id);
    if (this.quotes.size >= 20) throw new Error("Clear or let old quotes expire before creating more.");
    const response = await this.deps.fetch(value.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15000) });
    const header = response.headers.get("www-authenticate") ?? ""; await response.body?.cancel();
    if (response.status !== 402) throw new Error("An explicit Stripe charge challenge is required. HTTP success does not prove a free purchase.");
    const quote: Quote = { ...value, id: randomUUID(), challenge: stripeChallenge(header), createdAt: Date.now(), settingsHash: this.hash() };
    this.owner(context); this.destination(value.url); this.quotes.set(quote.id, quote); return this.view(quote);
  }
  authorize(input: unknown) {
    this.owner(); const { quoteId } = z.object({ quoteId: z.string().uuid() }).strict().parse(input), quote = this.current(quoteId);
    for (const [id, old] of this.grants) if (old.expires <= Date.now()) this.grants.delete(id);
    if (this.grants.size >= 20) throw new Error("Too many outstanding authorizations.");
    const grant = { id: randomUUID(), quoteId, settingsHash: this.hash(), expires: Math.min(Date.now() + 180000, quote.challenge.expires) };
    this.grants.set(grant.id, grant);
    return { authorizationId: grant.id, quote: this.view(quote), expiresAt: new Date(grant.expires).toISOString(), singleUse: true };
  }
  private consume(input: z.infer<typeof SpendInput>, quote: Quote): Grant {
    const free = quote.challenge.amount === 0 && this.settings().freeWithoutMoneyPrompt;
    const grant = input.authorizationId ? this.grants.get(input.authorizationId) : free ? {
      id: randomUUID(), quoteId: quote.id, settingsHash: this.hash(), expires: Date.now() + 60000 } : undefined;
    if (!grant || grant.quoteId !== quote.id || grant.settingsHash !== this.hash() || grant.expires <= Date.now())
      throw new Error("Paid, unknown or non-enabled free amounts require the owner's exact single-use authorization.");
    this.grants.delete(grant.id); this.quotes.delete(quote.id); return grant;
  }
  private record(grant: Grant, quote: Quote, state: string, details: Record<string, unknown> = {}) {
    const receipt = { ...this.view(quote), id: grant.id, quoteId: quote.id, state, recordedAt: new Date().toISOString(),
      delivery: "unverified", invoiceTotal: "unknown", ...details };
    this.deps.runtime.store.save("governance", this.deps.runtime.owner, `purchase-receipt:${grant.id}`, receipt);
    return receipt;
  }
  async spend(input: unknown, context: ToolContext) {
    this.owner(context); const value = SpendInput.parse(input), quote = this.current(value.quoteId);
    if (this.busy.has(quote.id)) throw new Error("This quote is already being submitted.");
    const grant = this.consume(value, quote), settings = this.settings(); this.busy.add(quote.id);
    const controller = new AbortController(); this.controllers.add(controller);
    const signal = AbortSignal.any([context.signal, controller.signal, AbortSignal.timeout(30000)]);
    const wallet = new LinkWallet(this.deps.fetch, () => this.deps.secret(settings.secretName, "this exact authorized Stripe Link purchase"));
    let requestId: string | undefined;
    this.record(grant, quote, "submitting", { chargedAmount: "unknown" });
    try {
      const probe = await this.deps.fetch(quote.url, { method: "GET", redirect: "error", signal });
      const header = probe.headers.get("www-authenticate") ?? ""; await probe.body?.cancel();
      if (probe.status !== 402 || stripeChallenge(header).hash !== quote.challenge.hash) throw new Error("Challenge changed; no payment credential released.");
      this.owner(context); this.destination(quote.url);
      const created = await wallet.create({ idempotency_key: grant.id, payment_details: settings.paymentMethodId,
        credential_type: "shared_payment_token", network_id: quote.challenge.networkId, amount: quote.challenge.amount,
        currency: "usd", merchant_name: quote.seller, merchant_url: quote.url, context: quote.item,
        request_approval: quote.challenge.amount > 0 }, signal);
      requestId = created.id;
      return await this.submit(wallet, requestId, quote, grant, context, signal);
    } catch { return this.record(grant, quote, "unknown", { requestId, chargedAmount: "unknown", note: "Authorization consumed. No automatic retry; inspect Link before any new approval." }); }
    finally { this.busy.delete(quote.id); this.controllers.delete(controller); }
  }
  private async submit(wallet: LinkWallet, requestId: string, quote: Quote, grant: Grant, context: ToolContext, signal: AbortSignal) {
    const metadata = await wallet.retrieve(requestId, false, signal);
    this.owner(context);
    if (this.hash() !== grant.settingsHash || grant.expires <= Date.now()) throw new Error("Authorization changed or expired.");
    if (metadata.status !== "approved") {
      if (["created", "pending_approval"].includes(metadata.status)) this.pending.set(requestId, { quote, grant });
      const approvalURL = metadata.approval_url ? new URL(metadata.approval_url) : null;
      return this.record(grant, quote, metadata.status, { requestId, chargedAmount: "unknown",
        approvalURL: approvalURL?.protocol === "https:" && ["app.link.com", "link.com"].includes(approvalURL.hostname) ? approvalURL.href : null,
        note: "Approve in Link, then explicitly Complete in Branch before expiry. No automatic submission/resume." });
    }
    const probe = await this.deps.fetch(quote.url, { method: "GET", redirect: "error", signal });
    const header = probe.headers.get("www-authenticate") ?? ""; await probe.body?.cancel();
    if (probe.status !== 402 || stripeChallenge(header).hash !== quote.challenge.hash) throw new Error("Challenge changed before credential release.");
    const request = await wallet.retrieve(requestId, true, signal);
    if (request.amount !== quote.challenge.amount || request.currency !== "usd" || request.network_id !== quote.challenge.networkId
      || request.merchant_url !== quote.url) throw new Error("Wallet scope does not match the approved purchase.");
    if (request.status !== "approved" || !request.shared_payment_token) throw new Error("No approved scoped payment token.");
    this.owner(context); this.destination(quote.url);
    if (this.hash() !== grant.settingsHash || grant.expires <= Date.now()) throw new Error("Consent changed or expired.");
    const response = await this.deps.fetch(quote.url, { method: "GET", redirect: "error", signal,
      headers: { authorization: paymentCredential(quote.challenge, request.shared_payment_token.id) } });
    const merchantStatus = response.status, headerReceipt = response.headers.get("payment-receipt");
    const receiptHash = headerReceipt ? createHash("sha256").update(headerReceipt).digest("hex") : null;
    await response.body?.cancel();
    const final = await wallet.retrieve(requestId, false, signal), charged = final.payment_status_details;
    const verified = final.status === "succeeded" && charged?.outcome === "success" && charged.amount === quote.challenge.amount && charged.currency === "usd";
    return this.record(grant, quote, verified ? "payment-recorded" : "unknown", { requestId, merchantStatus, receiptHash,
      chargedAmount: charged?.amount ?? "unknown", chargedCurrency: charged?.currency ?? "unknown", transactionId: final.link_transaction_id ?? null });
  }
  async complete(input: unknown, context: ToolContext) {
    this.owner(context);
    const { requestId } = z.object({ requestId: z.string().regex(/^lsrq_[A-Za-z0-9]+$/) }).strict().parse(input);
    const pending = this.pending.get(requestId);
    if (!pending || pending.grant.expires <= Date.now() || pending.grant.settingsHash !== this.hash())
      throw new Error("Pending authorization is absent, expired or changed. Inspect Link; do not blindly retry.");
    this.pending.delete(requestId);
    const controller = new AbortController(); this.controllers.add(controller);
    const settings = this.settings(), signal = AbortSignal.any([context.signal, controller.signal, AbortSignal.timeout(30000)]);
    const wallet = new LinkWallet(this.deps.fetch, () => this.deps.secret(settings.secretName, "completing this exact authorized Stripe Link purchase"));
    try { return await this.submit(wallet, requestId, pending.quote, pending.grant, context, signal); }
    catch { return this.record(pending.grant, pending.quote, "unknown", { requestId, chargedAmount: "unknown", note: "No automatic retry. Inspect Link before new authorization." }); }
    finally { this.controllers.delete(controller); }
  }
}
