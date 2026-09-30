import { readFileSync } from "node:fs";
import { checkedInUse, type InUse } from "./live-folder.js";
import { loadWindowFiles, sha256 } from "./manifest.js";

/**
 * Live updates (hot-update): the window's files the engine serves, when a live build's are in use. Held in memory,
 * exactly the bytes checked against the build's record (manifest.ts), so the window is never served a file the engine
 * did not check, and swapped whole, so a window never gets half of one build and half of another.
 */
interface LiveWindow { commit: string; files: Map<string, Buffer>; at: string }
let current: LiveWindow | null = null;
const listeners = new Set<(commit: string | null) => void>();

/** The live build's copy of a window file (named as under public/), or null: the engine's own is served. */
export function liveWindowFile(name: string): Buffer | null {
  return current?.files.get(name) ?? null;
}
/** Every window file of the live build in use, or null when none is. */
export function liveWindowNames(): string[] | null {
  return current ? [...current.files.keys()] : null;
}
/** The change the window's files come from, when a live build's are served; null: the engine's own. */
export function liveWindowCommit(): string | null { return current?.commit ?? null; }
export function onWindowChanged(listener: (commit: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Checks a live build (its record against the hash kept for it, every file against its record), loads its window files
 * and serves them from now on. Answers the stylesheets and other files that differ from what was served before, so the
 * open window knows whether swapping its stylesheet is enough. Throws, and changes nothing, when anything does not check.
 */
export async function useLiveWindow(appRoot: string, inUse: InUse, served: (name: string) => Promise<Buffer | null>): Promise<{ changed: string[]; ms: number }> {
  const started = Date.now();
  const checked = await checkedInUse(appRoot, inUse);
  if (!checked) throw new Error("There is no live build to serve.");
  const files = await loadWindowFiles(checked.dir, checked.manifest);
  if (!files.size) throw new Error("The live build holds no window files, so nothing was changed.");
  const changed: string[] = [];
  for (const [name, body] of files) {
    const before = current?.files.get(name) ?? await served(name);
    if (!before || sha256(before) !== sha256(body)) changed.push(name);
  }
  current = { commit: inUse.commit, files, at: new Date().toISOString() };
  for (const listener of listeners) listener(inUse.commit);
  return { changed, ms: Date.now() - started };
}

/** Back to the engine's own window files (a rollback, or tests). */
export function dropLiveWindow(): void {
  current = null;
  for (const listener of listeners) listener(null);
}

let own: string | null | undefined;
/** The change this engine's own code was built from (dist/build-info.json), or null when not recorded. */
export function ownBuild(): string | null {
  if (own !== undefined) return own;
  try {
    const commit = JSON.parse(readFileSync(new URL("../build-info.json", import.meta.url), "utf8"))?.commit;
    own = typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch { own = null; }
  return own;
}

/** History stamped by the trusted builder, never supplied by a task or inferred from a version. */
export function ownBuildHistory(): string[] {
  try {
    const info = JSON.parse(readFileSync(new URL("../build-info.json", import.meta.url), "utf8"));
    if (!ownBuild() || info.commit !== ownBuild() || !Array.isArray(info.ancestors) || info.ancestors.length > 2000) return [];
    return info.ancestors.filter((sha: unknown): sha is string => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha));
  } catch { return []; }
}
