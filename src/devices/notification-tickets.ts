import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { DeviceRecord } from "./book.js";
import { companionGrant } from "./companion-grants.js";
interface Ticket { nativeId: string; device: string; key: string; profile: string | null; read: string; act: string; actions: string[]; expiresAt: number }
const tickets = new WeakMap<Store, Map<string, Ticket>>();
function kept(store: Store): Map<string, Ticket> {
  let map = tickets.get(store); if (!map) { map = new Map(); tickets.set(store, map); }
  for (const [id, ticket] of map) if (ticket.expiresAt <= Date.now()) map.delete(id);
  return map;
}
export function notificationArgs(store: Store, device: DeviceRecord, profile: string | null, chat: boolean, capability: string, args: Record<string, unknown>): Record<string, unknown> {
  const read = companionGrant(store, device, profile, "notification-read", chat), act = companionGrant(store, device, profile, "notification-action", chat);
  if (capability === "notification-read") return { ...args, scope: act?.id ?? "" };
  const map = kept(store), ticket = map.get(String(args.id)); map.delete(String(args.id));
  if (!ticket || !read || !act || ticket.device !== device.id || ticket.key !== device.publicKey || ticket.profile !== profile
    || ticket.read !== read.id || ticket.act !== act.id || !ticket.actions.includes(String(args.action)) || ticket.expiresAt <= Date.now()) throw new Error("Refresh the notification with current separate read and action grants.");
  if (args.action === "reply" && (typeof args.text !== "string" || !args.text.trim())) throw new Error("Give the exact reply text.");
  return { ...args, id: ticket.nativeId, scope: act.id };
}
/** Native ids/content are not handed through wholesale. Action tickets require both grants at list time. */
export function notificationRows(store: Store, device: DeviceRecord, profile: string | null, chat: boolean, args: Record<string, unknown>, value: unknown) {
  const read = companionGrant(store, device, profile, "notification-read", chat), act = companionGrant(store, device, profile, "notification-action", chat);
  const list = (value as { notifications?: unknown[] } | null)?.notifications;
  return { notifications: (Array.isArray(list) ? list : []).filter(raw => raw && typeof raw === "object" && !Array.isArray(raw)).slice(0, Number(args.limit ?? 5)).map(raw => {
    const row = raw as Record<string, unknown>, map = kept(store);
    const actions = Array.isArray(row.actions) ? [...new Set(row.actions.slice(0, 3).map(String).filter(a => ["open", "dismiss", "reply"].includes(a)))] : [];
    let id: string | null = null;
    if (read && act && typeof row.id === "string" && /^[a-f0-9-]{36}$/.test(row.id) && map.size < 100) {
      id = randomUUID(); map.set(id, { nativeId: row.id, device: device.id, key: device.publicKey, profile, read: read.id, act: act.id, actions, expiresAt: Math.min(read.expiresAt, act.expiresAt, Date.now() + 60000) });
    }
    return { id, package: String(args.package), postedAt: typeof row.postedAt === "number" ? row.postedAt : null,
      actions: id ? actions : [], ...(args.content === true ? { title: String(row.title ?? "").slice(0, 120), text: String(row.text ?? "").slice(0, 500) } : {}) };
  }) };
}
