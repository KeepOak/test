import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";

/**
 * Live updates (hot-update): every file of a live build is written down with its SHA-256 right after it was built from
 * the exact change on Beta's line, and checked against that record before the engine loads it or the window is served
 * it. A file that differs, is missing, is extra, or is a link stops the update; nothing half-checked is ever used.
 */
export const manifestName = "live-manifest.json";
const commitShape = /^[0-9a-f]{40}$/;
/**
 * What a live build holds: what the packaged app holds of Branch's own (scripts/package-desktop.mjs includedInApp), less
 * the packages, which a live build shares with the installed program.
 */
export const liveFolders = ["dist", "public"] as const;
export const liveFiles = ["package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"] as const;
const inFolder = /^(dist|public)\/[A-Za-z0-9_.@+-]+(\/[A-Za-z0-9_.@+-]+)*$/;
const livePath = (name: string): boolean =>
  (inFolder.test(name) && name.split("/").every((part) => part !== "." && part !== "..")) || (liveFiles as readonly string[]).includes(name);

export const LiveManifestSchema = z.object({
  commit: z.string().regex(commitShape),
  /** The version the live build answers to (its package.json's, stamped as a Beta build's). */
  version: z.string().max(80),
  builtAt: z.iso.datetime(),
  files: z.record(z.string().refine(livePath, "not a file a live build holds"), z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative() })),
}).strict();
export type LiveManifest = z.infer<typeof LiveManifestSchema>;

export const sha256 = (body: Buffer | string): string => createHash("sha256").update(body).digest("hex");

/** Every plain file under `root`, as forward-slash names; a link anywhere refuses the whole folder. */
async function listPlain(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`The live build holds a link (${relative(root, path).split(sep).join("/")}), so it was not used.`);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) out.push(relative(root, path).split(sep).join("/"));
      else throw new Error("The live build holds something that is not a file, so it was not used.");
    }
  };
  for (const name of liveFiles) {
    const found = await lstat(join(root, name)).catch(() => null);
    if (!found) continue;
    if (!found.isFile() || found.isSymbolicLink()) throw new Error(`The live build's ${name} is not a plain file, so it was not used.`);
    out.push(name);
  }
  for (const top of liveFolders) {
    const found = await lstat(join(root, top)).catch(() => null);
    if (!found) continue;
    if (!found.isDirectory() || found.isSymbolicLink()) throw new Error(`The live build's ${top} is not a plain folder, so it was not used.`);
    await walk(join(root, top));
  }
  return out.sort();
}

/** Writes the record of a finished live build (whole or not at all) and answers it with the record's own hash. */
export async function writeManifest(root: string, commit: string, version: string, now = new Date()): Promise<{ manifest: LiveManifest; digest: string }> {
  const files: LiveManifest["files"] = {};
  for (const name of await listPlain(root)) {
    const body = await readFile(join(root, name));
    files[name] = { sha256: sha256(body), size: body.length };
  }
  const manifest = LiveManifestSchema.parse({ commit, version, builtAt: now.toISOString(), files });
  const text = `${JSON.stringify(manifest)}\n`;
  const path = join(root, manifestName), part = `${path}.part`;
  await writeFile(part, text, { mode: 0o600 });
  await rename(part, path);
  return { manifest, digest: sha256(text) };
}

/**
 * Checks a live build against its record, and the record against the hash kept for it when it was built (`digest`).
 * Answers the record; throws a plain sentence on the first thing that does not match.
 */
export async function verifyLive(root: string, expect: { commit: string; digest: string }): Promise<LiveManifest> {
  const text = await readFile(join(root, manifestName), "utf8").catch(() => null);
  if (text === null) throw new Error("The live build has no record of its files, so it was not used.");
  if (sha256(text) !== expect.digest) throw new Error("The live build's record of its files was changed after it was built, so it was not used.");
  const manifest = LiveManifestSchema.parse(JSON.parse(text));
  if (manifest.commit !== expect.commit) throw new Error("The live build is of another change than the one checked, so it was not used.");
  const found = await listPlain(root);
  const listed = Object.keys(manifest.files).sort();
  if (found.length !== listed.length || found.some((name, index) => name !== listed[index]))
    throw new Error("The live build has files its record does not list, or misses some it does, so it was not used.");
  for (const name of found) {
    const body = await readFile(join(root, name));
    const want = manifest.files[name]!;
    if (body.length !== want.size || sha256(body) !== want.sha256) throw new Error(`The live build's ${name} is not the file that was built, so it was not used.`);
  }
  return manifest;
}

/**
 * The window's files of a checked live build, held in memory: the engine serves only these bytes, each checked again
 * against the record as it is read, so a file changed on disk after the check is never what the window gets.
 */
export async function loadWindowFiles(root: string, manifest: LiveManifest): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const [name, want] of Object.entries(manifest.files)) {
    if (!name.startsWith("public/")) continue;
    const body = await readFile(join(root, name));
    if (body.length !== want.size || sha256(body) !== want.sha256) throw new Error(`The live build's ${name} is not the file that was built, so it was not used.`);
    out.set(name.slice("public/".length), body);
  }
  return out;
}
