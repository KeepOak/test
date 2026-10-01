import { createHash } from "node:crypto";
import { z } from "zod";

const Request = z.object({ amount: z.string().regex(/^(0|[1-9][0-9]{0,5})$/), currency: z.literal("usd"),
  methodDetails: z.object({ networkId: z.string().min(1).max(200) }).passthrough().optional(),
  networkId: z.string().min(1).max(200).optional() }).passthrough();
export function stripeChallenge(header: string) {
  if (header.length > 12000 || !header.startsWith("Payment ")) throw new Error("Unsupported payment challenge.");
  const values: Record<string, string> = {}, text = header.slice(8);
  const pattern = /([a-z]+)=("(?:[^"\\]|\\.)*")(?:,\s*|$)/gy;
  let end = 0;
  for (;;) {
    const match = pattern.exec(text);
    if (!match) break;
    const key = match[1]!, value = JSON.parse(match[2]!) as string;
    if (key in values || !["id", "realm", "method", "intent", "request", "expires", "description", "digest", "opaque"].includes(key))
      throw new Error("Ambiguous or unsupported payment challenge.");
    values[key] = value; end = pattern.lastIndex;
  }
  if (end !== text.length || !values.id || !values.realm || values.method !== "stripe" || values.intent !== "charge"
    || !values.request || !/^[A-Za-z0-9_-]+$/.test(values.request)) throw new Error("Only one Stripe charge challenge is supported.");
  const request = Request.parse(JSON.parse(Buffer.from(values.request, "base64url").toString("utf8")));
  const amount = Number(request.amount), networkId = request.methodDetails?.networkId ?? request.networkId;
  if (!networkId || amount > 100000) throw new Error("Purchase exceeds the supported USD 1,000 cap or has no network.");
  const expires = values.expires ? Date.parse(values.expires) : NaN;
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error("A current challenge expiry is required.");
  return { wire: values, amount, currency: "usd" as const, networkId, expires,
    hash: createHash("sha256").update(header).digest("hex") };
}
export type StripeChallenge = ReturnType<typeof stripeChallenge>;
export function paymentCredential(challenge: StripeChallenge, spt: string): string {
  return `Payment ${Buffer.from(JSON.stringify({ challenge: challenge.wire, payload: { spt } }), "utf8").toString("base64url")}`;
}
export async function boundedJSON(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Provider returned no JSON.");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 128000) throw new Error("Provider response exceeded the bounded limit.");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
