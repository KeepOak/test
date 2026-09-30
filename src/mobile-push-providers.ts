import { sign } from "node:crypto";
import { connect } from "node:http2";
import { isIP, type LookupFunction } from "node:net";
import type { NetworkPolicy } from "./network-policy.js";

export interface PushNotice { kind: "finished" | "needs-you"; runId: string }
export interface PushResult { accepted: boolean; invalidToken: boolean }
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const payload = (notice: PushNotice) => ({ kind: notice.kind, runId: notice.runId,
  question: notice.kind === "finished" ? "A task finished. Open Branch to read it." : "A task needs you. Open Branch to review it." });

/** Fixed official endpoints only. The service-account JSON is resolved from the locker at send time. */
export async function sendFcm(policy: NetworkPolicy, project: string, credential: string, token: string,
  notice: PushNotice, signal: AbortSignal, guard: () => void): Promise<PushResult> {
  if (credential.length > 65536) throw new Error("Invalid FCM credential size");
  const account: unknown = JSON.parse(credential);
  if (!account || typeof account !== "object") throw new Error("Invalid FCM credential");
  const { client_email: email, private_key: key } = account as Record<string, unknown>;
  if (typeof email !== "string" || !email.endsWith(".iam.gserviceaccount.com") || typeof key !== "string")
    throw new Error("Invalid FCM service-account credential");
  const now = Math.floor(Date.now() / 1000), header = encode({ alg: "RS256", typ: "JWT" });
  const claims = encode({ iss: email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const input = `${header}.${claims}`, assertion = `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
  const fetch = policy.guard(globalThis.fetch);
  guard();
  const auth = await fetch("https://oauth2.googleapis.com/token", { method: "POST", signal, redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  if (!auth.ok) { await auth.body?.cancel(); throw new Error("FCM authentication refused"); }
  const access = await boundedJson(auth) as { access_token?: unknown };
  if (typeof access.access_token !== "string" || access.access_token.length > 8192) throw new Error("Invalid FCM access token");
  guard();
  // Data-only matches BranchPushService; never send a prompt, answer or approval question.
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
    method: "POST", signal, redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${access.access_token}` },
    body: JSON.stringify({ message: { token, data: payload(notice), android: { priority: "HIGH", ttl: "60s" } } }),
  });
  const body = await boundedJson(response).catch(() => null) as { error?: { details?: { errorCode?: string }[] } } | null;
  return { accepted: response.ok, invalidToken: body?.error?.details?.some((item) => item.errorCode === "UNREGISTERED") === true };
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty push provider response");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) throw new Error("Push provider response exceeds the limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export interface ApnsOptions { teamId: string; keyId: string; topic: string; sandbox: boolean }
/** APNs requires HTTP/2; Node's native transport avoids a new SDK dependency. */
export async function sendApns(policy: NetworkPolicy, options: ApnsOptions, key: string, token: string,
  notice: PushNotice, signal: AbortSignal, guard: () => void): Promise<PushResult> {
  if (key.length > 32768) throw new Error("Invalid APNs credential size");
  const header = encode({ alg: "ES256", kid: options.keyId }), claims = encode({ iss: options.teamId, iat: Math.floor(Date.now() / 1000) });
  const input = `${header}.${claims}`, jwt = `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  const origin = options.sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const target = new URL(`${origin}/3/device/${token}`);
  const addresses = await policy.allowedAddresses(target, "mobile push");
  // Keep the TLS hostname, but answer the transport lookup only with the policy's judged addresses.
  const lookup: LookupFunction | undefined = addresses === null ? undefined : (hostname, options, callback) => {
    try {
      if (hostname.toLowerCase() !== target.hostname) throw new Error("Unexpected APNs connection hostname");
      const answers = addresses.map((judged) => {
        const address = policy.dialAddress(judged);
        return { address, family: isIP(address) };
      });
      if (options.all) callback(null, answers);
      else callback(null, answers[0]!.address, answers[0]!.family);
    } catch (error) { callback(error as NodeJS.ErrnoException, ""); }
  };
  guard();
  return apnsRequest(origin, options.topic, jwt, token, notice, signal, guard, lookup);
}

function apnsRequest(origin: string, topic: string, jwt: string, token: string, notice: PushNotice,
  signal: AbortSignal, guard: () => void, lookup?: LookupFunction): Promise<PushResult> {
  return new Promise((resolve, reject) => {
    const session = connect(origin, { minVersion: "TLSv1.2", servername: new URL(origin).hostname, lookup });
    let settled = false, status = 0, body = "";
    const finish = (error?: Error, result?: PushResult) => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", abort); session.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error("Mobile push cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    session.on("error", () => finish(new Error("APNs connection failed")));
    session.on("connect", () => {
      try { guard(); } catch { return abort(); }
      const request = session.request({ ":method": "POST", ":path": `/3/device/${token}`, authorization: `bearer ${jwt}`,
        "apns-topic": topic, "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": "0" });
      request.setEncoding("utf8");
      request.on("response", (headers) => { status = Number(headers[":status"]); });
      request.on("data", (chunk: string) => { body += chunk; if (body.length > 4096) finish(new Error("Invalid APNs response")); });
      request.on("error", () => finish(new Error("APNs delivery failed")));
      request.on("end", () => {
        const invalidToken = status === 410 || (status === 400 && /"reason"\s*:\s*"(BadDeviceToken|DeviceTokenNotForTopic)"/.test(body));
        finish(undefined, { accepted: status === 200, invalidToken });
      });
      request.end(JSON.stringify({ aps: { alert: { title: notice.kind === "finished" ? "Branch finished" : "Branch needs you",
        body: payload(notice).question }, sound: "default" }, kind: notice.kind, runId: notice.runId }));
    });
  });
}
