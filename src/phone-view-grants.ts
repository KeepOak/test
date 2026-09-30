import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { Store } from "./store.js";
import { GatewayAuth } from "./remote/gateway-auth.js";
import { liveScreenRefusal, type LiveScreenDeps } from "./live-screen.js";
import { liveStage, type LiveStageDeps } from "./live-stage.js";
import type { PrivateDesktops } from "./integrations/private-desktops.js";
import { phonePrivateFrame } from "./integrations/phone-private-frame.js";

interface Grant { id: string; owner: string; deviceId: string; key: string; profileId: string | null; sessionId: string; trunkId: string; kind: "browser" | "computer" | "private-desktop"; revision: number | null; expiresAt: number; readAt: number }
const grants = new Map<string, Grant>();
const watches = new Map<string, ReturnType<typeof setInterval>>();
function revoke(id: string): void { clearInterval(watches.get(id)); watches.delete(id); grants.delete(id); }
const Input = z.object({ deviceId: z.string().min(1).max(100), profileId: z.string().nullable(), sessionId: z.string().uuid(),
  kind: z.enum(["browser", "computer", "private-desktop"]), minutes: z.number().int().min(1).max(15) }).strict();
export interface PhoneViewDeps extends LiveStageDeps {
  store: Store;
  profiles: Store["profiles"];
  desktop: LiveScreenDeps["desktop"];
  privateDesktops: PrivateDesktops;
  locked: () => string | null;
  trunkOf(sessionId: string): string | null;
}
const profile = (deps: PhoneViewDeps) => deps.profiles.localWindowProfileId();
function prune(): void { for (const [id, grant] of grants) if (grant.expiresAt <= Date.now()) revoke(id); }
function ownerLocal(deps: PhoneViewDeps, viaDoor: boolean): void {
  if (viaDoor || !deps.profiles.isOwner()) throw new Error("Create or revoke phone views in the owner’s local Branch window.");
  const refusal = liveScreenRefusal({ ...deps, viaDoor: false });
  if (refusal) throw refusal;
}
/** Metadata only; a grant never includes computer input or browser control authority. */
export function phoneViewGrants(deps: PhoneViewDeps, viaDoor: boolean, method: string, input?: unknown) {
  ownerLocal(deps, viaDoor); prune();
  const gateway = new GatewayAuth(deps.store, deps.owner);
  if (method === "POST") {
    const sent = Input.parse(input), device = gateway.devices().find(d => d.id === sent.deviceId && d.keyFingerprint);
    const trunkId = deps.trunkOf(sent.sessionId);
    if (!device || !trunkId || sent.profileId !== profile(deps) || !deps.store.ownsSession(deps.profiles.scope(), sent.sessionId))
      throw new Error("Choose a paired phone with its own key and a Trunk in the current profile.");
    if ([...grants.values()].filter(g => g.owner === deps.owner).length >= 8) throw new Error("Revoke a phone view before adding another.");
    const id = randomUUID();
    const revision = sent.kind === "private-desktop" ? deps.privateDesktops.viewerStatus(deps.owner, trunkId).revision : null;
    grants.set(id, { ...sent, id, owner: deps.owner, key: device.keyFingerprint!, trunkId, revision, expiresAt: Date.now() + sent.minutes * 60000, readAt: 0 });
    if (sent.kind === "private-desktop") {
      const clock = setInterval(() => {
        try {
          ownerLocal(deps, false);
          const grant = grants.get(id);
          if (!grant || grant.expiresAt <= Date.now() || profile(deps) !== sent.profileId
            || !gateway.devices().some(d => d.id === device.id && d.keyFingerprint === device.keyFingerprint)
            || deps.trunkOf(sent.sessionId) !== trunkId || !deps.store.ownsSession(deps.profiles.scope(), sent.sessionId)
            || deps.privateDesktops.viewerStatus(deps.owner, trunkId).revision !== revision) revoke(id);
        } catch { revoke(id); }
      }, 250);
      clock.unref(); watches.set(id, clock);
    }
  } else if (method === "DELETE") {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
    if (grants.get(id)?.owner === deps.owner) revoke(id);
  } else if (method !== "GET") throw new Error("Unsupported phone view operation.");
  return { phones: gateway.devices().filter(d => d.keyFingerprint).map(d => ({ id: d.id, name: d.name })),
    profileId: profile(deps), grants: [...grants.values()].filter(g => g.owner === deps.owner).map(({ key: _key, readAt: _readAt, owner: _owner, ...grant }) => grant) };
}
/** The bearer key, never a caller-supplied device id, selects eligible grants. */
export async function phoneViewFrame(deps: PhoneViewDeps, request: IncomingMessage, query: URLSearchParams) {
  prune();
  const bearer = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "";
  const gateway = new GatewayAuth(deps.store, deps.owner), device = gateway.keyDevice(bearer);
  const sessionId = query.get("session"), kind = query.get("kind") ?? "browser";
  const grant = [...grants.values()].find(g => g.owner === deps.owner && g.deviceId === device?.id && g.key === device?.keyFingerprint
    && g.profileId === profile(deps) && g.sessionId === sessionId && g.kind === kind);
  const check = () => {
    if (!grant || !grants.has(grant.id) || grant.expiresAt <= Date.now() || profile(deps) !== grant.profileId
      || gateway.keyDevice(bearer)?.keyFingerprint !== grant.key || deps.trunkOf(grant.sessionId) !== grant.trunkId
      || !deps.store.ownsSession(deps.profiles.scope(), grant.sessionId)) throw new Error("No current owner grant for this phone, profile and Trunk view.");
    if (grant.kind === "private-desktop" && deps.privateDesktops.viewerStatus(deps.owner, grant.trunkId).revision !== grant.revision)
      throw new Error("The private desktop changed. Request a new local-owner view grant.");
    const refusal = liveScreenRefusal({ ...deps, viaDoor: false }); if (refusal) throw refusal;
  };
  check();
  if (Date.now() - grant!.readAt < (kind === "private-desktop" ? 2000 : 500)) throw new Error("Wait before requesting another frame.");
  grant!.readAt = Date.now();
  if (kind === "private-desktop") {
    const valid = () => { try { check(); return true; } catch { return false; } };
    const raw = await phonePrivateFrame(deps.privateDesktops, deps.owner, grant!.trunkId, valid);
    check(); return { raw, kind, revision: grant!.revision, expiresAt: grant!.expiresAt, readonly: true };
  }
  let frame: string | null = null;
  if (kind === "browser") {
    const view = await liveStage(deps, grant!.sessionId);
    frame = view.browser?.live && view.browser.preview === "ready" ? view.browser.frame : null;
  } else {
    if (!deps.desktop) throw new Error("This computer’s screen is unavailable.");
    const source = deps.desktop.liveFrames(deps.owner);
    try { const image = await source.next(640, AbortSignal.timeout(4000)); frame = `data:${image.type};base64,${image.bytes.toString("base64")}`; }
    finally { source.close(); }
  }
  check(); return { frame, kind, expiresAt: grant!.expiresAt, readonly: true };
}
