import { createHash, createPublicKey, sign as signBytes, verify as verifyBytes, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { NetworkPolicy } from "./network-policy.js";
import { scanSkill } from "./skill-scan.js";
import { parseSkillDocument } from "./skill-document.js";

/**
 * A skill registry is a plain JSON index the owner points at (their own, a team's, or a public one).
 * Installing from it fetches one SKILL.md, checks its published fingerprint, runs the usual skill
 * scan, and installs it disabled: nothing a registry ships can act until the owner activates it.
 * A version 2 registry also publishes a signing key. That key is trusted only once it is pinned on this
 * computer, either shipped with Branch (`shippedRegistryKeys`) or approved by the owner for that registry
 * (`trustKey`); a key the registry supplies about itself proves nothing on its own, since whoever can change
 * the index can change the key beside it. Entries signed with a pinned key are shown as checked; a published
 * key that is not pinned leaves them "untrusted" (installable, never shown as checked); entries without a
 * signature are shown plainly as unsigned. Once a registry's key is pinned, a changed or missing key, an
 * unsigned entry or a signature that does not match stops the install, until the owner approves the new key. Installed skills remember where they came from, so later versions can be
 * offered, installed in one step, and put back if the new version is worse.
 */
const registryEntry = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1).max(64),
  description: z.string().max(1024),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().max(40).optional(),
  /** What changed in this version, in the registry author's words. */
  changelog: z.string().max(2000).optional(),
  /** Base64 ed25519 signature over this entry, made with the registry's published key. */
  signature: z.string().max(200).optional(),
}).strict();
export type RegistryEntry = z.infer<typeof registryEntry>;
export const RegistryIndexSchema = z.object({
  format: z.literal("branch-skill-registry"),
  version: z.union([z.literal(1), z.literal(2)]),
  name: z.string().min(1).max(120),
  /** Base64 (SPKI) ed25519 public key the registry publishes once; only version 2 registries have one. */
  publicKey: z.string().max(200).optional(),
  skills: z.array(registryEntry).max(500),
}).strict();
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>;
export interface SkillOrigin { registry: string; registryName: string; skillId: string; sha256: string; version: string | null; signed: string; installedAt: string; previousSkillVersion?: number | null }
const maxDocumentBytes = 48 * 1024, maxIndexBytes = 512 * 1024;

/** The exact bytes a registry signs for one entry. Fixed order, so key order in the file cannot change it. */
export function signingPayload(registryName: string, entry: Pick<RegistryEntry, "id" | "version" | "sha256">): Buffer {
  return Buffer.from(["branch-skill-registry", registryName, entry.id, entry.version ?? "", entry.sha256].join("\n"), "utf8");
}
export function signRegistryEntry(privateKey: KeyObject, registryName: string, entry: Pick<RegistryEntry, "id" | "version" | "sha256">): string {
  return signBytes(null, signingPayload(registryName, entry), privateKey).toString("base64");
}
export type EntrySigned = "checked" | "untrusted" | "unsigned" | "invalid";
/**
 * Keys that ship with Branch, by the SHA-256 of their SPKI bytes. None do yet: an official registry adds its key here,
 * in code, so it cannot be swapped by editing a data file.
 */
export const shippedRegistryKeys: readonly { name: string; fingerprint: string }[] = [];
/** The SHA-256 (hex) of a base64 SPKI key, as the owner is shown it and as it is pinned. */
export function registryKeyFingerprint(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
}
/**
 * "checked" only when the signature matches a key pinned on this computer (`trusted`, fingerprints). With no pinned
 * key, a good signature is "untrusted", no signature is "unsigned", and a bad one is "invalid". With a pinned key, the
 * registry may not drop to less: a different or missing key, or an unsigned entry, is "invalid".
 */
export function verifyRegistryEntry(index: RegistryIndex, entry: RegistryEntry, trusted: readonly string[] = []): EntrySigned {
  const published = index.publicKey ? registryKeyFingerprint(index.publicKey) : null;
  if (trusted.length && (!published || !trusted.includes(published) || !entry.signature)) return "invalid";
  if (!index.publicKey || !entry.signature) return "unsigned";
  try {
    const key = createPublicKey({ key: Buffer.from(index.publicKey, "base64"), format: "der", type: "spki" });
    const good = verifyBytes(null, signingPayload(index.name, entry), key, Buffer.from(entry.signature, "base64"));
    return !good ? "invalid" : trusted.length ? "checked" : "untrusted";
  } catch { return "invalid"; }
}
/** Where a registry's key stands on this computer, for the owner to read before approving it. */
export interface RegistryKeyState {
  /** The fingerprint the registry publishes now, or null when it publishes none. */
  published: string | null;
  /** The fingerprint pinned for it here (shipped or approved), or null. */
  pinned: string | null;
  status: "pinned" | "not-pinned" | "changed" | "none";
}
const pinKey = (url: string): string => `registry-key:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
/** Why an entry cannot be installed, in plain words: a key that changed or went, or a signature that fails. */
function invalidWords(key: RegistryKeyState, outcome: string): string {
  if (key.status === "changed") return `This registry's signing key is not the one you trusted, so ${outcome}. Approve the new key only if you trust the change.`;
  if (key.status === "none" && key.pinned) return `This registry no longer publishes the signing key you trusted, so ${outcome}.`;
  if (key.pinned) return `This skill is not signed with the key you trusted for this registry, so ${outcome}.`;
  return `The registry's signature for this skill does not match the key it published, so ${outcome}.`;
}

export class SkillRegistry {
  constructor(private readonly store: Store, private readonly owner: string, private readonly policy: NetworkPolicy, private readonly fetchImpl: typeof fetch = globalThis.fetch) {}
  private async read(url: string, limit: number): Promise<string> {
    const target = new URL(url);
    await this.policy.assertAllowed(target, "registry address");
    const response = await this.fetchImpl(target, { redirect: "error", signal: AbortSignal.timeout(20000), headers: { accept: "application/json, text/plain, text/markdown" } });
    if (!response.ok) throw new Error(`The registry did not answer (HTTP ${response.status})`);
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error("The registry response is larger than allowed");
    return text;
  }
  /** Fingerprints trusted for this registry: the shipped ones and the one the owner approved for its address. */
  private trusted(url: string): string[] {
    const approved = (this.store.get("settings", this.owner, pinKey(url))?.data as { fingerprint?: string } | undefined)?.fingerprint;
    return [...shippedRegistryKeys.map((key) => key.fingerprint), ...(approved ? [approved] : [])];
  }
  private keyState(url: string, index: RegistryIndex): RegistryKeyState {
    const published = index.publicKey ? registryKeyFingerprint(index.publicKey) : null;
    const trusted = this.trusted(url);
    const pinned = published && trusted.includes(published) ? published : trusted.at(-1) ?? null;
    const status = !pinned ? (published ? "not-pinned" : "none") : published === pinned ? "pinned" : published ? "changed" : "none";
    return { published, pinned, status };
  }
  /**
   * The owner's yes to a registry's key, by the fingerprint they were shown. It is pinned only if the registry
   * publishes exactly that key right now; approving a different fingerprint later is how a key change is accepted.
   */
  async trustKey(url: string, fingerprint: string, guard: () => void = () => undefined): Promise<RegistryKeyState> {
    const index = RegistryIndexSchema.parse(JSON.parse(await this.read(url, maxIndexBytes)));
    const published = index.publicKey ? registryKeyFingerprint(index.publicKey) : null;
    if (!published) throw new Error("This registry publishes no signing key, so there is nothing to trust.");
    if (published !== fingerprint.toLowerCase()) throw new Error("The registry's key is not the one you approved, so it was not trusted. Look at the registry again.");
    guard();
    this.store.save("settings", this.owner, pinKey(url), { url, name: index.name, fingerprint: published, approvedAt: new Date().toISOString() });
    return this.keyState(url, index);
  }
  /** The catalog a registry advertises, each entry labelled as `verifyRegistryEntry` says; nothing is installed by looking. */
  async browse(url: string) {
    const index = RegistryIndexSchema.parse(JSON.parse(await this.read(url, maxIndexBytes)));
    const trusted = this.trusted(url);
    const skills = index.skills.map((entry) => ({ ...entry, signed: verifyRegistryEntry(index, entry, trusted) }));
    this.store.save("settings", this.owner, `registry-index:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`,
      { url, name: index.name, skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description, version: s.version ?? null })) });
    return { ...index, skills, key: this.keyState(url, index) };
  }
  /** Fetches one listed skill, checks its fingerprint and signature, scans it and installs it disabled. */
  async inspect(url: string, skillId: string) {
    const index = await this.browse(url), entry = index.skills.find(s => s.id === skillId);
    if (!entry) throw new Error("This source does not list that skill.");
    if (entry.signed === "invalid") throw new Error(invalidWords(index.key, "it cannot be inspected for installation"));
    const target = new URL(entry.url);
    if (target.protocol !== "https:" || target.username || target.password || target.hash)
      throw new Error("Marketplace skill documents must use HTTPS without credentials or fragments.");
    const document = await this.fetchDocument(entry), metadata = parseSkillDocument(document);
    return { registry: url, registryName: index.name, entry, key: index.key, document, metadata,
      findings: scanSkill(document), fingerprintMatches: true,
      note: "Static document scan only. A matching hash or pinned signature does not prove a skill safe. No code was executed." };
  }
  /** Recheck the exact reviewed identity/bytes/trust immediately before the inactive install. */
  async installReviewed(review: Awaited<ReturnType<SkillRegistry["inspect"]>>, guard: () => void) {
    const current = await this.inspect(review.registry, review.entry.id);
    if (JSON.stringify(current) !== JSON.stringify(review)) throw new Error("The skill or signing trust changed. Inspect it again before approving.");
    guard();
    const trusted = this.trusted(review.registry);
    if (trusted.length ? !current.key.published || !trusted.includes(current.key.published) || current.entry.signed !== "checked" : current.key.pinned !== null)
      throw new Error("Publisher trust changed during inspection. Inspect again before approving.");
    const installed = this.store.skills.install(this.owner, { document: current.document });
    if (installed.activeVersion !== null) this.store.skills.disable(this.owner, installed.id, { expectedRevision: installed.revision });
    const origin: SkillOrigin = { registry: review.registry, registryName: review.registryName, skillId: review.entry.id,
      sha256: review.entry.sha256, version: review.entry.version ?? null, signed: review.entry.signed,
      installedAt: new Date().toISOString(), previousSkillVersion: null };
    this.store.save("settings", this.owner, `skill-origin:${installed.id}`, { ...origin });
    return { ...this.store.skills.view(this.owner, installed.id), origin };
  }
  async install(url: string, skillId: string) {
    const index = await this.browse(url);
    const entry = index.skills.find((s) => s.id === skillId);
    if (!entry) throw new Error(`The registry "${index.name}" has no skill called ${skillId}`);
    if (entry.signed === "invalid") throw new Error(invalidWords(index.key, "it was not installed"));
    const document = await this.fetchDocument(entry);
    const installed = this.store.skills.install(this.owner, { document });
    if (installed.activeVersion !== null) this.store.skills.disable(this.owner, installed.id, { expectedRevision: installed.revision });
    const view = this.store.skills.view(this.owner, installed.id);
    const origin: SkillOrigin = { registry: url, registryName: index.name, skillId, sha256: entry.sha256, version: entry.version ?? null, signed: entry.signed, installedAt: new Date().toISOString(), previousSkillVersion: null };
    this.store.save("settings", this.owner, `skill-origin:${installed.id}`, { ...origin });
    return { ...view, origin };
  }
  private async fetchDocument(entry: RegistryEntry): Promise<string> {
    const document = await this.read(entry.url, maxDocumentBytes);
    if (createHash("sha256").update(document, "utf8").digest("hex") !== entry.sha256)
      throw new Error("The skill file does not match the fingerprint the registry published, so it was not installed");
    return document;
  }
  private origins(): { id: string; origin: SkillOrigin }[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith("skill-origin:"))
      .map((row) => ({ id: row.id.slice("skill-origin:".length), origin: row.data as unknown as SkillOrigin }));
  }
  /** Asks every registry the owner installed from whether a newer version of their skills exists. */
  async updates() {
    const indexes = new Map<string, Awaited<ReturnType<SkillRegistry["browse"]>>>();
    const available: { skillId: string; name: string; from: string | null; to: string | null; changelog: string; signed: string; registryName: string }[] = [];
    for (const { id, origin } of this.origins()) {
      const index = indexes.get(origin.registry) ?? await this.browse(origin.registry).catch(() => null);
      if (!index) continue;
      indexes.set(origin.registry, index);
      const entry = index.skills.find((s) => s.id === origin.skillId);
      if (!entry || !entry.version || entry.version === origin.version) continue;
      const skill = this.store.skills.list(this.owner).find((s) => s.id === id);
      if (!skill) continue;
      available.push({ skillId: id, name: skill.name, from: origin.version, to: entry.version, changelog: entry.changelog ?? "", signed: entry.signed, registryName: index.name });
    }
    return { updates: available, checkedAt: new Date().toISOString() };
  }
  /** Installs the newer version as a new retained version, keeping the one in use available to go back to. */
  async update(skillId: string) {
    const origin = this.store.get("settings", this.owner, `skill-origin:${skillId}`)?.data as unknown as SkillOrigin | undefined;
    if (!origin) throw new Error("This skill did not come from a registry");
    const index = await this.browse(origin.registry);
    const entry = index.skills.find((s) => s.id === origin.skillId);
    if (!entry) throw new Error(`The registry "${index.name}" no longer lists this skill`);
    if (entry.signed === "invalid") throw new Error(invalidWords(index.key, "nothing was changed"));
    const document = await this.fetchDocument(entry);
    const before = this.store.skills.view(this.owner, skillId);
    const previousSkillVersion = before.activeVersion ?? before.headVersion;
    const updated = this.store.skills.update(this.owner, skillId, { document, expectedRevision: before.revision });
    const view = before.activeVersion === null ? updated : this.store.skills.activate(this.owner, skillId, { expectedRevision: updated.revision, version: updated.headVersion, acknowledge: true });
    this.store.save("settings", this.owner, `skill-origin:${skillId}`, { ...origin, sha256: entry.sha256, version: entry.version ?? null, signed: entry.signed, previousSkillVersion });
    return { ...view, origin: { ...origin, version: entry.version ?? null, previousSkillVersion }, changelog: entry.changelog ?? "" };
  }
  /** Puts an updated skill back to the version that was in use before the update. */
  rollback(skillId: string) {
    const origin = this.store.get("settings", this.owner, `skill-origin:${skillId}`)?.data as unknown as SkillOrigin | undefined;
    if (!origin?.previousSkillVersion) throw new Error("There is no earlier version of this skill to go back to");
    const view = this.store.skills.view(this.owner, skillId);
    const restored = this.store.skills.activate(this.owner, skillId, { expectedRevision: view.revision, version: origin.previousSkillVersion, acknowledge: true });
    this.store.save("settings", this.owner, `skill-origin:${skillId}`, { ...origin, previousSkillVersion: null });
    return restored;
  }
}
