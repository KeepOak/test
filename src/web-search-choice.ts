import { z } from "zod";
import type { Store } from "./store.js";
import { backendNotes, SearchBackendSchema, searchBackends, type SearchBackend, type SearchBackendSettings } from "./integrations/web-search.js";

/**
 * Which search service "search the web" goes to, chosen in the window (Settings › Advanced › Web search). The launch
 * settings file (web › search) still sets it for a Branch nobody has chosen for; once the owner picks one here, the
 * pick wins. A paid service's key stays in the locker under the secret named here; only its name is saved, and the key
 * is read for each search by the launcher's `searchKey` (src/index.ts), as before.
 *
 * This only changes where a search goes: every request still passes the same network rules, and the default is the
 * free one that needs nothing set up.
 */
export const webSearchKey = "web-search";

/** The secret a paid service's key is looked for under when the owner names none. */
export const defaultKeyNames: Partial<Record<SearchBackend, string>> = {
  brave: "BRAVE_SEARCH_KEY", tavily: "TAVILY_API_KEY", exa: "EXA_API_KEY", serper: "SERPER_API_KEY",
};
export const needsKey = (backend: SearchBackend): boolean => backend in defaultKeyNames;

/** The owner's saved pick, or null when they never chose here (the launch settings file decides then). */
export function savedSearchChoice(store: Pick<Store, "get">, owner: string): SearchBackendSettings | null {
  const parsed = SearchBackendSchema.safeParse(store.get("settings", owner, webSearchKey)?.data);
  if (!parsed.success) return null;
  const chosen = parsed.data;
  const keySecret = chosen.keySecret ?? defaultKeyNames[chosen.backend];
  return keySecret ? { ...chosen, keySecret } : chosen;
}

export const SearchChoiceInputSchema = z.object({
  backend: z.enum(searchBackends),
  searxngUrl: z.string().url().max(300).optional(),
  keySecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "A secret's name is capital letters, digits and _, like BRAVE_SEARCH_KEY").optional(),
}).strict();

/** Saves the owner's pick. SearXNG needs its address, given now or kept from before. */
export function saveSearchChoice(store: Store, owner: string, input: unknown): SearchBackendSettings {
  const given = SearchChoiceInputSchema.parse(input);
  const saved = SearchBackendSchema.safeParse(store.get("settings", owner, webSearchKey)?.data);
  const before = saved.success ? saved.data : null;
  const searxngUrl = given.searxngUrl ?? before?.searxngUrl;
  if (given.backend === "searxng" && !searxngUrl) throw new Error("Give the address of your SearXNG first, like https://search.example.org. An address on your own network also needs private addresses allowed in the web settings.");
  // A secret name the owner gave for this same service is kept; otherwise the service's usual name is used.
  const keySecret = given.keySecret ?? (before?.backend === given.backend ? before.keySecret : undefined);
  const value = SearchBackendSchema.parse({ backend: given.backend, ...(searxngUrl ? { searxngUrl } : {}), ...(keySecret ? { keySecret } : {}) });
  store.save("settings", owner, webSearchKey, value);
  return savedSearchChoice(store, owner)!;
}

export interface SearchChoiceView {
  /** The service searches go to now. */
  chosen: SearchBackendSettings;
  /** True while nothing was picked here and the launch settings file (or its default) decides. */
  fromLaunchFile: boolean;
  services: { id: SearchBackend; note: string; needsKey: boolean; keySecret: string | null; hasKey: boolean | null }[];
}

/** What the window shows: the service in use, and for each one what it needs. `hasKey` is null when it takes no key. */
export function searchChoiceView(store: Pick<Store, "get">, owner: string, launch: SearchBackendSettings, hasSecret: (name: string) => boolean): SearchChoiceView {
  const saved = savedSearchChoice(store, owner);
  const chosen = saved ?? launch;
  const services = searchBackends.map((id) => {
    const keySecret = needsKey(id) ? (chosen.backend === id && chosen.keySecret ? chosen.keySecret : defaultKeyNames[id]!) : null;
    return { id, note: backendNotes[id], needsKey: needsKey(id), keySecret, hasKey: keySecret ? hasSecret(keySecret) : null };
  });
  return { chosen, fromLaunchFile: saved === null, services };
}

export class WebSearchApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** GET /api/web-search reads the choice; POST changes it (the owner only). */
export async function webSearchApi(
  deps: { store: Store; owner: string; launch: () => SearchBackendSettings; hasSecret: (name: string) => boolean; requireOwner: (what: string) => void;
    requireUnlocked: () => void },
  method: string, body: () => Promise<unknown>,
): Promise<SearchChoiceView> {
  if (method === "POST") {
    deps.requireOwner("Choosing where web searches go");
    const input = await body().catch((error: unknown) => {
      throw new WebSearchApiError(400, error instanceof Error ? error.message : "That choice can't be read.");
    });
    // Reading the body takes time: the owner and the app lock are checked again right before the choice is kept.
    deps.requireOwner("Choosing where web searches go");
    deps.requireUnlocked();
    try { saveSearchChoice(deps.store, deps.owner, input); } catch (error) {
      const message = error instanceof z.ZodError ? error.issues[0]?.message ?? "That choice can't be read." : (error as Error).message;
      throw new WebSearchApiError(400, message);
    }
  } else if (method !== "GET") throw new WebSearchApiError(405, "Read the choice with GET or change it with POST.");
  return searchChoiceView(deps.store, deps.owner, deps.launch(), deps.hasSecret);
}
