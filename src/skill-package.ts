import { createHash } from "node:crypto";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { parseSkillDocument } from "./skill-document.js";
import { hookEvents } from "./hooks.js";
import { ParametersSchema } from "./recipes.js";
import { SiteSkillFileSchema, siteSkillEntry } from "./integrations/browser-sites.js";

/**
 * A skill package is one file the owner can hand to someone else. Inside it is the folder they
 * wrote: SKILL.md, an optional tools.json describing web addresses the skill may call, and an
 * optional hooks.json linking an event to one of their recipes. The package also carries a
 * manifest naming the author, the version, the fingerprint of every file, and what the package
 * asks to be allowed to do, so nothing is installed before the owner has seen the list.
 */
export const packageEntryName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Package file names are plain names such as SKILL.md");
export const manifestEntry = "branch-package.json";
export const maxPackageBytes = 512 * 1024;
const maxEntries = 16, maxEntryBytes = 128 * 1024;

const headerName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,39}$/, "Header names look like X-Api-Key");
/** One declarative web call. Header values may name a locker secret as {{secret:NAME}}; the value never leaves the locker. */
export const HttpToolSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
  description: z.string().trim().min(1).max(300),
  method: z.enum(["GET", "POST"]).default("GET"),
  url: z.string().max(500).regex(/^https?:\/\/[^\s{}]+(?:\{\{[a-z][a-z0-9_]*\}\}[^\s{}]*)*$/, "Addresses start with http:// or https:// and may contain {{input}} placeholders"),
  headers: z.record(headerName, z.string().max(300)).default({}),
  body: z.record(z.string().max(64), z.string().max(500)).default({}),
  input: ParametersSchema.default({}),
  /** Dotted paths kept from the answer; everything else is dropped before the assistant sees it. */
  pick: z.array(z.string().max(120).regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/)).max(20).default([]),
}).strict();
export type HttpTool = z.infer<typeof HttpToolSchema>;
export const SkillToolsSchema = z.object({ tools: z.array(HttpToolSchema).min(1).max(10) }).strict();
export const SkillHooksSchema = z.object({
  hooks: z.array(z.object({
    event: z.enum(hookEvents),
    /** The name of one of the owner's verified recipes; a package never carries the recipe itself. */
    recipe: z.string().regex(/^[A-Za-z][A-Za-z0-9 _-]{0,63}$/),
  }).strict()).min(1).max(10),
}).strict();

export const SkillPackageManifestSchema = z.object({
  format: z.literal("branch-skill-package"),
  version: z.literal(1),
  name: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "Package versions look like 1.0.0"),
  author: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(""),
  permissions: z.array(z.string().max(64)).max(20),
  files: z.record(packageEntryName, z.string().regex(/^[a-f0-9]{64}$/)),
  createdAt: z.string().max(40),
}).strict();
export type SkillPackageManifest = z.infer<typeof SkillPackageManifestSchema>;
export interface SkillPackageContents { manifest: SkillPackageManifest; files: Record<string, string> }
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The packer and reader accept the same declarative text layout. */
function checkSkillFile(name: string): void {
  packageEntryName.parse(name);
  if (!["SKILL.md", "tools.json", "hooks.json", siteSkillEntry].includes(name) && !name.endsWith(".md"))
    throw new Error(`A skill package holds instructions, declared tools/hooks/site rules and .md notes; ${name} is not one of them`);
}

/** What a package asks to be allowed to do, in the owner's words, worked out from what is inside it. */
export function requestedPermissions(files: Record<string, string>): { permission: string; why: string }[] {
  const asked = [{ permission: "skills.read", why: "Let the assistant read these instructions when a task needs them" }];
  const toolsFile = files["tools.json"], hooksFile = files["hooks.json"];
  if (toolsFile) {
    const { tools } = SkillToolsSchema.parse(JSON.parse(toolsFile));
    const hosts = [...new Set(tools.map((tool) => new URL(tool.url.replace(/\{\{[a-z0-9_]*\}\}/g, "x")).host))];
    asked.push({ permission: "skills.http", why: `Call ${tools.length} web address${tools.length === 1 ? "" : "es"} at ${hosts.join(", ")}` });
  }
  // A site block asks for nothing extra — it is selectors and nothing else — but the owner should
  // still read which websites a skill claims to know before they install it.
  const siteFile = files[siteSkillEntry];
  if (siteFile) {
    const { site } = SiteSkillFileSchema.parse(JSON.parse(siteFile));
    // What it presses is named, not only which websites it knows: a selector that dismisses a
    // cookie notice and one that confirms a deletion read the same until the owner sees it.
    const presses = site.dismiss.length ? `presses ${site.dismiss.join(", ")} when a page opens` : "presses nothing";
    asked.push({ permission: "skills.read",
      why: `Know the quirks of ${site.hosts.join(", ")}: ${presses}. Selectors only, and no website is added to the allowed list.` });
  }
  if (hooksFile) {
    const { hooks } = SkillHooksSchema.parse(JSON.parse(hooksFile));
    asked.push({ permission: "procedures.use", why: hooks.map((hook) => `Run your recipe "${hook.recipe}" when ${hook.event.replace(/[._]/g, " ")}`).join("; ") });
  }
  return asked;
}

/** The websites a package knows the quirks of, so the owner sees them before saying yes. */
export function declaredSites(files: Record<string, string>): string[] {
  const siteFile = files[siteSkillEntry];
  return siteFile ? [...SiteSkillFileSchema.parse(JSON.parse(siteFile)).site.hosts] : [];
}

/** The web addresses a package's declared calls name, so the owner sees every one before saying yes. */
export function declaredHosts(files: Record<string, string>): string[] {
  const toolsFile = files["tools.json"];
  if (!toolsFile) return [];
  const { tools } = SkillToolsSchema.parse(JSON.parse(toolsFile));
  return [...new Set(tools.map((tool) => new URL(tool.url.replace(/\{\{[a-z0-9_]*\}\}/g, "x")).hostname))];
}

/** Builds the package bytes from a folder's files. Everything is checked here, not at install time only. */
export function packSkill(input: { files: Record<string, string>; author: string; packageVersion: string; description?: string; createdAt?: string }): Buffer {
  const files = { ...input.files };
  const document = files["SKILL.md"];
  if (!document) throw new Error("A skill package needs a SKILL.md file");
  const metadata = parseSkillDocument(document);
  for (const name of Object.keys(files)) {
    checkSkillFile(name);
    if (name === manifestEntry) throw new Error(`${manifestEntry} is written by the packer; remove it from the folder`);
  }
  // A site block is checked here rather than at install time, so a skill that names a website
  // Branch never opens, or that tries to smuggle script into a selector, cannot be packed at all.
  if (files[siteSkillEntry]) SiteSkillFileSchema.parse(JSON.parse(files[siteSkillEntry]));
  const permissions = [...new Set(requestedPermissions(files).map((entry) => entry.permission))];
  const manifest = SkillPackageManifestSchema.parse({
    format: "branch-skill-package", version: 1, name: metadata.name, packageVersion: input.packageVersion,
    author: input.author, description: (input.description ?? metadata.description).slice(0, 500), permissions,
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)])),
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  const bytes = zipWrite([[manifestEntry, JSON.stringify(manifest, null, 2)], ...Object.entries(files)]);
  if (bytes.length > maxPackageBytes) throw new Error("The package is larger than allowed");
  return bytes;
}

/** Opens a package and refuses it unless every file still matches the fingerprint in its manifest. */
export function readSkillPackage(bytes: Buffer): SkillPackageContents {
  if (bytes.length > maxPackageBytes) throw new Error("The package is larger than allowed");
  const entries = zipRead(bytes, { ...defaultZipLimits, strictText: true });
  const manifestText = entries.get(manifestEntry);
  if (!manifestText) throw new Error(`This file is not a skill package (no ${manifestEntry} inside)`);
  const manifest = SkillPackageManifestSchema.parse(JSON.parse(manifestText));
  const files: Record<string, string> = {};
  for (const [name, text] of entries) {
    if (name === manifestEntry) continue;
    checkSkillFile(name);
    const expected = manifest.files[name];
    if (!expected) throw new Error(`${name} is in the package but not in its manifest, so the package was not installed`);
    if (sha256(text) !== expected) throw new Error(`${name} does not match the fingerprint in the package manifest, so the package was not installed`);
    files[name] = text;
  }
  for (const name of Object.keys(manifest.files)) if (!(name in files)) throw new Error(`${name} is listed in the manifest but missing from the package`);
  const metadata = parseSkillDocument(files["SKILL.md"] ?? "");
  if (metadata.name !== manifest.name) throw new Error("The manifest name and the SKILL.md name do not agree");
  return { manifest, files };
}

type ZipEntry = [name: string, text: string];
/** Writes a small zip; also used to make the one file a plugin can be handed over as. */
export function zipWrite(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const label = Buffer.from(name, "utf8"), data = Buffer.from(text, "utf8"), body = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(label.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(data), 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(label.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(local, label, body); central.push(dir, label);
    offset += local.length + label.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** How much a zip read here may hold; a skill package is small, an exported agent is larger. */
export interface ZipLimits { entries: number; entryBytes: number; totalBytes: number; strictText?: boolean }
export const defaultZipLimits: ZipLimits = { entries: maxEntries, entryBytes: maxEntryBytes, totalBytes: maxPackageBytes };

/** Inflates one entry, stopping as soon as it grows past the size its directory declared. */
function inflateBounded(raw: Buffer, size: number): Buffer {
  try { return inflateRawSync(raw, { maxOutputLength: size + 1 }); }
  catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new Error("The package holds more data than allowed");
    throw error;
  }
}
const plainEntry = (name: string): boolean => { packageEntryName.parse(name); return true; };
/**
 * Reads a small zip; also used to open a plugin someone handed over as one file. `accept` checks
 * each name and may skip one by answering false (bucket 12 reads Agent Skills folders with it).
 */
export function zipRead(bytes: Buffer, limits: ZipLimits = defaultZipLimits, accept: (name: string) => boolean = plainEntry): Map<string, string> {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("This file is not a skill package");
  const count = bytes.readUInt16LE(end + 10);
  if (count > limits.entries) throw new Error("The package holds more files than allowed");
  const files = new Map<string, string>();
  let position = bytes.readUInt32LE(end + 16), total = 0;
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(position) !== 0x02014b50) throw new Error("The package directory is damaged");
    const method = bytes.readUInt16LE(position + 10), stored = bytes.readUInt32LE(position + 20), size = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28), extra = bytes.readUInt16LE(position + 30), comment = bytes.readUInt16LE(position + 32);
    const name = bytes.toString("utf8", position + 46, position + 46 + nameLength);
    const local = bytes.readUInt32LE(position + 42);
    if (size > limits.entryBytes || (total += size) > limits.totalBytes) throw new Error("The package holds more data than allowed");
    if (!accept(name)) { position += 46 + nameLength + extra + comment; continue; }
    // A symbolic link is never read as text (Unix mode in the high half of the external attributes).
    if ((bytes.readUInt32LE(position + 38) >>> 16 & 0o170000) === 0o120000) throw new Error(`${name} is a link, so the file was not opened`);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + stored);
    const data = method === 8 ? inflateBounded(raw, size) : method === 0 ? raw : null;
    if (!data || data.length !== size) throw new Error(`${name} could not be unpacked`);
    const text = data.toString("utf8");
    if (limits.strictText && (files.has(name) || text.includes("\0") || !Buffer.from(text, "utf8").equals(data)))
      throw new Error(`${name} is repeated or is not plain UTF-8 text, so the file was not opened`);
    files.set(name, text);
    position += 46 + nameLength + extra + comment;
  }
  return files;
}
