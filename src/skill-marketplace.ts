import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { SkillRegistry } from "./registry-install.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { currentPerson } from "./people/context.js";
import { lockdownActive } from "./lockdown.js";

const https = z.string().url().max(2000).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
}, "Use an HTTPS registry address without credentials or a fragment");
const Source = z.object({ id: z.string().uuid(), label: z.string().trim().min(1).max(80), url: https }).strict();
const Sources = z.object({ sources: z.array(Source).max(10) }).strict();
const Browse = z.object({ source: z.string().uuid(), query: z.string().trim().max(200).default(""),
  offset: z.number().int().min(0).max(500).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict();
const Inspect = z.object({ source: z.string().uuid(), skillId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80) }).strict();
const Install = z.object({ ticket: z.string().uuid(), approve: z.literal(true) }).strict();
const key = "skill-marketplace-sources";
type Review = Awaited<ReturnType<SkillRegistry["inspect"]>>;
type Ticket = { source: z.infer<typeof Source>; review: Review; at: number; owner: string };

/** Sources are curated by the owner. Listing a source never grants trust to its advertised key. */
export class SkillMarketplace {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly store: Store, private readonly owner: string, private readonly registry: SkillRegistry,
    private readonly locked: () => boolean) {}
  guard(): void {
    this.store.profiles.requireOwner("The skill marketplace");
    if (currentPerson() || startedWithShortLivedKey() || this.locked() || lockdownActive(this.store, this.owner))
      throw new Error("Use the skill marketplace in the owner's unlocked app window.");
  }
  sources(): z.infer<typeof Source>[] {
    const result = Sources.safeParse(this.store.get("settings", this.owner, key)?.data ?? { sources: [] });
    return result.success ? result.data.sources : [];
  }
  add(input: unknown) {
    this.guard();
    const value = z.object({ label: Source.shape.label, url: https }).strict().parse(input);
    if (this.sources().some(source => source.url === value.url)) throw new Error("This registry is already in your catalogue.");
    const sources = Sources.parse({ sources: [...this.sources(), { ...value, id: randomUUID() }] }).sources;
    this.store.save("settings", this.owner, key, { sources });
    return { sources, note: "Source listed, not trusted. Pin a verified publisher key separately using the existing registry trust flow." };
  }
  remove(input: unknown) {
    this.guard();
    const { source } = z.object({ source: z.string().uuid() }).strict().parse(input);
    const sources = this.sources().filter(v => v.id !== source);
    this.store.save("settings", this.owner, key, { sources });
    for (const [id, ticket] of this.tickets) if (ticket.source.id === source) this.tickets.delete(id);
    return { sources };
  }
  private source(id: string) {
    const found = this.sources().find(v => v.id === id);
    if (!found) throw new Error("Choose a source in your curated catalogue.");
    return found;
  }
  async browse(input: unknown) {
    this.guard();
    const v = Browse.parse(input), source = this.source(v.source), index = await this.registry.browse(source.url);
    this.guard();
    const terms = v.query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = index.skills.filter(skill => terms.every(term => `${skill.name} ${skill.description} ${skill.id}`.toLowerCase().includes(term)));
    return { source, key: index.key, registryName: index.name, total: all.length, offset: v.offset,
      skills: all.slice(v.offset, v.offset + v.limit), note: "Publisher descriptions are untrusted. Inspect the actual document before approving an inactive install." };
  }
  async inspect(input: unknown) {
    this.guard();
    const v = Inspect.parse(input), source = this.source(v.source), review = await this.registry.inspect(source.url, v.skillId);
    this.guard();
    if (JSON.stringify(this.source(source.id)) !== JSON.stringify(source)) throw new Error("The source changed. Browse again.");
    https.parse(review.entry.url);
    for (const [id, entry] of this.tickets) if (entry.at + 10 * 60_000 <= Date.now()) this.tickets.delete(id);
    if (this.tickets.size >= 8) throw new Error("Eight inspections are open. Wait for one to expire before inspecting more.");
    const ticket = randomUUID();
    this.tickets.set(ticket, { source, review, at: Date.now(), owner: this.owner });
    return { ...review, ticket, source, expiresInMinutes: 10, inactiveInstallOnly: true,
      canInstall: review.findings.length === 0 || this.store.skills.policy(this.owner) === "review" };
  }
  async install(input: unknown) {
    this.guard();
    const { ticket } = Install.parse(input), kept = this.tickets.get(ticket);
    if (!kept || kept.owner !== this.owner || kept.at + 10 * 60_000 <= Date.now()) throw new Error("This inspection expired. Inspect the skill again.");
    this.tickets.delete(ticket);
    const guard = () => {
      this.guard();
      if (JSON.stringify(this.source(kept.source.id)) !== JSON.stringify(kept.source)) throw new Error("The source changed. Inspect it again.");
    };
    guard();
    return this.registry.installReviewed(kept.review, guard);
  }
  async trust(input: unknown) {
    this.guard();
    const v = z.object({ source: z.string().uuid(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/), approve: z.literal(true) }).strict().parse(input);
    const source = this.source(v.source);
    return { key: await this.registry.trustKey(source.url, v.fingerprint, () => {
      this.guard();
      if (JSON.stringify(this.source(source.id)) !== JSON.stringify(source)) throw new Error("The source changed. Browse again.");
    }) };
  }
}

export async function skillMarketplaceApi(market: SkillMarketplace, method: string, path: string, body: () => Promise<unknown>) {
  market.guard();
  if (method === "GET" && path === "/api/skill-marketplace") return { sources: market.sources(), curatedBy: "owner", shippedTrustedSources: 0 };
  if (method !== "POST") return undefined;
  if (path === "/api/skill-marketplace/sources") return market.add(await body());
  if (path === "/api/skill-marketplace/remove") return market.remove(await body());
  if (path === "/api/skill-marketplace/browse") return market.browse(await body());
  if (path === "/api/skill-marketplace/inspect") return market.inspect(await body());
  if (path === "/api/skill-marketplace/install") return market.install(await body());
  if (path === "/api/skill-marketplace/trust") return market.trust(await body());
  return undefined;
}
