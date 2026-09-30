import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import type { DeviceBook, DeviceRecord } from "./book.js";
import type { Capability } from "./capabilities.js";

export const companionActions = ["camera", "location", "notify", "open-url", "notification-read", "notification-action"] as const;
type Action = typeof companionActions[number];
interface Grant { id: string; deviceId: string; publicKey: string; profileId: string | null; action: Action; chat: boolean; expiresAt: number; abort: AbortController; timer: NodeJS.Timeout }
const records = new WeakMap<Store, Map<string, Grant>>();
const input = z.object({ deviceId: z.string().regex(/^[a-f0-9]{16}$/), profileId: z.string().nullable(),
  action: z.enum(companionActions), chat: z.boolean(), minutes: z.number().int().min(1).max(15) }).strict();
function grants(store: Store): Map<string, Grant> {
  let kept = records.get(store);
  if (!kept) { kept = new Map(); records.set(store, kept); }
  return kept;
}
function remove(store: Store, book: DeviceBook, grant: Grant): void {
  if (grants(store).get(grant.id) !== grant) return;
  grants(store).delete(grant.id); clearTimeout(grant.timer); grant.abort.abort();
  try { book.setSwitch(grant.deviceId, grant.action, false); } catch { /* An unpaired device is already refused. */ }
}
/** A local owner action, independent of any screen-view grant. One lease per phone/action. */
export function companionGrantApi(store: Store, book: DeviceBook, method: string, body?: unknown) {
  const kept = grants(store);
  if (method === "POST") {
    const sent = input.parse(body), device = book.device(sent.deviceId);
    if (!device || !["ios", "android"].includes(device.platform) || !device.offers.includes(sent.action)
      || sent.profileId !== (store.profiles.active()?.id ?? null) || !store.profiles.isOwner())
      throw new Error("Choose an offered phone action in the owner’s current profile.");
    for (const grant of kept.values()) if (grant.deviceId === device.id && grant.action === sent.action) remove(store, book, grant);
    if (kept.size >= 20) throw new Error("Revoke a companion grant before adding another.");
    const id = randomUUID(), expiresAt = Date.now() + sent.minutes * 60000;
    const grant: Grant = { ...sent, id, publicKey: device.publicKey, expiresAt, abort: new AbortController(),
      timer: setTimeout(() => remove(store, book, grant), sent.minutes * 60000) };
    grant.timer.unref(); book.setSwitch(device.id, sent.action, true); kept.set(id, grant);
  } else if (method === "DELETE") {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(body);
    const grant = kept.get(id); if (grant) remove(store, book, grant);
  } else if (method !== "GET") throw new Error("Unsupported companion grant operation.");
  return { profileId: store.profiles.active()?.id ?? null, actions: companionActions,
    grants: [...kept.values()].filter(g => g.expiresAt > Date.now()).map(({ publicKey: _key, abort: _abort, timer: _timer, ...grant }) => grant) };
}
export function companionGrant(store: Store, device: DeviceRecord, profileId: string | null, capability: Capability, chat: boolean): Grant | null {
  return [...grants(store).values()].find(g => device.offers.includes(capability) && device.enabled.includes(capability) && g.deviceId === device.id && g.publicKey === device.publicKey && g.profileId === profileId
    && g.action === capability && (!chat || g.chat) && g.expiresAt > Date.now() && !g.abort.signal.aborted) ?? null;
}
/** Only announces permissions; the actual tool still checks its exact phone and profile. */
export function companionChatPermissions(store: Store): string[] {
  const actions = [...grants(store).values()].filter(g => g.chat && g.profileId === null && g.expiresAt > Date.now()).map(g => g.action);
  return actions.length ? ["phone.read", ...new Set(actions.map(a => a === "notification-read" ? "phone.notifications.read" : a === "notification-action" ? "phone.notifications.act" : a === "camera" || a === "location" ? "phone.capture" : "phone.act"))] : [];
}
export const isCompanionAction = (device: DeviceRecord, capability: Capability): boolean =>
  ["ios", "android"].includes(device.platform) && (companionActions as readonly string[]).includes(capability);
/** A saved switch cannot resurrect a memory-only grant after Branch restarts. */
export function resetCompanionSwitches(store: Store, book: DeviceBook): void {
  for (const grant of grants(store).values()) remove(store, book, grant);
  for (const device of book.devices().filter(d => ["ios", "android"].includes(d.platform)))
    for (const action of companionActions) if (device.enabled.includes(action)) book.setSwitch(device.id, action, false);
}
