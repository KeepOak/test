import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { z } from "zod";
import { gb } from "./local-hardware.js";
import type { LaunchEnv, RuntimeId } from "./local-launch.js";

/**
 * Wave mac5 (local models): where model files go, whether they fit on the disk, and downloading
 * one file so that a stopped download — or a Branch restart — carries on from where it was.
 *
 * The resume follows GPT4All's download (MIT): the unfinished file is kept beside the real one and
 * reopened for appending, with `Range: bytes=N-` asking only for the rest. Each finished file is
 * checked against the SHA-256 its library published before it is put in place.
 */

/**
 * The folder each runtime keeps its models in.
 *
 * mac7/clean-uninstall: when Branch fetched the program itself (`ownRunner`), its models go inside
 * Branch too, so removing Branch takes the gigabytes with it. A program the person installed
 * themselves keeps its own library where they already have it — moving it would be the same
 * scattering, in reverse.
 */
export function modelsFolder(runtime: RuntimeId, at: LaunchEnv, dataDir: string, ownRunner = false): string {
  const join = at.platform === "win32" ? win32.join : posix.join;
  if (ownRunner && (runtime === "ollama" || runtime === "lm-studio")) return join(dataDir, "models", runtime);
  switch (runtime) {
    case "ollama": return at.env.OLLAMA_MODELS?.trim() || join(at.home, ".ollama", "models");
    case "lm-studio": return join(at.home, ".lmstudio", "models");
    case "llama-cpp": return join(dataDir, "local-models", "gguf");
    case "mlx": return join(dataDir, "local-models", "mlx");
    case "vllm": return join(dataDir, "local-models", "vllm"); // No vLLM models are downloaded or deleted here.
  }
}

export type StatFs = (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
const realStatFs: StatFs = (path) => statfs(path);

/** Free bytes on the disk that holds `folder`, asking the nearest folder that already exists. */
export async function freeDiskBytes(folder: string, platform: string, stats: StatFs = realStatFs): Promise<number> {
  const path = platform === "win32" ? win32 : posix;
  let at = folder;
  for (let hops = 0; hops < 64; hops++) {
    try {
      const found = await stats(at);
      return Number(found.bavail) * Number(found.bsize);
    } catch {
      const up = path.dirname(at);
      if (up === at) break;
      at = up;
    }
  }
  throw new Error(`Branch could not tell how much space is free for ${folder}`);
}

/** Refuses before anything is downloaded when the disk cannot take it, keeping a 2 GB margin. */
export async function assertRoomOnDisk(folder: string, bytes: number, platform: string, stats?: StatFs, alreadyHave = 0): Promise<{ freeBytes: number }> {
  const freeBytes = await freeDiskBytes(folder, platform, stats);
  const still = Math.max(0, bytes - alreadyHave);
  const margin = 2 * 1024 ** 3;
  if (still + margin > freeBytes)
    throw new Error(`Not enough disk space: this needs about ${gb(still)} GB more and ${gb(freeBytes)} GB is free (Branch keeps 2 GB spare). Free some space and try again.`);
  return { freeBytes };
}

export interface FileProgress { completed: number; total: number }
export interface FileDownload {
  url: string;
  target: string;
  bytes: number;
  /** Hex SHA-256; when absent only the size is checked. */
  sha256?: string | undefined;
  fetch: typeof globalThis.fetch;
  onProgress?: (progress: FileProgress) => void;
  signal?: AbortSignal;
}

const allowedHosts = /(^|\.)(huggingface\.co|hf\.co|xethub\.hf\.co)$/i;
/** Follows a library's redirects to its file store one hop at a time, each hop checked again. */
async function openRanged(job: FileDownload, from: number): Promise<Response> {
  let url = new URL(job.url);
  for (let hop = 0; hop < 6; hop++) {
    if (url.protocol !== "https:" || !allowedHosts.test(url.hostname))
      throw new Error(`A model download may only come from Hugging Face, not ${url.hostname}`);
    const response = await job.fetch(url.href, {
      redirect: "manual", headers: from > 0 ? { range: `bytes=${from}-` } : {}, ...(job.signal ? { signal: job.signal } : {}),
    });
    const next = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && next) {
      await response.body?.cancel().catch(() => undefined);
      url = new URL(next, url);
      continue;
    }
    return response;
  }
  throw new Error("The model library sent Branch round too many redirects");
}

/** Downloads one file, resuming a `.partial` left from before. Returns the finished path. */
export async function downloadFile(job: FileDownload): Promise<string> {
  const partial = `${job.target}.partial`;
  await mkdir((job.target.includes("\\") ? win32 : posix).dirname(job.target), { recursive: true });
  await refuseLinks(job.target, partial);
  if (await finishedAlready(job)) return job.target;
  let have = (await stat(partial).catch(() => null))?.size ?? 0;
  if (have > job.bytes) { await rm(partial, { force: true }); have = 0; }
  if (have < job.bytes) {
    const response = await openRanged(job, have);
    if (response.status === 416 && have > 0) { await rm(partial, { force: true }); throw new Error("The saved part did not match; start the download again"); }
    if (!response.ok || !response.body) throw new Error(`The model library answered ${response.status}`);
    if (response.status !== 206) have = 0;
    else if (rangeStart(response) !== have) {
      await response.body.cancel().catch(() => undefined);
      await rm(partial, { force: true });
      throw new Error("The saved part did not match what the library sent; start the download again");
    }
    await writeStream(response.body, partial, have, job);
  }
  const size = (await stat(partial)).size;
  if (size !== job.bytes) throw new Error(`The download stopped early (${gb(size)} of ${gb(job.bytes)} GB). Start it again to carry on.`);
  if (job.sha256 && (await sha256Of(partial)) !== job.sha256.toLowerCase()) {
    await rm(partial, { force: true });
    throw new Error("The downloaded file did not match what the library published, so it was thrown away. Try again.");
  }
  await rename(partial, job.target);
  return job.target;
}

/**
 * Integration review: a file (or a link) someone placed where the model goes is never trusted or
 * written through. A link is refused; a file of the right size is only used once its hash matches.
 */
async function refuseLinks(...paths: string[]): Promise<void> {
  for (const path of paths)
    if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw new Error("A link sits where the model file goes, so Branch will not write there");
}
async function finishedAlready(job: FileDownload): Promise<boolean> {
  const done = await stat(job.target).catch(() => null);
  if (done?.size !== job.bytes) return false;
  if (!job.sha256 || (await sha256Of(job.target)) === job.sha256.toLowerCase()) return true;
  await rm(job.target, { force: true });
  return false;
}
/** The first byte a 206 answer covers (`Content-Range: bytes 50-199/200`), or -1. */
function rangeStart(response: Response): number {
  const match = /^bytes (\d+)-/i.exec(response.headers.get("content-range") ?? "");
  return match ? Number(match[1]) : -1;
}

async function writeStream(body: ReadableStream<Uint8Array>, path: string, start: number, job: FileDownload): Promise<void> {
  const out = createWriteStream(path, { flags: start > 0 ? "a" : "w" });
  let completed = start;
  let last = 0;
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      completed += chunk.byteLength;
      if (completed - last >= 8 * 1024 ** 2 || completed === job.bytes) { last = completed; job.onProgress?.({ completed, total: job.bytes }); }
      if (completed > job.bytes) throw new Error("The model library sent more than it said it would");
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
}

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/* ---------- what a Hugging Face repository holds ---------- */

const treeSchema = z.array(z.object({
  type: z.string(), path: z.string().max(300), size: z.number().nonnegative().optional(),
  lfs: z.object({ oid: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().nonnegative() }).loose().optional(),
}).loose()).max(2000);
export interface RepoFile { path: string; bytes: number; sha256?: string | undefined }
export const hfRepoName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/, "That is not a Hugging Face repository name");
const safeFile = /^(?!.*\.\.)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/;

/** The files at the top of a repository (and one folder down), with sizes and hashes. */
export async function repoFiles(repo: string, call: typeof globalThis.fetch): Promise<RepoFile[]> {
  const name = hfRepoName.parse(repo);
  const response = await call(`https://huggingface.co/api/models/${name}/tree/main`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Hugging Face answered ${response.status} for ${name}`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error("Hugging Face returned too much data");
  return treeSchema.parse(JSON.parse(text) as unknown)
    .filter((entry) => entry.type === "file" && safeFile.test(entry.path))
    .map((entry) => ({ path: entry.path, bytes: entry.lfs?.size ?? entry.size ?? 0, sha256: entry.lfs?.oid }));
}

/** The address of one file in a repository. */
export function resolveUrl(repo: string, file: string): string {
  if (!safeFile.test(file)) throw new Error("That is not a file name Branch will download");
  return `https://huggingface.co/${hfRepoName.parse(repo)}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
}

/** An MLX model is a folder: the weights and the small files that describe them. */
export function mlxFilesWanted(files: RepoFile[]): RepoFile[] {
  return files.filter((file) => /\.(safetensors|json|model|tiktoken|txt|jinja)$/i.test(file.path) && !file.path.includes("/"));
}
