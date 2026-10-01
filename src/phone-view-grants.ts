import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { Store } from "./store.js";
import { GatewayAuth } from "./remote/gateway-auth.js";
import { liveScreenRefusal, type LiveScreenDeps } from "./live-screen.js";
import { liveStage, type LiveStageDeps } from "./live-stage.js";

interface Grant { id: string; owner: string; deviceId: string; key: string; profileId: string | null; sessionId: string; trunkId: string; kind: "browser" | "computer"; expiresAt: number; readAt: number }
const grants = new Map<string, Grant>();
const Input = z.object({ deviceId: z.string().min(1).max(100), profileId: z.string().nullable(), sessionId: z.string().uuid(),
  kind: z.enum(["browser", "computer"]), minutes: z.number().int().min(1).max(15) }).strict();
export interface PhoneViewDeps extends LiveStageDeps {
  store: Store;
  profiles: Store["profiles"];
  desktop: LiveScreenDeps["desktop"];
  locked: () => string | null;
  trunkOf(sessionId: string): string | null;
}
const profile = (deps: PhoneViewDeps) => deps.profiles.localWindowProfileId();
function prune(): void { for (const [id, grant] of grants) if (grant.expiresAt <= Date.now()) grants.delete(id); }
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
    grants.set(id, { ...sent, id, owner: deps.owner, key: device.keyFingerprint!, trunkId, expiresAt: Date.now() + sent.minutes * 60000, readAt: 0 });
  } else if (method === "DELETE") {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
    if (grants.get(id)?.owner === deps.owner) grants.delete(id);
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
    const refusal = liveScreenRefusal({ ...deps, viaDoor: false }); if (refusal) throw refusal;
  };
  check();
  if (Date.now() - grant!.readAt < 500) throw new Error("Wait before requesting another frame.");
  grant!.readAt = Date.now();
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
