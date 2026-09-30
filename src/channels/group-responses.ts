import { z } from "zod";
import type { Store } from "../store.js";
export const GroupResponseSchema = z.object({ connection: z.string().min(1).max(100), chatId: z.string().min(1).max(100),
  activation: z.enum(["mention", "always"]).default("mention"), autoThread: z.boolean().default(false) }).strict();
const Settings = z.object({ groups: z.array(GroupResponseSchema).max(100).default([]) }).strict();
export function groupResponses(store: Pick<Store, "get">, owner: string) {
  return Settings.parse(store.get("settings", owner, "group-responses")?.data ?? {});
}
export function saveGroupResponses(store: Pick<Store, "save">, owner: string, input: unknown, configured: (id: string, thread: boolean) => boolean = () => true) {
  const settings = Settings.parse(input);
  if (settings.groups.some((g) => !configured(g.connection, g.autoThread))) throw new Error("Choose a configured connection; automatic threads require Discord.");
  if (new Set(settings.groups.map((g) => `${g.connection}:${g.chatId}`)).size !== settings.groups.length) throw new Error("Each group must appear once.");
  store.save("settings", owner, "group-responses", settings);
  return settings;
}
