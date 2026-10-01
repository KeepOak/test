/**
 * Signing in to somebody else's MCP server.
 *
 * Some MCP servers do not hand out keys by hand: they answer 401 and publish where their sign-in lives (RFC 9728, then
 * RFC 8414), let a program register itself on the spot (RFC 7591), and run the ordinary sign-in in the person's browser
 * with a proof key and the server named as the resource (RFC 8707). The MCP SDK Branch already ships does all of that
 * (`auth()` and the `authProvider` of its HTTP transport); what Branch adds is where things are kept and who may start
 * a sign-in:
 *
 * - The client identity (with any client secret) and the keys go into the default project's locker, never the settings
 *   table, a log, an event or a message; the scrubber learns each value.
 * - A sign-in starts only from the owner's click. A connection made in the background that finds its keys no longer
 *   work never opens a browser: it records that a sign-in is needed and fails with a plain reason.
 * - The browser comes back to a page on this computer only (127.0.0.1, a free port). Branch registers that exact
 *   address, port included, and registers again when a later sign-in's port differs.
 * - Every address is reached through the network policy.
 *
 * Branch is only ever the one signing in here. Another AI tool connecting *to* Branch uses the session key the app
 * already shows in Settings.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { NetworkPolicy } from "../network-policy.js";
import type { Store } from "../store.js";
import { mcpAuth } from "./mcp-sdk.js";

/**
 * Not secret: the server address the sign-in belongs to, the callback address the identity was registered with, and
 * whether a sign-in is needed again.
 */
const settingsKey = (id: string): string => `mcp-oauth:${id}`;
/** Locker names for one server's sign-in: its client identity and its keys. */
const lockerName = (id: string, part: "CLIENT" | "TOKENS"): string => `MCP_SIGNIN_${id.toUpperCase().replace(/-/g, "_")}_${part}`;

interface Kept { serverUrl?: string; redirectUrl?: string; needsSignIn?: boolean }
const kept = (store: Store, owner: string, id: string): Kept =>
  (store.get("settings", owner, settingsKey(id))?.data as Kept | undefined) ?? {};
const keep = (store: Store, owner: string, id: string, patch: Kept): void =>
  void store.save("settings", owner, settingsKey(id), { ...kept(store, owner, id), ...patch });

/**
 * Whether this server, at this address, has been signed in to, so its connections should carry the saved keys. Keys
 * are bound to the address they were issued for: a server later saved under the same name elsewhere never gets them.
 */
export function hasSignIn(store: Store, owner: string, id: string, serverUrl: string): boolean {
  if (kept(store, owner, id).serverUrl !== serverUrl) return false;
  return store.secrets.list(owner, "default").some((entry) => entry.name === lockerName(id, "TOKENS"));
}
/** Forgets a server's sign-in: its identity and keys in the locker, and what was noted about it. */
export function forgetSignIn(store: Store, owner: string, id: string): void {
  for (const part of ["CLIENT", "TOKENS"] as const) store.secrets.remove(owner, "default", lockerName(id, part));
  store.delete("settings", owner, settingsKey(id));
}
/** Whether a background connection found that the sign-in no longer works. */
export const needsSignIn = (store: Store, owner: string, id: string): boolean => kept(store, owner, id).needsSignIn === true;

interface Interactive { serverUrl: string; redirectUrl: string; state: string; onRedirect: (url: URL) => void; scope?: string }

/**
 * The SDK's `OAuthClientProvider`, kept in the locker. With `interactive` it belongs to one sign-in the owner started;
 * without, it is what a connection carries, able to use and renew the saved keys but never to open a browser.
 */
export class LockerAuthProvider implements OAuthClientProvider {
  private verifier = "";
  private discovery: OAuthDiscoveryState | undefined;
  /** The keys, read from the locker once and kept here, since the SDK asks for them on every request. */
  private cached: OAuthTokens | undefined;
  constructor(private readonly store: Store, private readonly owner: string, private readonly id: string,
    private readonly interactive?: Interactive) {}

  get redirectUrl(): string | undefined { return this.interactive?.redirectUrl ?? kept(this.store, this.owner, this.id).redirectUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Branch Agent", redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
      ...(this.interactive?.scope ? { scope: this.interactive.scope } : {}) };
  }
  state(): string { return this.interactive?.state ?? base64url(randomBytes(24)); }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const saved = await this.read<OAuthClientInformationMixed & { redirect_uris?: string[] }>("CLIENT");
    // An identity registered for another port would be refused at the callback, so a new sign-in registers again.
    if (saved && this.interactive && saved.redirect_uris && !saved.redirect_uris.includes(this.interactive.redirectUrl)) return undefined;
    return saved;
  }
  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    if (info.client_secret) this.store.secrets.scrubber.remember(`${lockerName(this.id, "CLIENT")}_SECRET`, info.client_secret);
    await this.write("CLIENT", info);
  }
  async tokens(): Promise<OAuthTokens | undefined> { return this.cached ??= await this.read<OAuthTokens>("TOKENS"); }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.cached = tokens;
    this.store.secrets.scrubber.remember(lockerName(this.id, "TOKENS"), tokens.access_token);
    if (tokens.refresh_token) this.store.secrets.scrubber.remember(`${lockerName(this.id, "TOKENS")}_REFRESH`, tokens.refresh_token);
    await this.write("TOKENS", tokens);
    keep(this.store, this.owner, this.id, { needsSignIn: false,
      ...(this.interactive ? { redirectUrl: this.interactive.redirectUrl, serverUrl: this.interactive.serverUrl } : {}) });
  }
  redirectToAuthorization(url: URL): void {
    if (this.interactive) { this.interactive.onRedirect(url); return; }
    // A connection in the background never opens a browser; the owner is asked to sign in again from Customize.
    keep(this.store, this.owner, this.id, { needsSignIn: true });
  }
  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string {
    if (!this.verifier) throw new Error("No sign-in was started here");
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState): void { this.discovery = state; }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") this.store.secrets.remove(this.owner, "default", lockerName(this.id, "CLIENT"));
    if (scope === "all" || scope === "tokens") { this.cached = undefined; this.store.secrets.remove(this.owner, "default", lockerName(this.id, "TOKENS")); }
    if (scope === "all" || scope === "verifier") this.verifier = "";
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
  }

  private async read<T>(part: "CLIENT" | "TOKENS"): Promise<T | undefined> {
    const name = lockerName(this.id, part);
    if (!this.store.secrets.list(this.owner, "default").some((entry) => entry.name === name)) return undefined;
    const values = await this.store.secrets.resolve(this.owner, "default", [name], { purpose: `signing in to the ${this.id} server` })
      .catch(() => ({} as Record<string, string>));
    try { return values[name] ? JSON.parse(values[name]) as T : undefined; } catch { return undefined; }
  }
  private async write(part: "CLIENT" | "TOKENS", value: unknown): Promise<void> {
    await this.store.secrets.put(this.owner, "default", lockerName(this.id, part), JSON.stringify(value));
  }
}

/** What a connection to this server carries: the saved sign-in for this address, or nothing. */
export function signInProvider(store: Store, owner: string, id: string, serverUrl: string): OAuthClientProvider | undefined {
  return hasSignIn(store, owner, id, serverUrl) ? new LockerAuthProvider(store, owner, id) : undefined;
}

export const McpSignInSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/),
  url: z.string().url(),
  scopes: z.array(z.string().min(1).max(120)).max(40).default([]),
}).strict();

export interface McpSignInStart {
  /** The address to open in the owner's own browser; null when the saved sign-in could simply be renewed. */
  url: string | null; redirectUri: string; expiresInMs: number; signedIn: boolean;
}
interface Flow { server: Server; timer: NodeJS.Timeout; done: Promise<void> }
const flows = new WeakMap<Store, Map<string, Flow>>();
const flowsOf = (store: Store): Map<string, Flow> => {
  let found = flows.get(store);
  if (!found) flows.set(store, found = new Map());
  return found;
};

/** Settles when the sign-in the owner started for this server has finished (or failed, or timed out). */
export function signInFinished(store: Store, id: string): Promise<void> {
  return flowsOf(store).get(id)?.done ?? Promise.reject(new Error(`No sign-in is waiting for the ${id} server`));
}
function stop(store: Store, id: string): void {
  const flow = flowsOf(store).get(id);
  if (!flow) return;
  flowsOf(store).delete(id);
  clearTimeout(flow.timer);
  flow.server.close();
}

/**
 * Starts the sign-in for one MCP server, from the owner's click. Returns the address to open in the owner's browser;
 * the page on this computer that the browser comes back to finishes it, and the keys land in the locker.
 */
export async function signIn(
  input: unknown, deps: {
    store: Store; owner: string; policy: NetworkPolicy; fetchImpl?: typeof fetch; windowMs?: number;
    /** Called once the keys are saved, so the server can be connected with them. */
    onSignedIn?: (id: string) => void;
  },
): Promise<McpSignInStart> {
  const parsed = McpSignInSchema.parse(input);
  const target = new URL(parsed.url);
  if (target.protocol !== "https:" && target.hostname !== "127.0.0.1" && target.hostname !== "localhost")
    throw new Error("A server that needs a sign-in has to be reached over https.");
  await deps.policy.assertAllowed(target, "MCP server");
  stop(deps.store, parsed.id);
  const server = createServer();
  const port = await listenOnLoopback(server);
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`, state = base64url(randomBytes(24));
  let authorizeAt: URL | undefined;
  const provider = new LockerAuthProvider(deps.store, deps.owner, parsed.id, { serverUrl: parsed.url, redirectUrl: redirectUri, state,
    onRedirect: (url) => { authorizeAt = url; }, ...(parsed.scopes.length ? { scope: parsed.scopes.join(" ") } : {}) });
  const fetchFn = deps.policy.guard(deps.fetchImpl ?? globalThis.fetch);
  const { auth } = await mcpAuth();
  const windowMs = deps.windowMs ?? 300_000;
  let result: string;
  try {
    result = await auth(provider, { serverUrl: target, fetchFn, ...(parsed.scopes.length ? { scope: parsed.scopes.join(" ") } : {}) });
  } catch (error) {
    server.close();
    throw new Error(`That server's sign-in could not be started: ${error instanceof Error ? error.message.slice(0, 200) : "no answer"}`);
  }
  if (result === "AUTHORIZED" || !authorizeAt) {
    server.close();
    deps.onSignedIn?.(parsed.id);
    return { url: null, redirectUri, expiresInMs: 0, signedIn: true };
  }
  if (authorizeAt.protocol !== "https:" && authorizeAt.protocol !== "http:") { server.close(); throw new Error("The sign-in page must start with https://"); }
  const finish = async (url: URL): Promise<void> => {
    const refused = url.searchParams.get("error");
    if (refused) throw new Error(`The server refused the sign-in: ${refused.slice(0, 120)}`);
    if (!sameText(url.searchParams.get("state") ?? "", state)) throw new Error("The answer did not match the sign-in that was started");
    const code = url.searchParams.get("code");
    if (!code) throw new Error("The server did not send a sign-in code");
    await auth(provider, { serverUrl: target, authorizationCode: code, fetchFn });
  };
  awaitCallback(deps.store, parsed.id, server, redirectUri, windowMs, finish, () => deps.onSignedIn?.(parsed.id));
  return { url: authorizeAt.href, redirectUri, expiresInMs: windowMs, signedIn: false };
}

/** Waits for the browser to come back to the page on this computer, finishes the sign-in once, then closes the page. */
function awaitCallback(
  store: Store, id: string, server: Server, redirectUri: string, windowMs: number,
  finish: (url: URL) => Promise<void>, signedIn: () => void,
): void {
  let settle!: () => void, fail!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
  done.catch(() => undefined);
  const timer = setTimeout(() => { stop(store, id); fail(new Error("The sign-in window timed out")); }, windowMs);
  timer.unref();
  flowsOf(store).set(id, { server, timer, done });
  server.on("request", (request, response) => void (async () => {
    const url = new URL(request.url ?? "/", redirectUri);
    if (url.pathname !== "/oauth/callback") { response.writeHead(404).end(); return; }
    try {
      await finish(url);
      reply(response, 200, "Signed in. You can close this window and go back to Branch Agent.");
      stop(store, id);
      settle();
      signedIn();
    } catch (error) {
      reply(response, 400, "That sign-in could not be finished. Go back to Branch Agent and try again.");
      stop(store, id);
      fail(error instanceof Error ? error : new Error("The sign-in failed"));
    }
  })());
}

const base64url = (input: Buffer): string => input.toString("base64url");
const sameText = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
function reply(response: ServerResponse, status: number, message: string): void {
  const page = `<!doctype html><meta charset="utf-8"><title>Branch Agent</title><body style="font:16px system-ui;padding:3rem">${message}</body>`;
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page);
}
function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}
