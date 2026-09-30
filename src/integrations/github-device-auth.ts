import { z } from "zod";
import type { NetworkPolicy } from "../network-policy.js";
import { pinnedFetch } from "../pinned-fetch.js";

/** Device response validation and cumulative polling delay adapted from OpenClaw (MIT).
 * Source: extensions/github-copilot/login.ts, 2663c6b6202807712586bb2928c22397ccc14b27.
 * Branch supplies its own OAuth identity; no provider client identity is reused. See THIRD_PARTY_NOTICES.md. */
const DeviceSchema = z.object({
  device_code: z.string().min(1).max(512), user_code: z.string().trim().min(1).max(64),
  verification_uri: z.string().url().max(300), expires_in: z.number().int().min(1).max(1800),
  interval: z.number().int().min(1).max(120).default(5),
});
export type DeviceGrant = { deviceCode: string; userCode: string; verificationUri: string; expiresAt: number; intervalMs: number };
export type DeviceReply = { token: string; scopes: string; expiresAt: number | null } | { waitMs: number };
export class GitHubDeviceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type Request = { policy: NetworkPolicy; signal: AbortSignal; assertCurrent: () => void; fetchImpl?: typeof fetch };

async function boundedJson(response: Response, request: Request): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new GitHubDeviceError(502, "GitHub returned an empty response.");
  let length = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const item = await reader.read(); request.assertCurrent();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > 65536) throw new GitHubDeviceError(502, "GitHub returned too much data.");
      chunks.push(item.value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Not an object");
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GitHubDeviceError) throw error;
    throw new GitHubDeviceError(502, "GitHub returned an unreadable response.");
  } finally { await reader.cancel().catch(() => undefined); }
}

async function post(path: string, form: Record<string, string>, request: Request) {
  request.assertCurrent();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
  const send: typeof fetch = (input, init) => { request.assertCurrent(); return (request.fetchImpl ?? pinnedFetch)(input, init); };
  const response = await request.policy.guard(send)(`https://github.com${path}`, {
    method: "POST", redirect: "error", signal,
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  try { request.assertCurrent(); } catch (error) { await response.body?.cancel(); throw error; }
  if (response.status === 429) {
    const retry = response.headers.get("retry-after"), seconds = Number(retry);
    const delay = retry && Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 5000;
    await response.body?.cancel(); request.assertCurrent();
    return { rateLimited: true as const, waitMs: Number.isFinite(delay) ? Math.max(5000, Math.min(1800000, delay)) : 5000 };
  }
  if (!response.ok) {
    await response.body?.cancel(); request.assertCurrent();
    throw new GitHubDeviceError(502, `GitHub sign-in returned HTTP ${response.status}.`);
  }
  const data = await boundedJson(response, request); request.assertCurrent();
  return { rateLimited: false as const, data };
}

export async function requestGitHubDevice(clientId: string, request: Request): Promise<DeviceGrant> {
  const issuedAt = Date.now();
  const response = await post("/login/device/code", { client_id: clientId, scope: "repo read:user" }, request);
  if (response.rateLimited) throw new GitHubDeviceError(429, "GitHub asked you to wait before starting another sign-in.");
  const parsed = DeviceSchema.safeParse(response.data);
  if (!parsed.success) throw new GitHubDeviceError(502, "GitHub did not return a valid device code.");
  const data = parsed.data, uri = new URL(data.verification_uri);
  if (uri.origin !== "https://github.com" || uri.pathname !== "/login/device" || uri.username || uri.password || uri.search || uri.hash)
    throw new GitHubDeviceError(502, "GitHub returned an unexpected consent address.");
  return { deviceCode: data.device_code, userCode: data.user_code, verificationUri: uri.href,
    expiresAt: issuedAt + data.expires_in * 1000, intervalMs: data.interval * 1000 };
}

export async function pollGitHubDevice(clientId: string, grant: DeviceGrant, request: Request): Promise<DeviceReply> {
  const response = await post("/login/oauth/access_token", { client_id: clientId, device_code: grant.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code" }, request);
  if (response.rateLimited) return { waitMs: Math.min(1800000, Math.max(grant.intervalMs + 5000, response.waitMs)) };
  const data = response.data;
  if (typeof data.access_token === "string" && data.access_token.length >= 8 && data.access_token.length <= 4096
      && data.token_type === "bearer" && typeof data.scope === "string" && data.scope.length <= 1000) {
    const scopes = new Set(data.scope.split(/[ ,]+/));
    if (!scopes.has("repo") || (!scopes.has("read:user") && !scopes.has("user"))) throw new GitHubDeviceError(400, "GitHub did not grant the requested repo and read:user access.");
    const expiry = data.expires_in === undefined ? null : z.number().int().min(1).max(2592000).safeParse(data.expires_in);
    if (expiry && !expiry.success) throw new GitHubDeviceError(502, "GitHub returned an invalid token lifetime.");
    return { token: data.access_token, scopes: [...scopes].join(" "), expiresAt: expiry ? Date.now() + expiry.data * 1000 : null };
  }
  if (data.error === "authorization_pending") return { waitMs: grant.intervalMs };
  if (data.error === "slow_down") return { waitMs: Math.min(1800000, grant.intervalMs + 5000) };
  if (data.error === "access_denied") throw new GitHubDeviceError(400, "GitHub sign-in was declined.");
  if (data.error === "expired_token") throw new GitHubDeviceError(410, "The GitHub code expired. Start again.");
  throw new GitHubDeviceError(400, "GitHub could not finish this sign-in. Check that device flow is enabled for your OAuth app.");
}

export async function githubDeviceIdentity(token: string, request: Request): Promise<string> {
  request.assertCurrent();
  const send: typeof fetch = (input, init) => { request.assertCurrent(); return (request.fetchImpl ?? pinnedFetch)(input, init); };
  const response = await request.policy.guard(send)("https://api.github.com/user", { method: "GET", redirect: "error",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` } });
  try { request.assertCurrent(); } catch (error) { await response.body?.cancel(); throw error; }
  if (!response.ok) { await response.body?.cancel(); throw new GitHubDeviceError(502, `GitHub account verification returned HTTP ${response.status}.`); }
  const data = await boundedJson(response, request); request.assertCurrent();
  const identity = z.object({ login: z.string().regex(/^[A-Za-z0-9-]{1,100}$/), id: z.number().int().positive() }).safeParse(data);
  if (!identity.success) throw new GitHubDeviceError(502, "GitHub did not return a valid account identity.");
  return identity.data.login;
}
