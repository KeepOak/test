import { assertHealthCurrent, currentHealthCheck, healthSignal } from "./health-check.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { NetworkPolicy } from "./network-policy.js";
import type { Secrets } from "./vault.js";
import { LockerConflict } from "./locker.js";

/**
 * Signing in to an outside service the ordinary way: Branch Agent opens the service's own sign-in
 * page in the default browser, the service sends the answer back to a tiny page running on this
 * computer only, and the resulting key is put straight into the locker. It never sees the password.
 * This is the standard authorization-code flow with PKCE, so it works for Google, Microsoft,
 * GitHub, Slack and anything else that follows OAuth 2.0.
 */
export const OAuthProviderSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Use a short name such as github"),
  label: z.string().trim().min(1).max(60),
  authorizeUrl: z.string().min(1).max(500),
  tokenUrl: z.string().min(1).max(500),
  clientId: z.string().min(1).max(300),
  /** Only for services that still insist on one; public clients use PKCE alone. */
  clientSecret: z.string().max(500).optional(),
  scopes: z.array(z.string().min(1).max(120)).max(40).default([]),
  /** Extra values the service asks for on the sign-in address, such as access_type. */
  extra: z.record(z.string().max(40), z.string().max(200)).default({}),
}).strict();
export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;
export interface OAuthTokens {
  accessToken: string; refreshToken: string | null; tokenType: string;
  expiresAt: string | null; scope: string | null; obtainedAt: string;
  /**
   * Which settings (issuerOf) signed in or renewed this, kept beside the tokens (Locker.origin), never inside them;
   * absent on sign-ins saved before it was kept, or saved since by a Branch that does not keep it.
   */
  issuer?: string | undefined;
}
export interface OAuthStart { id: string; url: string; redirectUri: string; expiresInMs: number }

const base64url = (input: Buffer): string => input.toString("base64url");
const sameText = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
/** The locker name a connection's tokens are kept under, in the default project. */
export const oauthSecretName = (id: string): string => `OAUTH_${id.toUpperCase().replace(/-/g, "_")}`;

/** The saved sign-in was replaced while an older one was being renewed: that renewal's answer is dropped. */
class ReplacedSignIn extends Error {}
/* Each account check (src/health-check.ts) is its own authority: a renewal it starts runs and saves under it. */
const checkIds = new WeakMap<object, number>();
let checksSeen = 0;
const checkId = (check: object | undefined): number | null => {
  if (!check) return null;
  if (!checkIds.has(check)) checkIds.set(check, ++checksSeen);
  return checkIds.get(check) ?? null;
};
/**
 * Which renewal a call may share: the same connection, client, tenant and sign-in addresses (a tenant lives in them, or
 * in `extra`), the same saved credential, and the same account check or none. Hashed, so the map never holds a key in
 * the clear.
 */
function renewalKey(provider: OAuthProvider, tokens: OAuthTokens): string {
  return createHash("sha256").update(JSON.stringify([provider.id, provider.clientId, provider.clientSecret ?? "",
    provider.authorizeUrl, provider.tokenUrl, provider.extra, tokens.refreshToken, tokens.accessToken, tokens.obtainedAt,
    checkId(currentHealthCheck())])).digest("hex");
}
const sameCredential = (a: OAuthTokens, b: OAuthTokens): boolean =>
  a.refreshToken === b.refreshToken && a.accessToken === b.accessToken && a.obtainedAt === b.obtainedAt;
/** The settings a sign-in belongs to: its connection, client and sign-in addresses (where a tenant lives). */
const issuerOf = (provider: OAuthProvider): string => createHash("sha256")
  .update(JSON.stringify([provider.id, provider.clientId, provider.authorizeUrl, provider.tokenUrl])).digest("hex").slice(0, 32);

interface Flow {
  provider: OAuthProvider; verifier: string; state: string; redirectUri: string;
  server: Server; settle: (tokens: OAuthTokens) => void; fail: (error: Error) => void;
  done: Promise<OAuthTokens>; timer: NodeJS.Timeout;
}

export class OAuthConnections {
  private readonly flows = new Map<string, Flow>();
  /** A renewal under way for each sign-in (renewalKey), which calls arriving meanwhile wait for instead of starting their own. */
  private readonly renewals = new Map<string, Promise<OAuthTokens>>();
  constructor(private readonly owner: string, private readonly secrets: Secrets, private readonly policy: NetworkPolicy,
    private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly windowMs = 300_000) {}

  /** Starts a sign-in: the address to open, and a promise that settles when the service answers. */
  async start(input: unknown): Promise<OAuthStart> {
    const provider = OAuthProviderSchema.parse(input);
    // The sign-in page is opened in the person's own browser, so it has to be an ordinary web
    // address and nothing else; the address the key comes from is checked again by the policy.
    webAddress(provider.authorizeUrl, "sign-in page");
    webAddress(provider.tokenUrl, "sign-in address");
    await this.cancel(provider.id);
    const verifier = base64url(randomBytes(32)), state = base64url(randomBytes(24));
    const server = createServer();
    const port = await listenOnLoopback(server);
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    let settle!: (tokens: OAuthTokens) => void, fail!: (error: Error) => void;
    const done = new Promise<OAuthTokens>((resolve, reject) => { settle = resolve; fail = reject; });
    const timer = setTimeout(() => { void this.cancel(provider.id, new Error("The sign-in window timed out")); }, this.windowMs);
    timer.unref();
    const flow: Flow = { provider, verifier, state, redirectUri, server, settle, fail, done, timer };
    done.catch(() => undefined);
    this.flows.set(provider.id, flow);
    server.on("request", (request, response) => { void this.callback(flow, request.url ?? "/", response); });
    return { id: provider.id, url: this.authorizeUrl(flow), redirectUri, expiresInMs: this.windowMs };
  }
  /** Settles when the service has answered and the tokens are in the locker. */
  waitFor(id: string): Promise<OAuthTokens> {
    const flow = this.flows.get(id);
    if (!flow) return Promise.reject(new Error(`No sign-in is waiting for ${id}`));
    return flow.done;
  }
  /** Stops a sign-in that is still waiting and closes its little page. */
  async cancel(id: string, reason?: Error): Promise<void> {
    const flow = this.flows.get(id);
    if (!flow) return;
    this.flows.delete(id);
    clearTimeout(flow.timer);
    flow.fail(reason ?? new Error("The sign-in was cancelled"));
    await new Promise<void>((resolve) => flow.server.close(() => resolve()));
  }
  async closeAll(): Promise<void> { await Promise.all([...this.flows.keys()].map((id) => this.cancel(id))); }

  private authorizeUrl(flow: Flow): string {
    const url = new URL(flow.provider.authorizeUrl);
    const challenge = base64url(createHash("sha256").update(flow.verifier).digest());
    for (const [key, value] of Object.entries(flow.provider.extra)) url.searchParams.set(key, value);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", flow.provider.clientId);
    url.searchParams.set("redirect_uri", flow.redirectUri);
    url.searchParams.set("state", flow.state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (flow.provider.scopes.length) url.searchParams.set("scope", flow.provider.scopes.join(" "));
    return url.href;
  }
  private async callback(flow: Flow, target: string, response: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(target, flow.redirectUri);
    if (!url.pathname.startsWith("/oauth/callback")) { response.writeHead(404).end(); return; }
    const code = url.searchParams.get("code") ?? "", state = url.searchParams.get("state") ?? "";
    const failure = url.searchParams.get("error");
    try {
      if (failure) throw new Error(`The service refused the sign-in: ${failure.slice(0, 120)}`);
      if (!sameText(state, flow.state)) throw new Error("The answer did not match the sign-in that was started");
      if (!code) throw new Error("The service did not send a sign-in code");
      const tokens = await this.exchange(flow, code);
      reply(response, 200, "Signed in. You can close this window and go back to Branch Agent.");
      this.finish(flow, tokens);
    } catch (error) {
      reply(response, 400, "That sign-in could not be finished. Go back to Branch Agent and try again.");
      this.flows.delete(flow.provider.id);
      clearTimeout(flow.timer);
      flow.fail(error instanceof Error ? error : new Error("The sign-in failed"));
      flow.server.close();
    }
  }
  private finish(flow: Flow, tokens: OAuthTokens): void {
    this.flows.delete(flow.provider.id);
    clearTimeout(flow.timer);
    flow.settle(tokens);
    flow.server.close();
  }
  private async exchange(flow: Flow, code: string): Promise<OAuthTokens> {
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: flow.redirectUri,
      client_id: flow.provider.clientId, code_verifier: flow.verifier });
    return this.token(flow.provider, body);
  }
  /**
   * Swaps a refresh key for a fresh access key when the old one has run out. With `replacing`, the answer is saved only
   * over that very sign-in, checked at the moment of writing (Locker.set); if it was replaced meanwhile, nothing is
   * written and ReplacedSignIn.
   */
  async refresh(provider: OAuthProvider, tokens: OAuthTokens, replacing?: OAuthTokens): Promise<OAuthTokens> {
    if (!tokens.refreshToken) throw new Error(`${provider.label} did not give a way to renew the sign-in; sign in again`);
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: provider.clientId });
    const fresh = await this.token(provider, body, replacing);
    return { ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken };
  }
  private async token(provider: OAuthProvider, body: URLSearchParams, replacing?: OAuthTokens): Promise<OAuthTokens> {
    const target = new URL(provider.tokenUrl);
    await this.policy.assertAllowed(target, "sign-in address");
    assertHealthCurrent();
    if (provider.clientSecret) body.set("client_secret", provider.clientSecret);
    const response = await this.fetchImpl(target, { method: "POST", redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(), signal: healthSignal(AbortSignal.timeout(20000))! });
    assertHealthCurrent();
    if (!response.ok) throw new Error(`The sign-in service answered ${response.status}`);
    const tokens = readTokens(await response.json());
    assertHealthCurrent();
    await this.save(provider, tokens, replacing);
    return tokens;
  }
  /**
   * Tokens go straight into the locker with the settings that got them, and the scrubber learns them so they cannot
   * leak. With `replacing`, only over that sign-in, compared in the locker's own write step.
   */
  private async save(provider: OAuthProvider, tokens: OAuthTokens, replacing?: OAuthTokens): Promise<void> {
    this.secrets.scrubber.remember(oauthSecretName(provider.id), tokens.accessToken);
    if (tokens.refreshToken) this.secrets.scrubber.remember(`${oauthSecretName(provider.id)}_REFRESH`, tokens.refreshToken);
    const expect = replacing
      ? (current: string | null) => { const held = storedTokens(current); return !!held && sameCredential(held, replacing); }
      : undefined;
    /* The stored form stays exactly what an older Branch reads (StoredTokensSchema), so a rollback keeps the sign-in. */
    const { issuer: _issuer, ...plain } = tokens;
    const write = () => this.secrets.put(this.owner, "default", oauthSecretName(provider.id),
      JSON.stringify(plain), {}, { expect, origin: issuerOf(provider) });
    const check = currentHealthCheck();
    try {
      if (check) await check.writeOwnCredential(this.owner, "default", oauthSecretName(provider.id), write);
      else await write();
    } catch (error) {
      if (error instanceof LockerConflict) throw new ReplacedSignIn(`The sign-in to ${provider.label} was replaced while it was renewed`);
      throw error;
    }
  }
  /** The saved tokens for a connection, or null when it has never been signed in. */
  async saved(id: string): Promise<OAuthTokens | null> {
    const name = oauthSecretName(id);
    const values = await this.secrets.resolve(this.owner, "default", [name], { purpose: `sign-in ${id}` }).catch(() => null);
    assertHealthCurrent();
    const saved = storedTokens(values?.[name] ?? null);
    if (!saved) return null;
    this.secrets.scrubber.remember(name, saved.accessToken);
    const issuer = this.secrets.origin(this.owner, "default", name);
    return issuer === null ? saved : { ...saved, issuer };
  }
  /**
   * A usable access key, renewed first when the saved one has expired. Calls that find it expired at the same moment
   * share one renewal: a service that rotates refresh keys accepts each one only once, so a second renewal with the
   * same key would lose the sign-in. Adapted from LibreChat's in-flight refresh map (packages/api/src/mcp/oauth/tokens.ts,
   * MIT; see THIRD_PARTY_NOTICES.md). Only a call with the same sign-in (renewalKey) shares one. A renewal whose saved
   * sign-in was replaced meanwhile saves nothing and hands nothing out; its callers read the new sign-in once more. A
   * sign-in got with other settings (another client, tenant or address) is never handed to these: sign in again.
   */
  async accessToken(provider: OAuthProvider): Promise<string> {
    for (let tries = 0; ; tries++) {
      const tokens = await this.saved(provider.id);
      if (!tokens) throw new Error(`Branch Agent is not signed in to ${provider.label} yet`);
      if (tokens.issuer !== undefined && tokens.issuer !== issuerOf(provider))
        throw new Error(`The sign-in to ${provider.label} was made with other settings; sign in again`);
      const expired = tokens.expiresAt !== null && Date.parse(tokens.expiresAt) - 30_000 <= Date.now();
      if (!expired) return tokens.accessToken;
      const key = renewalKey(provider, tokens);
      let renewal = this.renewals.get(key);
      if (!renewal) {
        renewal = this.refresh(provider, tokens, tokens).finally(() => this.renewals.delete(key));
        this.renewals.set(key, renewal);
      }
      try {
        return (await renewal).accessToken;
      } catch (error) {
        if (!(error instanceof ReplacedSignIn) || tries > 0) throw error;
      }
    }
  }
}

/** An ordinary web address, and nothing else: no file, no script, no other scheme. */
function webAddress(value: string, what: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`The ${what} is not a web address`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`The ${what} must start with https://`);
}
function reply(response: import("node:http").ServerResponse, status: number, message: string): void {
  const page = `<!doctype html><meta charset="utf-8"><title>Branch Agent</title><body style="font:16px system-ui;padding:3rem">${message}</body>`;
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page);
}
function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}
/** The shape the locker keeps, which is not the shape the service answers with. */
const StoredTokensSchema = z.object({
  accessToken: z.string().min(1).max(4000), refreshToken: z.string().max(4000).nullable().default(null),
  tokenType: z.string().max(40).default("Bearer"), expiresAt: z.string().nullable().default(null),
  scope: z.string().max(1000).nullable().default(null), obtainedAt: z.string(),
}).strict();
/** A saved sign-in's tokens, or null when there is none or it cannot be read. */
function storedTokens(text: string | null): OAuthTokens | null {
  if (!text) return null;
  try {
    const saved = StoredTokensSchema.safeParse(JSON.parse(text) as unknown);
    return saved.success ? saved.data : null;
  } catch { return null; }
}
function readTokens(body: unknown): OAuthTokens {
  const shape = z.object({
    access_token: z.string().min(1).max(4000), refresh_token: z.string().max(4000).optional(),
    token_type: z.string().max(40).default("Bearer"), expires_in: z.number().int().min(0).max(31_536_000).optional(),
    scope: z.string().max(1000).optional(),
  }).loose().parse(body);
  return { accessToken: shape.access_token, refreshToken: shape.refresh_token ?? null, tokenType: shape.token_type,
    expiresAt: shape.expires_in === undefined ? null : new Date(Date.now() + shape.expires_in * 1000).toISOString(),
    scope: shape.scope ?? null, obtainedAt: new Date().toISOString() };
}
