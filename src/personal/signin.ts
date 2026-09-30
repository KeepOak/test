import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import type { OAuthConnections, OAuthProvider, OAuthStart } from "../oauth.js";
import type { Store } from "../store.js";
import { callJson } from "../channels/parity-common.js";
import { partSettings, savePartSettings, secretNameSchema, type PersonalPart } from "./settings.js";
import { PersonalAccounts, personalProviderId, personalSettingsKey } from "./accounts.js";

/**
 * R17-C: signing in to the owner's own Google, Microsoft and Spotify accounts. Nothing new is
 * invented here: each service is described as an `OAuthProvider` and handed to the existing
 * connection flow (`OAuthConnections`, the one behind /api/connections/oauth/start), which opens the
 * service's own page, takes the answer on this computer only, and keeps the tokens in the locker.
 *
 * The owner brings their own app registration: a client id typed in, and — only where the service
 * insists on one (Google's desktop clients do) — a client secret saved in Secrets under a name. The
 * secret itself is never in a settings record, a log or an answer.
 */
export type SignInService = "google" | "microsoft" | "spotify";

export const SignInSettingsSchema = z.object({
  clientId: z.string().trim().max(300).default(""),
  /** The name of a secret holding the client secret, or "" for a public client (PKCE alone). */
  clientSecretName: z.union([z.literal(""), secretNameSchema]).default(""),
  /** Microsoft only: the directory to sign in to; "common" lets any work, school or personal account in. */
  tenant: z.string().trim().regex(/^[A-Za-z0-9.-]{1,80}$/).default("common"),
  /** Google and Microsoft: also ask for leave to write drafts. Off by default; nothing ever sends mail. */
  drafts: z.boolean().default(false),
  /** Explicit opt-in; a new provider consent is required before calendar writes. */
  calendarWrite: z.boolean().default(false),
  /** Separate send-only scope, never enabled by permission to write provider drafts. */
  mailSend: z.boolean().default(false),
  /** Read shared free/busy data only after a separate owner opt-in and new consent. */
  availability: z.boolean().default(false),
}).strict();
export type SignInSettings = z.infer<typeof SignInSettingsSchema>;


/** The scopes each service is asked for. Read-only unless the owner turned drafts on. */
export function scopesFor(service: SignInService, drafts: boolean, calendarWrite = false, mailSend = false, availability = false): string[] {
  if (service === "google") return [
    "https://www.googleapis.com/auth/gmail.readonly",
    calendarWrite ? "https://www.googleapis.com/auth/calendar.events" : "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    // Gmail has no drafts-only scope; this one could also send, which Branch never does.
    ...(drafts ? ["https://www.googleapis.com/auth/gmail.compose"] : []),
    ...(mailSend ? ["https://www.googleapis.com/auth/gmail.send"] : []),
    ...(availability ? ["https://www.googleapis.com/auth/calendar.freebusy"] : []),
  ];
  if (service === "microsoft") return [
    "offline_access", "User.Read", drafts ? "Mail.ReadWrite" : "Mail.Read", calendarWrite ? "Calendars.ReadWrite" : "Calendars.Read",
    "OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All",
    ...(mailSend ? ["Mail.Send"] : []),
  ];
  return ["user-read-playback-state", "user-read-currently-playing", "user-modify-playback-state"];
}

const labels: Record<SignInService, string> = { google: "Google", microsoft: "Microsoft", spotify: "Spotify" };

/** The service described for the existing connection flow, without its client secret. */
export function describeSignIn(service: SignInService, settings: SignInSettings, account = "default"): OAuthProvider {
  const base = { id: personalProviderId(service, account), label: labels[service], clientId: settings.clientId,
    scopes: scopesFor(service, settings.drafts, settings.calendarWrite, settings.mailSend, settings.availability), extra: {} as Record<string, string> };
  if (service === "google") return { ...base, authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token", extra: { access_type: "offline", prompt: account === "default" ? "consent" : "consent select_account" } };
  if (service === "microsoft") {
    const root = `https://login.microsoftonline.com/${encodeURIComponent(settings.tenant)}/oauth2/v2.0`;
    return { ...base, authorizeUrl: `${root}/authorize`, tokenUrl: `${root}/token`,
      extra: account !== "default" ? { prompt: "select_account" } : settings.calendarWrite || settings.mailSend ? { prompt: "consent" } : {} };
  }
  return { ...base, authorizeUrl: "https://accounts.spotify.com/authorize", tokenUrl: "https://accounts.spotify.com/api/token" };
}

export interface SignInDeps {
  store: Store;
  owner: string;
  oauth: Pick<OAuthConnections, "start" | "waitFor" | "saved" | "accessToken">;
  /** A named secret from the locker, filled in at the moment it is needed. */
  secret: (name: string, purpose: string) => Promise<string>;
}

/** One service's sign-in: its settings, starting it, whether it is done, and a usable access key. */
export class SignIn {
  private readonly accountContext = new AsyncLocalStorage<string>();
  readonly accounts: PersonalAccounts;
  constructor(private readonly deps: SignInDeps, readonly service: SignInService, readonly part: PersonalPart,
    private readonly fixedAccount?: string, private readonly revisions = new Map<string, number>()) {
    this.accounts = new PersonalAccounts(deps.store, deps.owner, service);
  }
  accountId(): string { return this.accounts.resolve(this.fixedAccount ?? this.accountContext.getStore()); }
  forAccount(id: string): SignIn { return new SignIn(this.deps, this.service, this.part, this.accounts.resolve(id), this.revisions); }
  /** Bind one operation before its first await; concurrent tasks and later UI selections cannot reroute it. */
  withAccount<T>(id: string | undefined, work: () => Promise<T>): Promise<T> {
    return this.inAccount(id, work);
  }
  inAccount<T>(id: string | undefined, work: () => T): T { return this.accountContext.run(this.accounts.resolve(id ?? this.fixedAccount), work); }
  settings(): SignInSettings { return partSettings(this.deps.store, this.deps.owner, personalSettingsKey(this.service, this.accountId()), SignInSettingsSchema); }
  private changed(): void { const id = this.accountId(); this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1); }
  save(input: unknown): SignInSettings {
    const settings = savePartSettings(this.deps.store, this.deps.owner, personalSettingsKey(this.service, this.accountId()), SignInSettingsSchema, input);
    this.changed();
    return settings;
  }
  /** The full description, with the client secret filled in from the locker when one is named. */
  async provider(): Promise<OAuthProvider> {
    const settings = this.settings();
    if (!settings.clientId) throw new Error(`Add the client id of your own ${labels[this.service]} app first.`);
    const described = describeSignIn(this.service, settings, this.accountId());
    if (!settings.clientSecretName) return described;
    const clientSecret = await this.deps.secret(settings.clientSecretName, `signing in to ${labels[this.service]}`);
    return { ...described, clientSecret };
  }
  /** Starts the sign-in through the existing flow; the owner opens the address it hands back. */
  async start(): Promise<OAuthStart> {
    this.changed();
    const started = await this.deps.oauth.start(await this.provider());
    this.deps.oauth.waitFor(started.id).catch(() => undefined);
    return started;
  }
  async status(): Promise<{ signedIn: boolean; expiresAt: string | null; scope: string | null }> {
    const tokens = await this.deps.oauth.saved(personalProviderId(this.service, this.accountId()));
    return { signedIn: tokens !== null, expiresAt: tokens?.expiresAt ?? null, scope: tokens?.scope ?? null };
  }
  /** A usable access key, renewed first when it has run out. */
  async token(): Promise<string> {
    return this.deps.oauth.accessToken(await this.provider());
  }
  async requireCalendarWrite(): Promise<void> {
    if (!this.settings().calendarWrite) throw new Error("Allow calendar changes on your account card, then sign in again.");
    const tokens = await this.deps.oauth.saved(personalProviderId(this.service, this.accountId()));
    const scope = this.service === "google" ? "https://www.googleapis.com/auth/calendar.events" : "Calendars.ReadWrite";
    if (!tokens?.scope?.split(/\s+/).includes(scope))
      throw new Error("Sign in again and consent to calendar changes. Your saved read-only grant cannot write events.");
  }
  mailPreviewIdentity(): string { return JSON.stringify([this.service, this.accountId(), this.settings(), this.revisions.get(this.accountId()) ?? 0]); }
  async requireMailSend(): Promise<void> {
    if (!this.settings().mailSend) throw new Error("Allow sending mail on your account card, then sign in again.");
    const tokens = await this.deps.oauth.saved(personalProviderId(this.service, this.accountId()));
    const scope = this.service === "google" ? "https://www.googleapis.com/auth/gmail.send" : "Mail.Send";
    if (!tokens?.scope?.split(/\s+/).includes(scope))
      throw new Error("Sign in again and consent to sending mail. A read or drafts grant cannot enable Branch's Send tool.");
  }
}

/**
 * A JSON call to a signed-in service. `fetch` is the one that follows the owner's network rules, so
 * every call is checked; the key travels only in the Authorization header.
 */
export async function signedCall(fetchImpl: typeof fetch, signIn: Pick<SignIn, "token">, service: string, url: string,
  init: RequestInit & { json?: unknown } = {}): Promise<unknown> {
  const token = await signIn.token();
  return callJson(fetchImpl, service, url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
}

/** The same call, for an answer that is text rather than JSON (a Drive file, a meeting transcript). */
export async function signedText(fetchImpl: typeof fetch, signIn: Pick<SignIn, "token">, service: string, url: string, maxBytes: number): Promise<string> {
  const token = await signIn.token();
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${service} refused the request (${response.status})`);
  return new TextDecoder().decode(await firstBytes(response, maxBytes));
}

/** At most `maxBytes` of an answer, without holding the rest of a huge file in memory (integration review). */
async function firstBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, maxBytes);
}
