import { z } from "zod";
import type { Store } from "./store.js";
import type { NetworkPolicy } from "./network-policy.js";

// Fixed service origin: a device reply, redirect or stored value cannot choose where credentials go.
const origin = "https://keepoak.com";
const clientId = "branch-desktop", setting = "keepoak-connection", secret = "OAUTH_KEEPOAK";
const text = z.string().min(1).max(4000);
const Tokens = z.object({ access_token: text, refresh_token: text,
  token_type: z.enum(["Bearer", "bearer"]).default("Bearer"), expires_in: z.number().int().min(1).max(86400),
  scope: z.string().max(120).default("profile") }).loose();
const SavedTokens = z.object({ access: text, refresh: text, expiresAt: z.number().int().positive() }).strict();
type Saved = z.infer<typeof SavedTokens>;
const Device = z.object({ device_code: text, user_code: z.string().regex(/^OAK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
  verification_uri: z.literal(`${origin}/activate`), verification_uri_complete: z.string().max(1000).optional(),
  expires_in: z.number().int().min(1).max(1800), interval: z.number().int().min(1).max(300).default(5) }).loose();
const ServiceError = z.object({ error: z.union([z.string().max(80), z.object({ code: z.string().max(80) }).loose()]) }).loose();
const Profile = z.object({ id: z.string().min(1).max(200), email: z.string().max(320), name: z.string().max(200),
  plan: z.string().min(1).max(80), workspaces: z.array(z.object({ id: z.string().min(1).max(200),
    name: z.string().max(200), kind: z.enum(["personal", "team"]), role: z.enum(["owner", "admin", "member"]) })).max(100) });
interface Pending { code: string; userCode: string; verificationUrl: string; expiresAt: number; interval: number; nextAt: number }
export interface KeepOakDeps { store: Store; owner: string; policy: NetworkPolicy; requireOwner: () => void; fetch: typeof fetch }

/** Explicit owner requests only; no background polling, startup sign-in or paid/computer/team calls. */
export class KeepOakConnection {
  /** Optional local milestone consumer; never called for locker metadata or an unverified token reply. */
  onProfileVerified: (identity: { id: string }) => void = () => undefined;
  private pending: Pending | null = null;
  private busy = false;
  private revision = 0;
  constructor(private readonly deps: KeepOakDeps) {}

  state() {
    this.deps.requireOwner();
    const enabled = this.enabled();
    if (this.pending && this.pending.expiresAt <= Date.now()) this.pending = null;
    return { enabled, connected: this.deps.store.secrets.list(this.deps.owner, "default").some((entry) => entry.name === secret),
      pending: enabled && !!this.pending, ...(enabled && this.pending ? this.prompt(this.pending) : {}) };
  }
  enable() {
    this.deps.requireOwner();
    this.deps.store.save("settings", this.deps.owner, setting, { enabled: true });
    return this.state();
  }
  cancel() {
    this.deps.requireOwner();
    if (this.busy) throw new Error("A KeepOak request is still finishing. Try cancelling again in a moment.");
    this.close();
    return this.state();
  }
  /** Lock/shutdown forgets the short-lived device code without touching saved account keys. */
  close(): void { this.revision++; this.pending = null; }

  async begin() {
    return this.exclusive(async (revision) => {
      if (this.state().connected) throw new Error("Disconnect the current KeepOak account before signing in again.");
      const answer = await this.request("/oauth/device/code", new URLSearchParams({ client_id: clientId, scope: "profile" }), revision);
      if (!answer.ok) throw new Error("KeepOak could not start sign-in. Try again later.");
      const result = Device.safeParse(answer.body);
      if (!result.success) throw new Error("KeepOak sent an unsupported sign-in reply.");
      const device = result.data, now = Date.now();
      // Use the plain activation page unless the optional shortcut is exactly the same page and code.
      let verificationUrl: string = device.verification_uri;
      if (device.verification_uri_complete) {
        const url = new URL(device.verification_uri_complete);
        if (url.origin !== origin || url.pathname !== "/activate" || url.username || url.password || url.hash
          || [...url.searchParams.keys()].some((key) => key !== "user_code")
          || url.searchParams.getAll("user_code").length !== 1 || url.searchParams.get("user_code") !== device.user_code)
          throw new Error("KeepOak sent an unsupported activation address.");
        verificationUrl = url.href;
      }
      this.check(revision);
      this.deps.store.secrets.scrubber.remember("KEEPOAK_DEVICE_CODE", device.device_code);
      this.pending = { code: device.device_code, userCode: device.user_code, verificationUrl,
        expiresAt: now + device.expires_in * 1000, interval: device.interval * 1000, nextAt: now + device.interval * 1000 };
      return this.state();
    });
  }

  async poll() {
    return this.exclusive(async (revision) => {
      this.state();
      const pending = this.pending;
      if (!pending) return this.state();
      if (Date.now() < pending.nextAt) return this.state();
      pending.nextAt = Date.now() + pending.interval;
      let answer;
      try { answer = await this.request("/oauth/token", new URLSearchParams({ client_id: clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: pending.code }), revision); }
      catch (error) { pending.interval = Math.min(pending.interval * 2, 300_000); pending.nextAt = Date.now() + pending.interval; throw error; }
      if (Date.now() >= pending.expiresAt) { this.pending = null; throw new Error("The KeepOak sign-in code expired. Start again."); }
      if (answer.ok) { await this.save(answer.body, revision); this.pending = null; return this.state(); }
      const code = errorCode(answer.body);
      if (code === "authorization_pending" || code === "slow_down") {
        if (code === "slow_down") pending.interval += 5000; // RFC 8628: all subsequent polls wait five seconds longer.
        pending.nextAt = Date.now() + pending.interval;
        return this.state();
      }
      this.pending = null;
      throw new Error(code === "access_denied" ? "KeepOak sign-in was declined." : code === "expired_token"
        ? "The KeepOak sign-in code expired. Start again." : "KeepOak could not finish sign-in. Start again.");
    });
  }

  async profile() {
    return this.exclusive(async (revision) => {
      let saved = await this.saved(revision);
      if (saved.expiresAt - 30_000 <= Date.now()) saved = await this.refresh(saved, revision);
      let answer = await this.request("/api/v1/me", null, revision, saved.access);
      if (answer.status === 401) {
        saved = await this.refresh(saved, revision);
        answer = await this.request("/api/v1/me", null, revision, saved.access);
      }
      if (!answer.ok) throw new Error("KeepOak could not read your profile. The connection has been kept.");
      const result = Profile.safeParse(answer.body);
      if (!result.success) throw new Error("KeepOak sent an unsupported profile reply.");
      this.check(revision);
      this.onProfileVerified({ id: result.data.id });
      return result.data;
    });
  }

  async disconnect() {
    return this.exclusive(async (revision) => {
      if (this.state().connected) {
        const saved = await this.saved(revision);
        // Revoke both keys: success does not assume the server also revoked other tokens from the grant.
        for (const [token, hint] of [[saved.refresh, "refresh_token"], [saved.access, "access_token"]] as const) {
          const answer = await this.request("/oauth/revoke", new URLSearchParams({ client_id: clientId,
            token, token_type_hint: hint }), revision, undefined, false);
          if (!answer.ok) throw new Error("KeepOak did not confirm disconnect. Your connection has been kept; try again.");
        }
        this.check(revision);
        this.deps.store.secrets.remove(this.deps.owner, "default", secret);
      }
      this.pending = null;
      this.deps.store.save("settings", this.deps.owner, setting, { enabled: false });
      return this.state();
    });
  }

  private enabled(): boolean { return this.deps.store.get("settings", this.deps.owner, setting)?.data.enabled === true; }
  private check(revision: number) {
    this.deps.requireOwner();
    if (!this.enabled()) throw new Error("Enable the KeepOak connection first.");
    if (revision !== this.revision) throw new Error("This KeepOak sign-in was cancelled.");
  }
  private async exclusive<T>(work: (revision: number) => Promise<T>): Promise<T> {
    this.check(this.revision);
    if (this.busy) throw new Error("A KeepOak connection request is still finishing. Try again in a moment.");
    this.busy = true;
    try { return await work(this.revision); } finally { this.busy = false; }
  }
  private prompt(pending: Pending) {
    return { userCode: pending.userCode, verificationUrl: pending.verificationUrl,
      expiresAt: new Date(pending.expiresAt).toISOString(), pollAfterMs: Math.max(0, pending.nextAt - Date.now()) };
  }
  private async saved(revision: number): Promise<Saved> {
    this.check(revision);
    const values = await this.deps.store.secrets.resolve(this.deps.owner, "default", [secret], { purpose: "KeepOak connection" });
    this.check(revision);
    let result;
    try { result = SavedTokens.safeParse(JSON.parse(values[secret] ?? "null") as unknown); }
    catch { throw new Error("The saved KeepOak connection cannot be read."); }
    if (!result.success) throw new Error("There is no usable KeepOak connection. Sign in again.");
    this.remember(result.data);
    return result.data;
  }
  private remember(saved: Saved) {
    this.deps.store.secrets.scrubber.remember(secret, saved.access);
    this.deps.store.secrets.scrubber.remember(`${secret}_REFRESH`, saved.refresh);
  }
  private async save(body: unknown, revision: number): Promise<Saved> {
    this.check(revision);
    const result = Tokens.safeParse(body);
    if (!result.success || result.data.scope.trim() !== "profile") throw new Error("KeepOak sent unsupported connection keys or scopes.");
    const saved = { access: result.data.access_token, refresh: result.data.refresh_token,
      expiresAt: Date.now() + result.data.expires_in * 1000 };
    this.remember(saved);
    await this.deps.store.secrets.put(this.deps.owner, "default", secret, JSON.stringify(saved));
    this.check(revision);
    return saved;
  }
  private async refresh(saved: Saved, revision: number): Promise<Saved> {
    const answer = await this.request("/oauth/token", new URLSearchParams({ client_id: clientId,
      grant_type: "refresh_token", refresh_token: saved.refresh }), revision);
    if (!answer.ok) throw new Error("KeepOak could not renew sign-in. The saved connection has been kept.");
    return this.save(answer.body, revision);
  }
  private async request(path: string, form: URLSearchParams | null, revision: number, bearer?: string, json = true) {
    this.check(revision);
    const target = new URL(path, origin);
    await this.deps.policy.assertAllowed(target, "KeepOak connection address");
    this.check(revision); // Owner/profile/lock and cancellation are checked after every asynchronous boundary.
    let response: Response;
    const checkedFetch = this.deps.policy.guard((input, init) => {
      this.check(revision); // The guarded sender rechecks after the policy's asynchronous DNS lookup too.
      return this.deps.fetch(input, init);
    });
    try { response = await checkedFetch(target, { method: form ? "POST" : "GET", redirect: "error",
      headers: { accept: "application/json", ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(form ? { body: form.toString() } : {}),
      signal: AbortSignal.timeout(20_000) }); }
    catch { this.check(revision); throw new Error("KeepOak could not be reached. Try again later."); }
    this.check(revision);
    if (!json) { await response.body?.cancel(); this.check(revision); return { ok: response.ok, status: response.status, body: null }; }
    let body: unknown;
    try { body = await boundedJson(response, () => this.check(revision)); }
    catch { this.check(revision); throw new Error("KeepOak sent an unreadable or oversized reply."); }
    this.check(revision);
    return { ok: response.ok, status: response.status, body };
  }
}

function errorCode(value: unknown): string | null {
  const parsed = ServiceError.safeParse(value);
  return parsed.success ? typeof parsed.data.error === "string" ? parsed.data.error : parsed.data.error.code : null;
}
async function boundedJson(response: Response, check: () => void): Promise<unknown> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body)
    throw new Error("Expected JSON");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      check();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 131072) throw new Error("Reply too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
