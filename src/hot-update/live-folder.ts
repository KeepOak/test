import { cp, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { removeTree } from "../desktop/remove-tree.js";
import { copyFile } from "node:fs/promises";
import { liveFiles, liveFolders, verifyLive, writeManifest, type LiveManifest } from "./manifest.js";

/**
 * Live updates (hot-update): where a live build is kept, and which one is in use.
 *
 * A live build is the compiled engine (dist/) and the window's files (public/) of one change, in a folder named by that
 * change inside the program's own folder: `<app>/live/<commit>/`. Inside the installed program, because that is where
 * the packages it imports are found (`<app>/node_modules`, the same ones: a change to them is a shell update), and
 * because the assistant may never change the installed program (src/never-break/protected.ts). A folder a running
 * process loaded from is never written to again; every build gets a new one, and only the one in use and the one
 * before it are kept.
 *
 * `live/current.json` says which build the engine and the window use, with each build's record's hash, so that
 * whatever is in use is checked against exactly the record written when it was built (manifest.ts).
 */
export const liveFolderName = "live";
export const currentName = "current.json";
const commitShape = /^[0-9a-f]{40}$/;

const InUseSchema = z.object({
  commit: z.string().regex(commitShape),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.string().max(80),
  /** When it went into use. */
  at: z.iso.datetime(),
}).strict();
export type InUse = z.infer<typeof InUseSchema>;
export const LiveStateSchema = z.object({
  /** The build the engine runs from; null: the packaged one. */
  engine: InUseSchema.nullable(),
  /** The build the window is served from; null: the packaged one. */
  window: InUseSchema.nullable(),
  /** The one before, kept for going back. */
  previous: z.object({ engine: InUseSchema.nullable(), window: InUseSchema.nullable() }).strict().nullable(),
}).strict();
export type LiveState = z.infer<typeof LiveStateSchema>;
export const emptyLiveState = (): LiveState => ({ engine: null, window: null, previous: null });

export const liveRoot = (appRoot: string): string => join(appRoot, liveFolderName);
export const liveBuildDir = (appRoot: string, commit: string): string => {
  if (!commitShape.test(commit)) throw new Error("A live build is named by its change's id.");
  return join(liveRoot(appRoot), commit);
};

export async function readLiveState(appRoot: string): Promise<LiveState> {
  try { return LiveStateSchema.parse(JSON.parse(await readFile(join(liveRoot(appRoot), currentName), "utf8"))); }
  catch { return emptyLiveState(); }
}
export async function writeLiveState(appRoot: string, state: LiveState): Promise<void> {
  const path = join(liveRoot(appRoot), currentName), part = `${path}.part`;
  await mkdir(liveRoot(appRoot), { recursive: true });
  await writeFile(part, `${JSON.stringify(LiveStateSchema.parse(state), null, 2)}\n`, { mode: 0o600 });
  await rename(part, path);
}

/** What travels in a live build: the compiled modules and the files they read, never type files or source maps. */
const kept = (name: string): boolean => !/\.(d\.c?ts|map)$/.test(name);

/**
 * Copies one change's build (`source`: a checkout that has just been built) into its own live folder, writes which
 * change it is into it (dist/build-info.json, as packaging does) and records every file. Written beside and renamed
 * into place, so a cut-off copy is never taken for a build. Answers what `current.json` keeps for it.
 */
export async function stageLive(input: { source: string; appRoot: string; commit: string; version: string; now?: Date; withEngine?: boolean; ancestors?: string[] }): Promise<{ dir: string; manifest: LiveManifest; digest: string }> {
  const dir = liveBuildDir(input.appRoot, input.commit), part = `${dir}.part`;
  // A window-only build holds the window's files alone: the engine that serves them keeps its own code.
  const withEngine = input.withEngine !== false;
  await removeTree(part);
  await mkdir(part, { recursive: true });
  for (const name of withEngine ? liveFiles : []) await copyFile(join(input.source, name), join(part, name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" || name === "package.json") throw error;
  });
  for (const top of liveFolders.filter((folder) => withEngine || folder === "public")) {
    const from = join(input.source, top);
    const found = await lstat(from).catch(() => null);
    if (!found?.isDirectory() || found.isSymbolicLink()) throw new Error(`The build has no ${top} folder, so nothing was changed.`);
    await cp(from, join(part, top), { recursive: true, verbatimSymlinks: true, filter: (path) => kept(path) });
  }
  if (withEngine) await writeFile(join(part, "dist", "build-info.json"), `${JSON.stringify({ commit: input.commit,
    ancestors: (input.ancestors ?? []).filter(sha => commitShape.test(sha)).slice(0, 2000), builtAt: (input.now ?? new Date()).toISOString() })}\n`);
  const { manifest, digest } = await writeManifest(part, input.commit, input.version, input.now);
  await removeTree(dir);
  await rename(part, dir);
  return { dir, manifest, digest };
}

/** A build in use, checked against its record now; null when none is in use or it does not check out (then the packaged one is used). */
export async function checkedInUse(appRoot: string, inUse: InUse | null): Promise<{ dir: string; manifest: LiveManifest } | null> {
  if (!inUse) return null;
  const dir = liveBuildDir(appRoot, inUse.commit);
  return { dir, manifest: await verifyLive(dir, { commit: inUse.commit, digest: inUse.digest }) };
}

/** Removes live builds that are neither in use nor the one before (and anything half-copied). */
export async function pruneLive(appRoot: string, state: LiveState): Promise<void> {
  const keep = new Set([state.engine, state.window, state.previous?.engine, state.previous?.window].filter(Boolean).map((one) => one!.commit));
  for (const entry of await readdir(liveRoot(appRoot), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const commit = entry.name.replace(/\.part$/, "");
    if (commitShape.test(commit) && (entry.name.endsWith(".part") || !keep.has(commit))) await removeTree(join(liveRoot(appRoot), entry.name));
  }
}
