import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile, mkdir, rename, rm, lstat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import { PluginManifestSchema, pluginId } from "./plugins.js";
import { zipRead } from "./skill-package.js";

/**
 * Where plugins come from on this computer, and nowhere else. There is no shop to browse: the owner
 * points at a folder or at one file somebody handed them, is shown the manifest — what it is called,
 * what it says it does, what it asks to be allowed to do, and the fingerprint of the code — and only
 * then is it copied in. The fingerprint is kept, so a plugin file that changes afterwards is noticed.
 * Installing never switches anything on; that is still a separate, deliberate step by the owner.
 */
export const manifestName = "branch-plugin.json";
export const maxPluginBytes = 512 * 1024;
export const PluginCatalogEntrySchema = z.object({
  id: pluginId,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  version: z.string().trim().max(40).default("1"),
  permissions: z.array(z.string().max(100)).max(20).default([]),
  /** The fingerprint of the plugin's code as it was when the owner agreed to it. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.string().max(1000).default(""),
  installedAt: z.string().max(40).default(""),
}).strict();
export type PluginCatalogEntry = z.infer<typeof PluginCatalogEntrySchema>;
export interface PluginOffer {
  manifest: Omit<PluginCatalogEntry, "sha256" | "source" | "installedAt">;
  sha256: string; source: string; bytes: number;
  /** What the manifest said the fingerprint would be, when it said so at all. */
  declared: string | null;
  matchesDeclared: boolean;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const pluginSourceHash = (manifest: PluginOffer["manifest"], code: string): string =>
  sha256(JSON.stringify([manifest.id, manifest.name, manifest.description, manifest.version, manifest.permissions, code]));

/** Reads a plugin from a folder or from one zip file, without running a line of its code. */
export async function readPluginOffer(source: string): Promise<{ offer: PluginOffer; code: string }> {
  if (!isAbsolute(source)) throw new Error("Point at the folder or file in full, starting from the drive.");
  const info = await stat(source).catch(() => null);
  if (!info) throw new Error("There is nothing at that address.");
  const files = info.isDirectory() ? await readFolder(source) : await readZip(source);
  const manifestText = files.get(manifestName);
  if (!manifestText) throw new Error(`That is not a plugin: there is no ${manifestName} in it.`);
  const raw = JSON.parse(manifestText) as Record<string, unknown>;
  // The manifest may carry more than the plugin loader cares about (a version, a fingerprint), so
  // only the parts that decide what the plugin is are checked against the loader's own shape.
  const manifest = PluginManifestSchema.parse({ id: raw.id, name: raw.name,
    description: raw.description ?? "", permissions: raw.permissions ?? [] });
  const code = files.get(`${manifest.id}.mjs`);
  if (!code) throw new Error(`The manifest calls this plugin "${manifest.id}", but there is no ${manifest.id}.mjs beside it.`);
  const fingerprint = sha256(code);
  const declared = typeof raw.sha256 === "string" ? raw.sha256.toLowerCase() : null;
  return {
    code,
    offer: {
      manifest: { ...manifest, version: String(raw.version ?? "1").slice(0, 40) },
      sha256: fingerprint, source, bytes: Buffer.byteLength(code, "utf8"),
      declared, matchesDeclared: declared === null || declared === fingerprint,
    },
  };
}
async function readFolder(folder: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of (await readdir(folder)).slice(0, 16)) {
    if (name !== manifestName && !name.endsWith(".mjs")) continue;
    const info = await stat(join(folder, name));
    if (!info.isFile() || info.size > maxPluginBytes) continue;
    files.set(name, await readFile(join(folder, name), "utf8"));
  }
  return files;
}
async function readZip(file: string): Promise<Map<string, string>> {
  const bytes = await readFile(file);
  if (bytes.length > maxPluginBytes) throw new Error("That file is larger than a plugin may be.");
  return zipRead(bytes);
}

export class PluginCatalog {
  constructor(private readonly store: Store, private readonly owner: string, private readonly folder: string) {}
  private key(id: string): string { return `plugin-catalog:${id}`; }
  /** What the owner is being asked to accept. Nothing is copied and nothing is run. */
  inspect(source: string): Promise<PluginOffer> {
    return readPluginOffer(source).then((read) => read.offer);
  }
  /**
   * Copies the plugin in and writes down its fingerprint. It arrives switched off: the owner still
   * has to turn it on, which is the step that actually runs its code.
   */
  async install(source: string, options: { expectSha256?: string; expectSourceHash?: string } = {}): Promise<PluginCatalogEntry> {
    const { offer, code } = await readPluginOffer(source);
    if (this.store.get("settings", this.owner, this.key(offer.manifest.id)) ||
      await lstat(join(this.folder, `${offer.manifest.id}.mjs`)).then(() => true, () => false))
      throw new Error("An installed plugin must be evaluated and promoted before replacement.");
    if (!offer.matchesDeclared)
      throw new Error("The code does not match the fingerprint in the manifest, so it was not installed.");
    if (options.expectSha256 && options.expectSha256 !== offer.sha256)
      throw new Error("The code is not the one you were shown, so it was not installed.");
    if (options.expectSourceHash && options.expectSourceHash !== pluginSourceHash(offer.manifest, code))
      throw new Error("The manifest or code changed after evaluation, so it was not installed.");
    this.store.save("settings", this.owner, `plugin-review:${offer.manifest.id}`, { pending: true });
    await mkdir(this.folder, { recursive: true });
    await writeFile(join(this.folder, `${offer.manifest.id}.mjs`), code, { encoding: "utf8", flag: "wx" });
    const entry = PluginCatalogEntrySchema.parse({ ...offer.manifest, sha256: offer.sha256, source,
      installedAt: new Date().toISOString() });
    this.store.save("settings", this.owner, this.key(entry.id), { ...entry });
    this.snapshot(entry, code);
    return entry;
  }
  /** Immutable, content-pinned rollback material, including the original manifest. */
  private snapshot(entry: PluginCatalogEntry, code: string): void {
    const versionSha256 = pluginSourceHash(entry, code), key = `plugin-version:${entry.id}:${versionSha256}`;
    if (!this.store.get("settings", this.owner, key)) this.store.save("settings", this.owner, key, { entry, code, versionSha256 });
  }
  private async write(id: string, code: string): Promise<void> {
    const staging = join(this.folder, `.${id}-${randomUUID()}.tmp`);
    try {
      await writeFile(staging, code, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(staging, join(this.folder, `${id}.mjs`));
    } finally { await rm(staging, { force: true }); }
  }
  private async commit(entry: PluginCatalogEntry, code: string, previous: { entry: PluginCatalogEntry; code: string }): Promise<void> {
    try {
      await this.write(entry.id, code);
      this.store.save("settings", this.owner, this.key(entry.id), { ...entry });
      this.snapshot(entry, code);
    } catch (error) {
      await this.write(previous.entry.id, previous.code);
      this.store.save("settings", this.owner, this.key(previous.entry.id), { ...previous.entry });
      throw error;
    }
  }
  async current(id: string): Promise<{ entry: PluginCatalogEntry; code: string }> {
    pluginId.parse(id);
    const code = await readFile(join(this.folder, `${id}.mjs`), "utf8");
    let raw = this.store.get("settings", this.owner, this.key(id))?.data;
    if (!raw) {
      const sidecar = await readFile(join(this.folder, `${id}.plugin.json`), "utf8").catch(() => null);
      const saved = this.store.get("settings", this.owner, `plugin:${id}`)?.data as { summary?: { name?: string; description?: string; permissions?: string[] } } | undefined;
      const declared = sidecar ? JSON.parse(sidecar) : saved?.summary;
      raw = { id, name: declared?.name ?? id, description: declared?.description ?? "", permissions: declared?.permissions ?? [],
        version: declared?.version ?? "1", sha256: declared?.sha256 ?? sha256(code), source: this.folder, installedAt: "" };
    }
    const entry = PluginCatalogEntrySchema.parse(raw);
    if (sha256(code) !== entry.sha256) throw new Error("Installed plugin source changed; evaluation evidence is stale.");
    return { entry, code };
  }
  async versions(id: string): Promise<(PluginCatalogEntry & { versionSha256: string })[]> {
    pluginId.parse(id);
    return this.store.list("settings", this.owner).filter(row => row.id.startsWith(`plugin-version:${id}:`))
      .map(row => ({ ...PluginCatalogEntrySchema.parse((row.data as { entry: unknown }).entry), versionSha256: String(row.data.versionSha256) }));
  }
  /** Called by the lifecycle only after evidence checks; leaves activation to an owner action. */
  async replace(source: string, expectedCurrent: string, expectedCandidate: string,
    sourceHashes?: { current: string; candidate: string }): Promise<PluginCatalogEntry> {
    const current = await this.current((await this.inspect(source)).manifest.id);
    const { offer, code } = await readPluginOffer(source);
    if (!offer.matchesDeclared || offer.manifest.id !== current.entry.id || current.entry.sha256 !== expectedCurrent || offer.sha256 !== expectedCandidate)
      throw new Error("Plugin fingerprints changed; evaluate again before promotion.");
    if (sourceHashes && (pluginSourceHash(current.entry, current.code) !== sourceHashes.current || pluginSourceHash(offer.manifest, code) !== sourceHashes.candidate))
      throw new Error("Plugin manifest changed; evaluate again before promotion.");
    this.snapshot(current.entry, current.code);
    const entry = PluginCatalogEntrySchema.parse({ ...offer.manifest, sha256: offer.sha256, source, installedAt: new Date().toISOString() });
    await this.commit(entry, code, current);
    return entry;
  }
  async restore(id: string, hash: string, expectedCurrent: string): Promise<PluginCatalogEntry> {
    const current = await this.current(id);
    if (pluginSourceHash(current.entry, current.code) !== expectedCurrent) throw new Error("Installed plugin changed before restore.");
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Restore needs a complete SHA-256 fingerprint.");
    const saved = this.store.get("settings", this.owner, `plugin-version:${id}:${hash}`)?.data as { entry: unknown; code: string } | undefined;
    if (!saved) throw new Error("No intact plugin version has that fingerprint.");
    const entry = PluginCatalogEntrySchema.parse(saved.entry);
    if (entry.id !== id || entry.sha256 !== sha256(saved.code) || pluginSourceHash(entry, saved.code) !== hash)
      throw new Error("The saved plugin manifest does not match its fingerprint.");
    this.snapshot(current.entry, current.code);
    await this.commit(entry, saved.code, current);
    return entry;
  }
  /** Everything installed from a folder or a file, and whether the code is still what it was. */
  async list(): Promise<(PluginCatalogEntry & { unchanged: boolean })[]> {
    const rows = this.store.list("settings", this.owner).filter((row) => row.id.startsWith("plugin-catalog:"))
      .map((row) => row.data as unknown as PluginCatalogEntry);
    const out: (PluginCatalogEntry & { unchanged: boolean })[] = [];
    for (const entry of rows) {
      const code = await readFile(join(this.folder, `${entry.id}.mjs`), "utf8").catch(() => null);
      out.push({ ...entry, unchanged: code !== null && sha256(code) === entry.sha256 });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
  forget(id: string): { removed: boolean } {
    return { removed: this.store.delete("settings", this.owner, this.key(id)) };
  }
}
