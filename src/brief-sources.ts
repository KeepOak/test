import { z } from "zod";
import type { Store } from "./store.js";
export const BriefSourcesSchema = z.object({ newsWatchIds: z.array(z.string().uuid()).max(3).default([]), healthSource: z.enum(["off", "oura", "whoop"]).default("off") }).strict();
export function briefSources(store: Store, owner: string) {
  const saved = BriefSourcesSchema.safeParse(store.get("settings", owner, "brief-sources")?.data);
  return saved.success ? saved.data : BriefSourcesSchema.parse({});
}
