import { z } from "zod";
import type { Store } from "./store.js";
import type { MemoryRetrieval } from "./memory-retrieval.js";
import { markChosen, sentKeys } from "./ship-on.js";

/**
 * Settings › Advanced › Memory › "Archive facts unused for": 90 days, 180 days or never. A fact that nobody drew on and
 * nobody changed for that long is set aside by itself, once a day: moved into the archive with a note (`setAside`), its
 * versions kept, and brought back from Library › Memory › Archive. Nothing is deleted, so it is none of (a)–(f), but it
 * changes what the assistant remembers without being asked, so it is a choice the owner makes: "Never" is where Branch
 * starts (the owner's own facts stay exactly as they left them).
 *
 * "Unused" is the later of the fact's own last change and the last time a conversation drew on it (memory_uses,
 * src/memory-retrieval.ts). A task's scratch note is left to its own job.
 */
export const autoArchiveKey = "memory-auto-archive";
export const AutoArchiveSchema = z.object({
  afterDays: z.union([z.literal(90), z.literal(180)]).nullable().default(null),
  /** When it last looked, so it looks at most once a day. Branch fills this in; it is not a setting. */
  lastRunAt: z.string().optional(),
}).strict();
export type AutoArchiveSettings = z.infer<typeof AutoArchiveSchema>;
const day = 86_400_000;

export function autoArchiveSettings(store: Pick<Store, "get">, owner: string): AutoArchiveSettings {
  const saved = AutoArchiveSchema.safeParse(store.get("settings", owner, autoArchiveKey)?.data ?? {});
  return saved.success ? saved.data : AutoArchiveSchema.parse({});
}

export function saveAutoArchiveSettings(store: Store, owner: string, input: unknown): AutoArchiveSettings {
  const given = z.object({ afterDays: AutoArchiveSchema.shape.afterDays.unwrap() }).strict().parse(input);
  const value = AutoArchiveSchema.parse({ ...autoArchiveSettings(store, owner), ...given });
  store.save("settings", owner, autoArchiveKey, value);
  markChosen(store, owner, autoArchiveKey, sentKeys(given));
  return value;
}

/** The facts that would be set aside now, oldest first. */
export function unusedFacts(store: Store, retrieval: Pick<MemoryRetrieval, "lastUses">, owner: string, afterDays: number, now: number) {
  const cutoff = now - afterDays * day;
  const used = retrieval.lastUses(owner);
  return store.list("memory", owner)
    .filter((record) => (record.data as { kind?: string }).kind !== "task-scratch")
    .map((record) => ({ record, last: Math.max(Date.parse(record.updatedAt), Date.parse(used.get(record.id) ?? "") || 0) }))
    .filter((fact) => Number.isFinite(fact.last) && fact.last < cutoff)
    .sort((a, b) => a.last - b.last)
    .map((fact) => fact.record);
}

/** The scheduler's beat: at most once a day, and nothing at all while the choice is "never". Returns how many were set aside. */
export function autoArchiveTick(store: Store, retrieval: Pick<MemoryRetrieval, "lastUses">, owner: string, now = Date.now()): number {
  const settings = autoArchiveSettings(store, owner);
  if (!settings.afterDays) return 0;
  const last = settings.lastRunAt ? Date.parse(settings.lastRunAt) : 0;
  if (now - last < day) return 0;
  store.save("settings", owner, autoArchiveKey, { ...settings, lastRunAt: new Date(now).toISOString() });
  let moved = 0;
  for (const record of unusedFacts(store, retrieval, owner, settings.afterDays, now).slice(0, 200)) {
    try { store.setAsideMemory(owner, record.id, `Unused for ${settings.afterDays} days, set aside by itself`); moved += 1; }
    catch { /* a fact changed or removed meanwhile is left as it is */ }
  }
  return moved;
}

export class AutoArchiveApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** GET /api/memory/auto-archive reads the choice and how many facts it would set aside now; POST changes it (owner only). */
export async function autoArchiveApi(
  deps: { store: Store; owner: string; retrieval: Pick<MemoryRetrieval, "lastUses">; requireOwner: (what: string) => void;
    requireUnlocked: () => void },
  method: string, body: () => Promise<unknown>,
): Promise<{ settings: AutoArchiveSettings; wouldSetAside: number }> {
  deps.requireOwner("Setting unused facts aside");
  if (method === "POST") {
    let input: unknown;
    try { input = await body(); }
    catch { throw new AutoArchiveApiError(400, "Send afterDays as 90, 180 or null (never)."); }
    // Reading the body takes time: the owner and the app lock are checked again right before the choice is kept.
    deps.requireOwner("Setting unused facts aside");
    deps.requireUnlocked();
    try { saveAutoArchiveSettings(deps.store, deps.owner, input); }
    catch { throw new AutoArchiveApiError(400, "Send afterDays as 90, 180 or null (never)."); }
  } else if (method !== "GET") throw new AutoArchiveApiError(405, "Read the choice with GET or change it with POST.");
  const settings = autoArchiveSettings(deps.store, deps.owner);
  return { settings, wouldSetAside: settings.afterDays ? unusedFacts(deps.store, deps.retrieval, deps.owner, settings.afterDays, Date.now()).length : 0 };
}
