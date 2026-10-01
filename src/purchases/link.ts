import { z } from "zod";
import { boundedJSON } from "./mpp.js";

export const Spend = z.object({ id: z.string().regex(/^lsrq_[A-Za-z0-9]+$/), status: z.string(),
  amount: z.number().int().nonnegative(), currency: z.string(), network_id: z.string(),
  credential_type: z.literal("shared_payment_token"), merchant_url: z.string(),
  shared_payment_token: z.object({ id: z.string().min(1).max(1000) }).nullish(),
  payment_status_details: z.object({ outcome: z.string(), amount: z.number().int(), currency: z.string() }).nullish(),
  link_transaction_id: z.string().max(200).nullish(), approval_url: z.string().nullish() }).passthrough();
export class LinkWallet {
  constructor(private readonly fetcher: typeof fetch, private readonly token: () => Promise<string>) {}
  async call(path: string, method: "GET" | "POST", body: unknown, signal: AbortSignal) {
    const token = await this.token(); signal.throwIfAborted();
    const response = await this.fetcher(`https://api.link.com${path}`, { method, redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Link request failed (${response.status}); outcome may be unknown.`); }
    return boundedJSON(response);
  }
  create(body: unknown, signal: AbortSignal) { return this.call("/spend_requests", "POST", body, signal).then((value) => Spend.parse(value)); }
  retrieve(id: string, include: boolean, signal: AbortSignal) {
    return this.call(`/spend_requests/${encodeURIComponent(id)}${include ? "?include=shared_payment_token" : ""}`, "GET", undefined, signal).then((value) => Spend.parse(value));
  }
}
