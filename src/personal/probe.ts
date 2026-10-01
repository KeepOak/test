import { z } from "zod";
import type { SignInService } from "./signin.js";
import { assertHealthCurrent, currentHealthCheck, healthSignal } from "../health-check.js";

/** A service read proves only the capability named here. Response content is never retained. */
interface Probe { capability: string; url: string; shape: z.ZodType }
const probes: Record<SignInService, readonly Probe[]> = {
  google: [
    { capability: "Gmail", url: "https://gmail.googleapis.com/gmail/v1/users/me/labels?fields=labels(id)", shape: z.object({ labels: z.array(z.unknown()) }) },
    { capability: "Google Calendar", url: "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1&fields=kind,items(id)",
      shape: z.object({ kind: z.literal("calendar#events"), items: z.array(z.unknown()).optional() }) },
    { capability: "Google Drive", url: "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=kind,files(id)",
      shape: z.object({ kind: z.literal("drive#fileList"), files: z.array(z.unknown()).optional() }) },
  ],
  microsoft: [
    { capability: "Microsoft account", url: "https://graph.microsoft.com/v1.0/me?$select=id", shape: z.object({ id: z.string().min(1) }) },
    { capability: "Outlook mail", url: "https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=id", shape: z.object({ value: z.array(z.unknown()) }) },
    { capability: "Outlook Calendar", url: "https://graph.microsoft.com/v1.0/me/events?$top=1&$select=id", shape: z.object({ value: z.array(z.unknown()) }) },
  ],
  spotify: [{ capability: "Spotify playback", url: "https://api.spotify.com/v1/me/player/devices", shape: z.object({ devices: z.array(z.unknown()) }) }],
};

export interface ConnectionCheck { capability: string; ok: boolean; reason: string | null }
export interface ConnectionHealth { checkedAt: string; ok: boolean; checks: ConnectionCheck[] }

/** Uses the existing policy-checked fetch and bearer token. These fixed URLs only read metadata. */
export async function probeSignIn(service: SignInService, token: string, fetchImpl: typeof fetch): Promise<ConnectionHealth> {
  return probeMetadata(probes[service], token, fetchImpl);
}

/** Also used by existing token connectors; callers supply a fixed read at their saved service address. */
export async function probeMetadata(probes: readonly Probe[], token: string, fetchImpl: typeof fetch): Promise<ConnectionHealth> {
  const checks: ConnectionCheck[] = [];
  for (const probe of probes) {
    let ok = false, reason: string | null = null;
    try {
      assertHealthCurrent();
      const response = await fetchImpl(probe.url, { method: "GET", redirect: "error", signal: healthSignal(AbortSignal.timeout(10000))!,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      assertHealthCurrent();
      if (!response.ok) {
        await response.body?.cancel();
        reason = response.status === 401 ? "Sign in again to check this connection."
          : response.status === 403 ? "This account has not allowed this read."
          : `The service could not complete this read (HTTP ${response.status}).`;
      } else {
        probe.shape.parse(await readProbeBody(response));
        assertHealthCurrent();
        ok = true;
      }
    } catch { assertHealthCurrent(); reason = "This read could not be verified. Try again when the service is available."; }
    checks.push({ capability: probe.capability, ok, reason });
  }
  return { checkedAt: new Date().toISOString(), ok: checks.every((check) => check.ok), checks };
}

/** Fixed metadata queries are small; reject an unexpectedly large or malformed service reply. */
async function readProbeBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No service response");
  const check = currentHealthCheck();
  const cancel = () => { void reader.cancel(check!.signal.reason).catch(() => undefined); };
  check?.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    assertHealthCurrent();
    for (;;) {
      const { done, value } = await reader.read();
      assertHealthCurrent();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error("Service response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    check?.signal.removeEventListener("abort", cancel);
    if (check?.signal.aborted) void reader.cancel().catch(() => undefined);
    else await reader.cancel().catch(() => undefined);
  }
}
