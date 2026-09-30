import type { Store } from "../store.js";
import { graphBase, type FacebookConfig } from "./facebook-contract.js";

/** Fixed Meta Page edges only, using the same guarded fetch as the existing personal connectors. */
export class FacebookGraph {
  constructor(private readonly store: Store, private readonly owner: string, private readonly fetcher: typeof fetch) {}
  async token(settings: FacebookConfig, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted(); let token: string;
    try { token = (await this.store.secrets.resolve(this.owner, settings.tokenProject!, [settings.tokenSecret!],
      { purpose: "Owner-requested Facebook Page API" }))[settings.tokenSecret!]!; }
    catch { throw new Error("Facebook Page token unavailable in the configured project's locker"); }
    signal.throwIfAborted();
    if (!token || !/^[A-Za-z0-9._-]{16,4096}$/.test(token)) throw new Error("Missing or unsupported Facebook Page token");
    return token;
  }
  private reserve(max: number) {
    const day = new Date().toISOString().slice(0, 10), saved = this.store.get("settings", this.owner, "social-facebook-usage")?.data as { day?: string; attempts?: number } | undefined;
    const count = saved?.day === day && Number.isSafeInteger(saved.attempts) && saved.attempts! >= 0 ? saved.attempts! : 0;
    if (count >= max) throw new Error("Local UTC-day API attempt cap reached; this is not provider quota or billing evidence");
    this.store.save("settings", this.owner, "social-facebook-usage", { day, attempts: count + 1 });
  }
  async call(settings: FacebookConfig, token: string, signal: AbortSignal, path: string,
    query: Record<string, string> = {}, message?: string): Promise<unknown> {
    signal.throwIfAborted(); this.store.profiles.requireOwner("Your Facebook Page"); this.reserve(settings.maxCallsPerDay);
    if (!/^(?:me|[0-9]+(?:_[0-9]+)?(?:\/published_posts|\/feed)?)$/.test(path)) throw new Error("Unsupported Page API edge");
    const url = new URL(`${graphBase}/${path}`); url.search = new URLSearchParams(query).toString();
    let response: Response;
    try { response = await this.fetcher(url, { method: message === undefined ? "GET" : "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(message === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }) },
      ...(message === undefined ? {} : { body: new URLSearchParams({ message, published: "true" }).toString() }) }); }
    catch { throw new Error("Meta request stopped, timed out or was refused by network policy; no automatic retry"); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Meta answered HTTP ${response.status}; app review, permission, token validity and billing remain unverified`); }
    const reader = response.body?.getReader(); if (!reader) throw new Error("Meta returned no response");
    const parts: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > 128 * 1024) throw new Error("Meta response exceeded 128 KiB; no complete result claimed"); parts.push(part.value); }
    } finally { await reader.cancel().catch(() => undefined); }
    signal.throwIfAborted(); this.store.profiles.requireOwner("Your Facebook Page");
    return JSON.parse(Buffer.concat(parts).toString("utf8").replaceAll(token, "[redacted]"));
  }
}
