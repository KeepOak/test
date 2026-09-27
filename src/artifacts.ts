import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { readdirSync, rmSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Files a task produced that are too big to travel inside a tool result: a screenshot, a saved
 * page. They live beside the private database, never in the person's workspace, so nothing a tool
 * wrote can collide with their own files. The tool result carries the path, the size and a
 * checksum, and the ordinary tool receipt signs that.
 */
export interface Artifact {
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
}
/**
 * One kept file as the gallery lists it. There is no checksum here on purpose: listing never opens
 * a file, so a folder full of pictures costs a folder listing and nothing more.
 */
export interface Kept {
  runId: string;
  name: string;
  path: string;
  bytes: number;
  mediaType: string;
  createdAt: string;
}
const artifactKinds: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".pdf": "application/pdf", ".wav": "audio/wav", ".mp3": "audio/mpeg",
  ".txt": "text/plain", ".json": "application/json", ".html": "text/html",
};
const mediaTypeOf = (name: string): string => artifactKinds[extname(name).toLowerCase()] ?? "application/octet-stream";
/** The longest name a stored file, or its folder, may have. */
export const maxArtifactName = 64;
const safeName = new RegExp(`^[a-z0-9][a-z0-9._-]{0,${maxArtifactName - 1}}$`, "i");
/** Eight megabytes: room for a full-page screenshot, small enough to keep the folder tidy. */
export const maxArtifactBytes = 8 * 1024 * 1024;
/** A file refused for its size before it was kept, so the person who sent it can be told the limit. */
export class ArtifactTooLarge extends Error {}

export class RunArtifacts {
  constructor(readonly root: string) {}
  async write(runId: string, name: string, mediaType: string, bytes: Buffer): Promise<Artifact> {
    if (!safeName.test(runId) || !safeName.test(name))
      throw new Error("Artifact names use letters, digits, dots, dashes and underscores");
    if (bytes.byteLength > maxArtifactBytes) throw new Error("That file is larger than 8 MB, so it was not kept");
    const folder = join(this.root, runId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, name);
    await writeFile(path, bytes, { mode: 0o600 });
    return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType };
  }
  /**
   * A tool result that is a picture, or null. Only the shape `RunArtifacts.write` returns counts,
   * so nothing a website says can talk the runtime into reading a file of its choosing.
   */
  static imageIn(value: unknown): Artifact | null {
    const outcome = value as { ok?: boolean; result?: Record<string, unknown> } | null;
    const result = outcome?.ok ? outcome.result : undefined;
    if (!result || typeof result.path !== "string" || typeof result.sha256 !== "string") return null;
    if (typeof result.mediaType !== "string" || !result.mediaType.startsWith("image/")) return null;
    if (typeof result.bytes !== "number") return null;
    return { path: result.path, sha256: result.sha256, mediaType: result.mediaType, bytes: result.bytes };
  }
  /**
   * Everything kept so far, newest first, for the "made by the assistant" list. Only the facts a
   * folder listing already gives: no file is opened, so a long list stays cheap.
   */
  async list(limit = 60): Promise<Kept[]> {
    const found: Kept[] = [];
    let runs: string[];
    try {
      runs = await readdir(this.root);
    } catch {
      return [];
    }
    for (const runId of runs.slice(0, 400)) {
      let names: string[];
      try {
        names = await readdir(join(this.root, runId));
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(this.root, runId, name);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) continue;
        found.push({ runId, name, path, bytes: info.size, mediaType: mediaTypeOf(name), createdAt: info.mtime.toISOString() });
      }
    }
    return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  /** The files these tasks kept, by name and size, for the question before a conversation is deleted for good. */
  held(runIds: readonly string[]): { name: string; bytes: number }[] {
    return runIds.filter((runId) => safeName.test(runId)).flatMap((runId) => {
      let names: string[];
      try { names = readdirSync(join(this.root, runId)); } catch { return []; } // a task that kept no file has no folder
      return names.map((name) => ({ name, bytes: statSync(join(this.root, runId, name)).size }));
    });
  }
  /** Removes the files these tasks kept; they live only here, beside the database. */
  forget(runIds: readonly string[]): void {
    for (const runId of runIds) if (safeName.test(runId)) rmSync(join(this.root, runId), { recursive: true, force: true });
  }
  /** Reads one back for the model layer; any path outside the artifacts folder is refused. */
  async read(path: string): Promise<Buffer> {
    const target = resolve(path), rel = relative(resolve(this.root), target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("That file is not a run artifact");
    return readFile(target);
  }
}
