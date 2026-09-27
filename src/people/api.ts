import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { audit } from "../audit.js";
import { runForCurrentPerson } from "../collab-server.js";
import type { Message } from "../contracts.js";
import type { createBranch } from "../index.js";
import { shortLivedKeyMark, startedWithShortLivedKey } from "../key-context.js";
import { requestSource } from "../auth-limits.js";
import { currentPerson } from "./context.js";
import { oidcPresets, savePeopleSettings, signInMethods } from "./settings.js";
import type { Where } from "./sign-in.js";
import { verifyRegistration } from "./webauthn.js";
import { lentOwner } from "./lending.js";

/**
 * Bucket 19: the web routes for people signing in from their own device, their own page, and the
 * owner's card that sets it all up. Three kinds of caller, kept apart:
 *
 *   - nobody yet (`/api/people/sign-in…`, `/api/people/oidc/callback`): answered before any key is
 *     checked, only while the switch is on, only from this app's own pages, and counted per place;
 *   - a person, with the key they were given: only their own things (src/people/access.ts);
 *   - the owner at the window: everything else here, and never with a short-lived key.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
type ReadBody = () => Promise<unknown>;
export const notPeople = Symbol("not a people route");
export class PeopleHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const idPattern = "[a-f0-9-]{36}";
const PromptSchema = z.object({ prompt: z.string().trim().min(1).max(16000) }).strict();

/**
 * Where this request came in, for passkeys and identity services. The host was already checked.
 * Integration review: a door served over TLS is an https origin. Only the socket itself says so; a
 * header such as X-Forwarded-Proto is written by the caller and would let them pick the origin.
 */
export function whereOf(request: IncomingMessage): Where {
  const host = String(request.headers.host ?? "127.0.0.1");
  const secure = (request.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
  const origin = `${secure ? "https" : "http"}://${host}`;
  return { origin, rpId: new URL(origin).hostname, redirectUri: `${origin}/api/people/oidc/callback` };
}

/* ---------- before any key: signing in ---------- */

const StartSchema = z.object({ name: z.string().trim().min(1).max(40), device: z.string().max(120).default("A device") }).strict();
const StepSchema = z.object({
  ticket: z.string().min(10).max(64), method: z.enum(signInMethods), stage: z.enum(["begin", "finish"]),
  pin: z.string().max(16).optional(), provider: z.string().max(40).optional(), credential: z.unknown().optional(),
  // An identity service's answer, carried by the page that started the sign-in.
  code: z.string().max(2048).optional(), state: z.string().max(128).optional(),
}).strict();
const CodeSchema = z.object({ name: z.string().trim().min(1).max(40), code: z.string().min(4).max(16), device: z.string().max(120).default("A device") }).strict();

/** Handles a sign-in route that needs no key. Answers false when the path is not one of them. */
export async function peopleSignInRoute(app: Branch, request: IncomingMessage, response: ServerResponse, path: string,
  body: ReadBody, send: (status: number, value: unknown) => void): Promise<boolean> {
  if (!path.startsWith("/api/people/sign-in") && path !== "/api/people/oidc/callback") return false;
  const people = app.people;
  if (!people.enabled()) { send(404, { error: "Not found" }); return true; }
  const from = requestSource(request.socket?.remoteAddress, request.headers);
  const waiting = people.limiter.refusal(from, "sign-in");
  if (waiting) { send(429, { error: waiting }); return true; }
  try {
    if (path === "/api/people/oidc/callback") return oidcCallback(app, request, response);
    send(200, await signInAnswer(app, request, path, body));
    if (path.endsWith("/finish") || path.endsWith("/code")) people.limiter.succeed(from);
  } catch (error) {
    const state = people.limiter.fail(from);
    if (state.until) audit(app.store, app.runtime.owner, { action: "auth.refused", actor: from, subject: "the sign-in page",
      reason: "Too many wrong answers on the page people sign in with", outcome: "waiting" });
    send(error instanceof PeopleHttpError ? error.status : 400, { error: error instanceof Error ? error.message : "That did not work" });
  }
  return true;
}

async function signInAnswer(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown> {
  const people = app.people, method = request.method ?? "GET";
  if (method === "GET" && path === "/api/people/sign-in") {
    const settings = people.settings();
    return { enabled: true, chain: settings.chain, providers: settings.providers.map((p) => ({ id: p.id, label: p.label })) };
  }
  if (method !== "POST") throw new PeopleHttpError(404, "Not found");
  if (path === "/api/people/sign-in/start") {
    const input = StartSchema.parse(await body());
    return people.signIns.start(input.name, input.device);
  }
  if (path === "/api/people/sign-in/step") {
    const { ticket, method: step, stage, ...rest } = StepSchema.parse(await body());
    return people.signIns.step(ticket, step, stage, rest, whereOf(request));
  }
  if (path === "/api/people/sign-in/finish") {
    const { ticket } = z.object({ ticket: z.string().min(10).max(64) }).strict().parse(await body());
    return issueKey(app, people.signIns.complete(ticket));
  }
  if (path === "/api/people/sign-in/code") return redeemCode(app, CodeSchema.parse(await body()));
  throw new PeopleHttpError(404, "Not found");
}

function issueKey(app: Branch, done: { profileId: string; method: string; device: string }, minutes?: number) {
  const people = app.people;
  const profile = people.profiles.list().find((each) => each.id === done.profileId);
  if (!profile) throw new Error("That person is no longer on this computer.");
  const issued = people.keys.issue(done.profileId, minutes ?? people.settings().sessionMinutes, done.method, done.device);
  audit(app.store, app.runtime.owner, { action: "token.issued", actor: profile.name, subject: `${profile.name} on ${done.device}`,
    reason: `Signed in from another device (${done.method})`, outcome: "issued" });
  return { key: issued.key, expiresAt: issued.entry.expiresAt, name: profile.name, setupOnly: done.method === "setup" };
}

function redeemCode(app: Branch, input: z.infer<typeof CodeSchema>) {
  const people = app.people;
  const profile = people.profiles.byName(input.name);
  people.resetCodes.redeem(profile?.id ?? null, input.code);
  people.keys.revokeAll(profile!.id);
  return issueKey(app, { profileId: profile!.id, method: "setup", device: input.device }, 15);
}

/**
 * The identity service sends the browser back here. Integration review: nothing is finished here.
 * The answer is passed on, in the part of the address that never leaves the browser, to the page,
 * and only the page that started this sign-in holds the ticket it belongs to. An answer that lands
 * in somebody else's browser (a link an attacker sent) therefore finishes nobody's sign-in.
 */
async function oidcCallback(_app: Branch, request: IncomingMessage, response: ServerResponse): Promise<true> {
  const url = new URL(request.url ?? "/", "http://local");
  const code = url.searchParams.get("code") ?? "", state = url.searchParams.get("state") ?? "";
  const fragment = code && state && code.length <= 2048 && state.length <= 128
    ? `oidc=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` : "error=signin";
  response.writeHead(302, { location: `/people#${fragment}`, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
  return true;
}

/* ---------- after the key ---------- */

/** Every keyed /api/people route. Answers `notPeople` for any other path. */
export async function peopleApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown> {
  if (!path.startsWith("/api/people/")) return notPeople;
  const person = currentPerson();
  if (person) return personApi(app, request, path, body, person);
  if (request.method === "GET" && path === "/api/people/handoff") return handoffView(app);
  if (startedWithShortLivedKey()) throw new PeopleHttpError(401, "A short-lived key cannot change who may sign in. Do that in the app window.");
  app.store.profiles.requireOwner("Deciding who may sign in from other devices");
  return ownerApi(app, request, path, body);
}

/** A key handed to another device: the one conversation it was made for, and nothing else. */
function handoffView(app: Branch): unknown {
  const { sessionId } = shortLivedKeyMark();
  if (!sessionId) throw new PeopleHttpError(404, "Not found");
  return { sessionId, messages: visible(app, app.store.sessionView(app.runtime.owner, sessionId).messages) };
}

function visible(app: Branch, messages: Message[]): { role: string; content: string }[] {
  return messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.from !== "branch").slice(-200)
    .map((m) => ({ role: m.role, content: app.runtime.hideSecrets(String(m.content)).slice(0, 20000) }));
}

/* ---------- a person's own page ---------- */

type Mark = { profileId: string; keyId: string };

async function personApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody, person: Mark): Promise<unknown> {
  const people = app.people, method = request.method ?? "GET";
  const profile = app.store.profiles.active()!;
  if (method === "GET" && path === "/api/people/me") {
    const entry = people.entryFor(person.keyId);
    return { name: profile.name, expiresAt: entry?.expiresAt ?? null, setupOnly: entry?.method === "setup",
      grant: app.runtime.roles.effective(profile.id), groups: people.groups.groupsOf(profile.id).map((g) => g.name) };
  }
  if (method === "POST" && path === "/api/people/me/sign-out") {
    await body();
    return { signedOut: people.keys.revoke(person.keyId, person.profileId) };
  }
  if (method === "POST" && path === "/api/people/me/pin") return changePin(app, person, await body());
  if (path.startsWith("/api/people/me/passkeys")) return passkeyApi(app, request, path, body, person);
  if (path.startsWith("/api/people/conversations")) return conversationApi(app, request, path, body, person);
  throw new PeopleHttpError(404, "Not found");
}

function changePin(app: Branch, person: Mark, input: unknown): unknown {
  const value = z.object({ current: z.string().max(16).optional(), pin: z.string().regex(/^\d{4,8}$/, "A PIN is four to eight digits") })
    .strict().parse(input);
  const setupOnly = app.people.entryFor(person.keyId)?.method === "setup";
  // A person changing their PIN says the old one first; only the owner's one-time code skips that.
  if (!setupOnly) app.store.profiles.verifyPin(person.profileId, value.current ?? "");
  app.store.profiles.setPin(person.profileId, value.pin);
  // Every other sign-in of theirs ends; this one carries on.
  for (const entry of app.people.keys.list(person.profileId))
    if (entry.id !== person.keyId) app.people.keys.revoke(entry.id, person.profileId);
  audit(app.store, app.runtime.owner, { action: "policy.changed", actor: app.store.profiles.active()!.name,
    subject: "their own PIN", reason: setupOnly ? "Set with the owner's one-time code" : "Changed by the person", outcome: "saved" });
  return { changed: true };
}

const RegistrationSchema = z.object({
  name: z.string().trim().max(80).default("A passkey"),
  credential: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,1024}$/), clientDataJSON: z.string().max(4096),
    attestationObject: z.string().max(16384) }).strict(),
}).strict();

async function passkeyApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody, person: Mark): Promise<unknown> {
  const passkeys = app.people.passkeys, where = whereOf(request), method = request.method ?? "GET";
  if (method === "GET" && path === "/api/people/me/passkeys") return { passkeys: passkeys.describe(person.profileId) };
  if (method !== "POST") throw new PeopleHttpError(404, "Not found");
  if (path === "/api/people/me/passkeys/begin") {
    await body();
    const challenge = challenges.issue(person.keyId);
    const profile = app.store.profiles.active()!;
    return { challenge, rp: { id: where.rpId, name: "Branch" },
      user: { id: Buffer.from(profile.id).toString("base64url"), name: profile.name, displayName: profile.name },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      attestation: "none", excludeCredentials: passkeys.of(person.profileId).map((p) => p.credentialId), timeout: 120000,
      // Integration review: the device must check who is holding it, here and at every sign-in.
      authenticatorSelection: { userVerification: "required", residentKey: "discouraged" } };
  }
  if (path === "/api/people/me/passkeys/finish") {
    const input = RegistrationSchema.parse(await body());
    const challenge = challenges.take(person.keyId);
    if (!challenge) throw new Error("That registration has run out. Start again.");
    const stored = verifyRegistration(input.credential, { challenge, origin: where.origin, rpId: where.rpId });
    passkeys.add(person.profileId, stored, input.name);
    return { passkeys: passkeys.describe(person.profileId) };
  }
  if (path === "/api/people/me/passkeys/remove") {
    const { id } = z.object({ id: z.string().max(1024) }).strict().parse(await body());
    return { removed: passkeys.remove(person.profileId, id) };
  }
  throw new PeopleHttpError(404, "Not found");
}

/** One registration challenge per key, for two minutes. */
const challenges = new (class {
  private readonly open = new Map<string, { value: string; until: number }>();
  issue(keyId: string): string {
    const value = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    this.open.set(keyId, { value, until: Date.now() + 120_000 });
    if (this.open.size > 500) this.open.delete(this.open.keys().next().value!);
    return value;
  }
  take(keyId: string): string | null {
    const found = this.open.get(keyId);
    this.open.delete(keyId);
    return found && found.until > Date.now() ? found.value : null;
  }
})();

async function conversationApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody, person: Mark): Promise<unknown> {
  const method = request.method ?? "GET", scope = app.store.profiles.scope();
  if (method === "GET" && path === "/api/people/conversations") {
    const shared = app.people.groups.sharedWith(person.profileId).filter((s) => app.store.ownsSession(app.runtime.owner, s.sessionId));
    return { own: app.store.recentSessions(scope, 50), shared };
  }
  if (method === "POST" && path === "/api/people/conversations") {
    const { prompt } = PromptSchema.parse(await body());
    return summary(app, await runForCurrentPerson(app, { prompt }));
  }
  const match = new RegExp(`^/api/people/conversations/(${idPattern})(/message)?$`).exec(path);
  if (!match) throw new PeopleHttpError(404, "Not found");
  const sessionId = match[1]!, access = accessTo(app, person, sessionId);
  if (method === "GET" && !match[2]) {
    // A person's own conversation is lent to the assistant while their task runs.
    const holder = app.store.ownsSession(scope, sessionId) ? scope : app.runtime.owner;
    return { sessionId, access, messages: visible(app, app.store.sessionView(holder, sessionId).messages) };
  }
  if (method !== "POST" || !match[2]) throw new PeopleHttpError(404, "Not found");
  const { prompt } = PromptSchema.parse(await body());
  if (access === "viewer") throw new PeopleHttpError(403, "This conversation was shared with you to read. Ask the owner to let you join in.");
  if (access === "own") return summary(app, await lend(app, sessionId, prompt));
  // A shared conversation stays the owner's; what the person says is marked with their name, and
  // their own role and limits hold for everything the task does.
  const name = app.store.profiles.active()!.name;
  return summary(app, await app.runtime.run({ sessionId, prompt: `${name}: ${prompt}` }));
}

/** "own", "driver" or "viewer"; anything else is not found, whoever's it is. */
function accessTo(app: Branch, person: Mark, sessionId: string): "own" | "driver" | "viewer" {
  const scope = app.store.profiles.scope();
  if (app.store.ownsSession(scope, sessionId)) return "own";
  // Integration review: a person's conversation lent to the assistant is theirs alone, never a shared one.
  const lent = lentOwner(app.store, sessionId);
  if (lent) {
    if (lent === scope && app.store.ownsSession(app.runtime.owner, sessionId)) return "own";
    throw new PeopleHttpError(404, "Conversation not found");
  }
  if (app.store.ownsSession(app.runtime.owner, sessionId)) {
    if (app.people.groups.check(person.profileId, "driver", sessionId)) return "driver";
    if (app.people.groups.check(person.profileId, "viewer", sessionId)) return "viewer";
  }
  throw new PeopleHttpError(404, "Conversation not found");
}

async function lend(app: Branch, sessionId: string, prompt: string) {
  // While a task runs the conversation is lent to the assistant; it is already written down as theirs.
  if (!app.store.ownsSession(app.store.profiles.scope(), sessionId)) throw new PeopleHttpError(409, "Your last message is still being answered. Wait for it, then send this one.");
  return runForCurrentPerson(app, { sessionId, prompt });
}

function summary(app: Branch, run: { id: string; sessionId: string; status: string; output?: string | null }): unknown {
  return { runId: run.id, sessionId: run.sessionId, status: run.status, output: app.runtime.hideSecrets(String(run.output ?? "")) };
}

/* ---------- the owner's card ---------- */

function ownerView(app: Branch): unknown {
  const people = app.people, profiles = app.store.profiles.list();
  return {
    settings: people.settings(), presets: oidcPresets, redirectPath: "/api/people/oidc/callback",
    people: profiles.map((profile) => ({
      id: profile.id, name: profile.name, passkeys: people.passkeys.describe(profile.id).length,
      signedIn: people.keys.list(profile.id).filter((k) => !k.revokedAt && Date.parse(k.expiresAt) > Date.now())
        .map((k) => ({ id: k.id, device: k.device, method: k.method, expiresAt: k.expiresAt, lastUsedAt: k.lastUsedAt })),
      grant: app.runtime.roles.effective(profile.id),
    })),
    groups: people.groups.list(), shares: people.groups.tuples(), waiting: people.suggestions(),
  };
}

async function ownerApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown> {
  const people = app.people, method = request.method ?? "GET", known = { profiles: app.store.profiles.list().map((p) => p.id) };
  if (method === "GET" && path === "/api/people/settings") return ownerView(app);
  if (method === "GET" && path === "/api/people/shares/export") return { tuples: people.groups.exportFga() };
  if (method !== "POST") throw new PeopleHttpError(404, "Not found");
  const input = await body();
  if (path === "/api/people/settings") {
    const before = people.enabled();
    savePeopleSettings(app.store, app.runtime.owner, input);
    // Integration review: switching it off ends every person's sign-in, not only while it stays off.
    if (before && !people.enabled()) people.keys.revokeEveryone();
    return ownerView(app);
  }
  if (path === "/api/people/links/confirm") { people.confirmSuggestion(input); return ownerView(app); }
  if (path === "/api/people/groups") { people.groups.save(input, known.profiles); return ownerView(app); }
  if (path === "/api/people/shares") { people.groups.share(input, known); return ownerView(app); }
  if (path === "/api/people/shares/remove") { people.groups.unshare(input); return ownerView(app); }
  if (path === "/api/people/shares/import") {
    const { tuples } = z.object({ tuples: z.array(z.unknown()).max(1000) }).strict().parse(input);
    return { imported: people.groups.importFga(tuples, known) };
  }
  const group = new RegExp(`^/api/people/groups/(${idPattern})/remove$`).exec(path);
  if (group) return { removed: people.groups.remove(group[1]!) };
  if (path === "/api/people/keys/revoke") {
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{16}$/) }).strict().parse(input);
    return { revoked: people.keys.revoke(id) };
  }
  const one = new RegExp(`^/api/people/(${idPattern})/(reset-code|sign-out|forget)$`).exec(path);
  if (!one || !known.profiles.includes(one[1]!) && one[2] !== "forget") throw new PeopleHttpError(404, "Not found");
  return personAction(app, one[1]!, one[2] as "reset-code" | "sign-out" | "forget");
}

function personAction(app: Branch, profileId: string, action: "reset-code" | "sign-out" | "forget"): unknown {
  const people = app.people;
  if (action === "sign-out") return { signedOut: people.keys.revokeAll(profileId) };
  if (action === "forget") { people.forgetProfile(profileId); return { forgotten: true }; }
  const issued = people.resetCodes.issue(profileId);
  audit(app.store, app.runtime.owner, { action: "token.issued", actor: app.runtime.owner, subject: "a one-time sign-in code",
    reason: "The owner made a code for somebody to set a new PIN or a passkey", outcome: "issued" });
  return { ...issued, steps: "Tell them this code. On the sign-in page they choose \"I have a code from the owner\"." };
}
