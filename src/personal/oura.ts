import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import type { OAuthConnections, OAuthProvider } from "../oauth.js";
import { currentPerson } from "../people/context.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { lockdownActive } from "../lockdown.js";

const Settings = z.object({ enabled: z.boolean(), clientId: z.string().trim().min(1).max(300),
  clientSecretName: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/), callbackPort: z.number().int().min(1024).max(65535) }).strict();
const Saved = Settings.extend({ grant: z.string().uuid() });
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(day => !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day, "Use a real calendar date");
const Range = z.object({ start: Day, end: Day, approvePrivateRead: z.literal(true) }).strict().refine(v => {
  const days = (Date.parse(v.end) - Date.parse(v.start)) / 86400000; return days >= 0 && days <= 30;
}, "Choose an ordered range of at most 31 days");
const Metric = z.object({ day: Day, score: z.number().min(0).max(100).nullable().optional(), steps: z.number().int().nonnegative().optional() }).passthrough();
const Page = z.object({ data: z.array(Metric).max(100), next_token: z.string().max(2000).nullable().optional() }).passthrough();
type Deps = { store: Store; owner: string; oauth: Pick<OAuthConnections, "start" | "saved" | "waitFor" | "cancel">;
  fetch: typeof fetch; secret: (name: string, purpose: string) => Promise<string>; requireOwner: (what: string) => void };

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Oura returned no data");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 256000) { await reader.cancel(); throw new Error("Oura response exceeds the private read limit"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
}

/** Owner-window only; no health tool exposed to models and no automatic ingestion. */
export class OuraDaily {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly deps: Deps) {}
  guard(): void {
    this.deps.requireOwner("Private wearable data"); this.deps.store.profiles.requireOwner("Private wearable data");
    if (currentPerson() || startedWithShortLivedKey() || lockdownActive(this.deps.store, this.deps.owner)) throw new Error("Use Oura in the owner's app window with Lockdown off");
  }
  private settings() {
    const value = Saved.safeParse(this.deps.store.get("settings", this.deps.owner, "wearable-oura")?.data);
    if (!value.success) throw new Error("Oura is off. Save your explicit application configuration first");
    return value.data;
  }
  private id(settings: z.infer<typeof Saved>): string { return `wearable-oura-${settings.grant.replaceAll("-", "").slice(0, 20)}`; }
  private async provider(settings: z.infer<typeof Saved>, guard: () => void): Promise<OAuthProvider> {
    guard(); const clientSecret = await this.deps.secret(settings.clientSecretName, "Oura daily read OAuth"); guard();
    return { id: this.id(settings), label: "Oura daily summaries", clientId: settings.clientId, clientSecret,
      authorizeUrl: "https://cloud.ouraring.com/oauth/authorize", tokenUrl: "https://api.ouraring.com/oauth/token", scopes: ["daily"], extra: {} };
  }
  private check(settings: z.infer<typeof Saved>, requestGuard: () => void): void {
    this.guard(); requestGuard();
    if (!settings.enabled || JSON.stringify(this.settings()) !== JSON.stringify(settings)) throw new Error("Oura is disabled or its account configuration changed. Sign in again");
  }
  async configure(input: unknown, requestGuard: () => void) {
    this.guard(); requestGuard(); const value = Settings.parse(input);
    const old = Saved.safeParse(this.deps.store.get("settings", this.deps.owner, "wearable-oura")?.data);
    this.deps.store.save("settings", this.deps.owner, "wearable-oura", { ...value, grant: randomUUID() });
    if (old.success) await this.deps.oauth.cancel(this.id(old.data));
    return { configured: true, enabled: value.enabled, note: "Configuration change invalidated the local account grant. Sign in again if enabled; revoke old app access in Oura to remove the provider grant." };
  }
  async disable(requestGuard: () => void) {
    this.guard(); requestGuard(); const settings = this.settings();
    return this.configure({ enabled: false, clientId: settings.clientId, clientSecretName: settings.clientSecretName, callbackPort: settings.callbackPort }, requestGuard);
  }
  async status(requestGuard: () => void) {
    this.guard(); requestGuard(); const value = Saved.safeParse(this.deps.store.get("settings", this.deps.owner, "wearable-oura")?.data);
    if (!value.success) return { configured: false, enabled: false, signedIn: false, grantedScope: null };
    const saved = await this.deps.oauth.saved(this.id(value.data)); this.guard(); requestGuard();
    if (JSON.stringify(this.settings()) !== JSON.stringify(value.data)) throw new Error("The Oura configuration changed. Reload its status");
    return { configured: true, settings: { enabled: value.data.enabled, clientId: value.data.clientId, clientSecretName: value.data.clientSecretName, callbackPort: value.data.callbackPort },
      enabled: value.data.enabled, signedIn: saved !== null, grantedScope: saved?.scope ?? null, expiresAt: saved?.expiresAt ?? null,
      note: "Saved tokens are not live connection proof. Null scope means Oura did not return a scope; only daily was requested." };
  }
  async start(requestGuard: () => void) {
    const settings = this.settings(), guard = () => this.check(settings, requestGuard); guard();
    const provider = await this.provider(settings, guard); guard();
    const answer = await this.deps.oauth.start(provider, { loopbackPort: settings.callbackPort });
    try { guard(); } catch (error) { await this.deps.oauth.cancel(answer.id); throw error; }
    this.deps.oauth.waitFor(answer.id).catch(() => undefined);
    return answer;
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue; let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous; try { return await work(); } finally { release(); }
  }
  async read(input: unknown, requestGuard: () => void) {
    const v = Range.parse(input);
    return this.exclusive(async () => {
      const settings = this.settings(), guard = () => this.check(settings, requestGuard); guard();
      const saved = await this.deps.oauth.saved(this.id(settings)); guard();
      if (!saved || (saved.scope !== null && !saved.scope.split(/\s+/).includes("daily"))) throw new Error("Sign in again and allow daily summaries");
      if (saved.expiresAt && Date.parse(saved.expiresAt) - 30000 <= Date.now()) throw new Error("Oura's returned expiry has been reached. Authorize daily scope again; this private connector does not refresh tokens automatically");
      const token = saved.accessToken; guard();
      const sleep = await this.collection("daily_sleep", v, token, guard), readiness = await this.collection("daily_readiness", v, token, guard), activity = await this.collection("daily_activity", v, token, guard);
      guard(); return { range: { start: v.start, end: v.end }, sleep, readiness, activity,
        note: "Private provider daily scores, not clinical interpretation. Missing data can mean no sync, no measurements, permission or membership limits. This form sends no data to models and persists no metrics." };
    });
  }
  private async collection(kind: "daily_sleep" | "daily_readiness" | "daily_activity", range: z.infer<typeof Range>, token: string, guard: () => void) {
    const rows: { day: string; score: number | null; steps?: number }[] = []; let next: string | null = null;
    for (let page = 0; page < 2; page++) {
      const query = new URLSearchParams({ start_date: range.start, end_date: range.end, fields: kind === "daily_activity" ? "day,score,steps" : "day,score" }); if (next) query.set("next_token", next);
      guard(); const response = await this.deps.fetch(`https://api.ouraring.com/v2/usercollection/${kind}?${query}`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Oura daily read failed (${response.status}); check consent, membership and rate limits. No automatic retry.`);
      const body = Page.parse(await readJson(response)); guard();
      rows.push(...body.data.filter(r => r.day >= range.start && r.day <= range.end).map(r => ({ day: r.day, score: r.score ?? null, ...(kind === "daily_activity" && r.steps !== undefined ? { steps: r.steps } : {}) })));
      next = body.next_token ?? null; if (!next) break;
    }
    return { rows, truncated: next !== null };
  }
}
