import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import type { OAuthConnections } from "../oauth.js";
import { currentPerson } from "../people/context.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { lockdownActive } from "../lockdown.js";

const Settings = z.object({ enabled: z.boolean(), clientId: z.string().trim().min(1).max(300), clientSecretName: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/), callbackPort: z.number().int().min(1024).max(65535) }).strict();
const Saved = Settings.extend({ grant: z.string().uuid() });
const providers = {
  oura: { label: "Oura daily summaries", authorizeUrl: "https://cloud.ouraring.com/oauth/authorize", tokenUrl: "https://api.ouraring.com/oauth/token", scopes: ["daily"] },
  whoop: { label: "WHOOP private sleep/recovery", authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth", tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token", scopes: ["read:sleep", "read:recovery"] },
};
export type WearableDeps = { store: Store; owner: string; oauth: Pick<OAuthConnections, "start" | "saved" | "waitFor" | "cancel">;
  fetch: typeof fetch; secret: (name: string, purpose: string) => Promise<string>; requireOwner: (what: string) => void };
export const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(day => !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day, "Use a real calendar date");
export const WearableRange = z.object({ start: Day, end: Day, approvePrivateRead: z.literal(true) }).strict().refine(v => {
  const days = (Date.parse(v.end) - Date.parse(v.start)) / 86400000; return days >= 0 && days <= 30;
}, "Choose an ordered range of at most 31 days");
export async function wearableJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("The wearable provider returned no data");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 256000) { await reader.cancel(); throw new Error("Wearable response exceeds the private read limit"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
}

/** Two concrete OAuth accounts share opt-in/identity/expiry gates, never automatic refresh. */
export class WearableAccount {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly deps: WearableDeps, private readonly service: "oura" | "whoop") {}
  guard(): void {
    this.deps.requireOwner("Private wearable data"); this.deps.store.profiles.requireOwner("Private wearable data");
    if (currentPerson() || startedWithShortLivedKey() || lockdownActive(this.deps.store, this.deps.owner)) throw new Error("Use wearable data in the owner's app window with Lockdown off");
  }
  private key() { return `wearable-${this.service}`; }
  private settings() {
    const value = Saved.safeParse(this.deps.store.get("settings", this.deps.owner, this.key())?.data);
    if (!value.success) throw new Error("This wearable is off. Save its explicit application configuration first");
    return value.data;
  }
  private id(settings: z.infer<typeof Saved>) { return `wearable-${this.service}-${settings.grant.replaceAll("-", "").slice(0, 20)}`; }
  private check(settings: z.infer<typeof Saved>, requestGuard: () => void): void {
    this.guard(); requestGuard();
    if (!settings.enabled || JSON.stringify(this.settings()) !== JSON.stringify(settings)) throw new Error("The wearable is disabled or its account configuration changed. Sign in again");
  }
  async configure(input: unknown, requestGuard: () => void) {
    this.guard(); requestGuard(); const value = Settings.parse(input), old = Saved.safeParse(this.deps.store.get("settings", this.deps.owner, this.key())?.data);
    this.deps.store.save("settings", this.deps.owner, this.key(), { ...value, grant: randomUUID() });
    if (old.success) await this.deps.oauth.cancel(this.id(old.data));
    return { configured: true, enabled: value.enabled, note: "Configuration change invalidated local account access. Sign in again if enabled; provider app permission must be revoked separately." };
  }
  async disable(requestGuard: () => void) {
    this.guard(); requestGuard(); const s = this.settings();
    return this.configure({ enabled: false, clientId: s.clientId, clientSecretName: s.clientSecretName, callbackPort: s.callbackPort }, requestGuard);
  }
  async status(requestGuard: () => void) {
    this.guard(); requestGuard(); const value = Saved.safeParse(this.deps.store.get("settings", this.deps.owner, this.key())?.data);
    if (!value.success) return { configured: false, enabled: false, signedIn: false, grantedScope: null };
    const saved = await this.deps.oauth.saved(this.id(value.data)); this.guard(); requestGuard();
    if (JSON.stringify(this.settings()) !== JSON.stringify(value.data)) throw new Error("The wearable configuration changed. Reload status");
    return { configured: true, settings: { enabled: value.data.enabled, clientId: value.data.clientId, clientSecretName: value.data.clientSecretName, callbackPort: value.data.callbackPort }, enabled: value.data.enabled,
      signedIn: saved !== null, grantedScope: saved?.scope ?? null, expiresAt: saved?.expiresAt ?? null, requestedScopes: providers[this.service].scopes,
      note: "Saved tokens are not live connection proof. Null scope means the provider did not return a scope." };
  }
  async start(requestGuard: () => void) {
    const settings = this.settings(), guard = () => this.check(settings, requestGuard); guard();
    const clientSecret = await this.deps.secret(settings.clientSecretName, `${this.service} private read OAuth`); guard();
    const answer = await this.deps.oauth.start({ ...providers[this.service], id: this.id(settings), clientId: settings.clientId, clientSecret, extra: {} }, { loopbackPort: settings.callbackPort });
    try { guard(); } catch (error) { await this.deps.oauth.cancel(answer.id); throw error; }
    this.deps.oauth.waitFor(answer.id).catch(() => undefined); return answer;
  }
  async authorized<T>(requestGuard: () => void, work: (token: string, guard: () => void) => Promise<T>): Promise<T> {
    const previous = this.queue; let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const settings = this.settings(), guard = () => this.check(settings, requestGuard); guard();
      const saved = await this.deps.oauth.saved(this.id(settings)); guard();
      if (!saved || (saved.scope !== null && !providers[this.service].scopes.every(scope => saved.scope!.split(/\s+/).includes(scope)))) throw new Error("Sign in again and allow this wearable's requested read scopes");
      if (saved.expiresAt && Date.parse(saved.expiresAt) - 30000 <= Date.now()) throw new Error("The provider's returned expiry has been reached. Authorize again; this private connector never refreshes tokens automatically");
      return await work(saved.accessToken, guard);
    } finally { release(); }
  }
}
