import { z } from "zod";
import type { Store } from "../store.js";
import { audit } from "../audit.js";
import { freshThread, type ChatThread } from "./threads.js";

const Channel = z.string().trim().min(1).max(64).regex(/^[a-z0-9._-]+$/i);
const Scope = z.string().trim().min(1).max(120).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
export const ChannelRouteSchema = z.object({ channel: Channel, scope: Scope,
  trunkId: z.union([z.string().uuid(), z.literal("default")]).nullable() }).strict();
export type ChannelRoute = z.infer<typeof ChannelRouteSchema>;
export class ChannelRouteError extends Error {}
const prefix = "channel-route:";
const routeKey = (channel: string, scope: string): string => `channel-route:${channel}:${scope}`;

/** Only addresses whose adapter defines a thread suffix have a parent; Matrix's host colon is not one. */
export function parentScope(kind: string, scope: string): string | null {
  if (kind === "telegram" && /^-?\d+:\d+$/.test(scope)) return scope.split(":")[0]!;
  if (kind === "slack" && /^[CGD][A-Z0-9]+:\d+\.\d+$/i.test(scope)) return scope.split(":")[0]!;
  return null;
}
export function channelRoutes(store: Pick<Store, "list">, owner: string): ChannelRoute[] {
  return store.list("settings", owner).flatMap(record => {
    if (!record.id.startsWith(prefix)) return [];
    const parsed = ChannelRouteSchema.safeParse(record.data);
    return parsed.success && parsed.data.trunkId !== null ? [parsed.data] : [];
  });
}
/** Exact chat, supported parent, whole app. An explicit default stops inheritance. */
export function routeFor(store: Pick<Store, "get">, owner: string, channel: string, scope: string, kind: string): ChannelRoute | null {
  for (const candidate of [...new Set([scope, parentScope(kind, scope), "*"])]) {
    if (!candidate) continue;
    const parsed = ChannelRouteSchema.safeParse(store.get("settings", owner, routeKey(channel, candidate))?.data);
    if (parsed.success && parsed.data.channel === channel && parsed.data.scope === candidate && parsed.data.trunkId !== null) return parsed.data;
  }
  return null;
}
export const bindingFor = (store: Pick<Store, "get">, owner: string, channel: string, scope: string, kind: string): string | null => {
  const id = routeFor(store, owner, channel, scope, kind)?.trunkId;
  return id && id !== "default" ? id : null;
};
export function dropTrunkRoutes(store: Store, owner: string, trunkId: string): void {
  for (const route of channelRoutes(store, owner).filter(one => one.trunkId === trunkId))
    store.delete("settings", owner, routeKey(route.channel, route.scope));
  for (const record of store.list("settings", owner)) {
    if (!record.id.startsWith("channel-session:")) continue;
    const chat = record.data as Partial<ChatThread>;
    if (chat.trunkId === trunkId && chat.channel && chat.chatId) freshThread(store, owner, chat.channel, chat.chatId);
  }
}

export interface RoutingDeps {
  store: Store;
  owner: string;
  kindOf(channel: string): string | null;
  requireTrunk(channel: string, trunkId: string): void;
  busy(channel: string, chatId: string): boolean;
  activeChatIds(channel: string): string[];
}
/** New bindings start fresh threads; earlier conversations remain in history. */
export function saveChannelRoute(deps: RoutingDeps, input: unknown, actor: string): ChannelRoute {
  const route = ChannelRouteSchema.parse(input), { store, owner } = deps;
  const kind = deps.kindOf(route.channel);
  if (!kind) throw new ChannelRouteError("Connect that chat app before choosing who answers there.");
  if (route.trunkId && route.trunkId !== "default") deps.requireTrunk(route.channel, route.trunkId);
  store.atomically(() => {
    const chats = store.list("settings", owner).flatMap(record => {
      if (!record.id.startsWith("channel-session:")) return [];
      const chat = record.data as Partial<ChatThread>;
      if (chat.channel !== route.channel || !chat.chatId) return [];
      return [{ chatId: chat.chatId, before: bindingFor(store, owner, route.channel, chat.chatId, kind) }];
    });
    for (const chatId of deps.activeChatIds(route.channel))
      if (!chats.some(chat => chat.chatId === chatId)) chats.push({ chatId, before: bindingFor(store, owner, route.channel, chatId, kind) });
    if (route.trunkId === null) store.delete("settings", owner, routeKey(route.channel, route.scope));
    else store.save("settings", owner, routeKey(route.channel, route.scope), { ...route });
    for (const chat of chats) {
      if (chat.before === bindingFor(store, owner, route.channel, chat.chatId, kind)) continue;
      if (deps.busy(route.channel, chat.chatId)) throw new ChannelRouteError("Wait for that chat's task to finish, or stop it, before changing who answers.");
      freshThread(store, owner, route.channel, chat.chatId);
    }
    audit(store, owner, { action: "policy.changed", actor, subject: `who answers ${route.scope} on ${route.channel}`,
      reason: route.trunkId === null ? "The chat inherits its answering Trunk" : `The chat uses ${route.trunkId === "default" ? "the default Trunk" : "the chosen Trunk"}`, outcome: "saved" });
  });
  return route;
}
