import { z } from "zod";
import type { Store } from "./store.js";
import type { WebAccess } from "./integrations/web.js";
import { applyContentPolicy, detectInjection } from "./content-guard.js";

/** Explicit page choices, never a default news query or a personal-health integration. */
export const BriefSourceSchema = z.object({
  section: z.enum(["health", "news"]),
  label: z.string().trim().min(1).max(80),
  url: z.string().url().max(2048).refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  }, "Choose an HTTP(S) page without embedded credentials"),
}).strict();
export type BriefSource = z.infer<typeof BriefSourceSchema>;
const SnapshotSchema = BriefSourceSchema.extend({
  sourceUrl: z.string().url().max(2048),
  checkedAt: z.iso.datetime(),
  excerpt: z.string().max(600),
  status: z.enum(["read", "empty", "unavailable"]),
}).strict();
const CacheSchema = z.object({ signature: z.string().max(10000), snapshots: z.array(SnapshotSchema).max(4) }).strict();
const cacheId = "brief-source-snapshots";
const signatureOf = (sources: BriefSource[]): string => JSON.stringify(sources);
const words = (value: string): string => value.replace(/[\r\n\t]+/g, " ").replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&");
const link = (value: string): string => new URL(value).href.replace(/[()<>\s]/g,
  (char) => char === "(" ? "%28" : char === ")" ? "%29" : encodeURIComponent(char));

/** Four bounded public-page reads through the existing web/network and content policies. */
export class BriefSources {
  constructor(private readonly store: Store, private readonly web: WebAccess) {}

  async refresh(owner: string, sources: BriefSource[], stillCurrent: () => void): Promise<void> {
    const policy = JSON.stringify(this.web.settings());
    const current = (): void => {
      stillCurrent();
      if (JSON.stringify(this.web.settings()) !== policy) throw new Error("The web settings changed while reading brief sources.");
    };
    const snapshots: z.infer<typeof SnapshotSchema>[] = [];
    for (const source of sources) {
      current();
      const checkedAt = new Date().toISOString();
      try {
        // Never turn a public-source choice into private-network access, even when other web work allows it.
        if (this.web.settings().allowPrivateAddresses) throw new Error("Private addresses are enabled");
        const page = await this.web.fetchPage(source.url, 2400);
        current();
        if (this.web.settings().allowPrivateAddresses) throw new Error("The web policy changed");
        const applied = applyContentPolicy(page.text, detectInjection(page.text), this.web.injectionPolicy);
        if (applied.blocked) throw new Error("The source was blocked by the content policy");
        snapshots.push(SnapshotSchema.parse({ ...source, sourceUrl: source.url, url: page.url,
          checkedAt, excerpt: applied.text.replace(/\s+/g, " ").trim().slice(0, 600),
          status: applied.text.trim() ? "read" : "empty" }));
      } catch {
        current();
        // Network/credential details stay out of a message that may be delivered to a chat.
        snapshots.push({ ...source, sourceUrl: source.url, checkedAt, excerpt: "", status: "unavailable" });
      }
    }
    current();
    this.store.save("settings", owner, cacheId, { signature: signatureOf(sources), snapshots });
  }

  lines(owner: string, sources: BriefSource[], section: "health" | "news"): string[] {
    if (sources.length) this.store.profiles.requireOwner("Reading brief sources");
    const cache = CacheSchema.safeParse(this.store.get("settings", owner, cacheId)?.data);
    const current = cache.success && cache.data.signature === signatureOf(sources) ? cache.data.snapshots : [];
    const selected = sources.filter((source) => source.section === section);
    if (!selected.length) return []; // no heading at all until the owner picks a page for it
    return selected.map((source) => {
      const snapshot = current.find((item) => item.section === section && item.sourceUrl === source.url && item.label === source.label);
      const citation = `[${words(source.label)}](${link(snapshot?.url ?? source.url)})`;
      if (!snapshot) return `${citation} — not read yet. Send or refresh the brief to read this selected public page.`;
      const status = snapshot.status === "unavailable" ? "Source unavailable; no excerpt retained. Check the page and web settings."
        : snapshot.status === "empty" ? "The page returned no readable text." : `Page excerpt: ${words(snapshot.excerpt)}`;
      return `${citation} — ${status} (checked ${snapshot.checkedAt})`;
    });
  }

  clear(owner: string): void { this.store.delete("settings", owner, cacheId); }
}
