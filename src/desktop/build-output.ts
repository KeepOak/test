import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { removeTree } from "./remove-tree.js";
import { fetchAttestationBundles } from "./provenance.js";
import { verifyOutputBundle } from "./build-output-proof.js";

/**
 * A Beta change's build output, made once by GitHub (`.github/workflows/beta-output.yml`, on every push to Beta's line)
 * instead of on the owner's computer: the compiled `dist/` and the fonts the build copies into `public/fonts/`. It is
 * the same output `npm run build` writes here, published beside the change as `branch-build-<commit>.bbo.gz` on the
 * `beta-builds` prerelease, with a build-provenance record (build-output-proof.ts).
 *
 * A Beta update fetches the change's source as always (git, for the history and for what changed), then takes this
 * output in place of compiling, once it has checked it in full. When it is not there yet it waits a little (GitHub
 * builds it in about two minutes); when it does not come, or does not check out, the change is compiled here as before.
 *
 * The file is a gzip of plain records, one per file: the name's length (4 bytes), the name, the size (8 bytes), the
 * bytes. Only names under `dist/` and `public/fonts/`, relative and plain, are accepted.
 */
export const outputTag = "beta-builds";
export const outputName = (commit: string): string => `branch-build-${commit}.bbo.gz`;
export const outputUrl = (repo: string, commit: string): string => `https://github.com/${repo}/releases/download/${outputTag}/${outputName(commit)}`;
/** Where the output's files go, and nowhere else. */
export const outputFolders = ["dist", "public/fonts"] as const;
const maxBytes = 512 << 20, maxFiles = 50_000;

export interface OutputFile { name: string; body: Buffer }

/** A name the output may hold: under one of `outputFolders`, forward slashes, no empty, `.` or `..` part. */
export function plainOutputName(name: string): boolean {
  if (!outputFolders.some((folder) => name.startsWith(`${folder}/`)) || name.length > 400) return false;
  if (/[\0\\:*?"<>|]/.test(name) || name === "dist/build-info.json") return false;
  return name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function packOutput(files: OutputFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!plainOutputName(file.name)) throw new Error(`${file.name} cannot be in a build output`);
    const name = Buffer.from(file.name, "utf8"), head = Buffer.alloc(12);
    head.writeUInt32BE(name.length, 0);
    head.writeBigUInt64BE(BigInt(file.body.length), 4);
    parts.push(head.subarray(0, 4), name, head.subarray(4), file.body);
  }
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

export function unpackOutput(gz: Buffer): OutputFile[] {
  const data = gunzipSync(gz, { maxOutputLength: maxBytes });
  const files: OutputFile[] = [], seen = new Set<string>();
  for (let at = 0; at < data.length;) {
    if (files.length >= maxFiles || at + 4 > data.length) throw new Error("the build output is not whole");
    const nameLength = data.readUInt32BE(at); at += 4;
    if (nameLength > 400 || at + nameLength + 8 > data.length) throw new Error("the build output is not whole");
    const name = data.subarray(at, at + nameLength).toString("utf8"); at += nameLength;
    const size = Number(data.readBigUInt64BE(at)); at += 8;
    if (!plainOutputName(name) || seen.has(name.toLowerCase())) throw new Error(`the build output holds a name it may not: ${name.slice(0, 80)}`);
    if (at + size > data.length) throw new Error("the build output is not whole");
    seen.add(name.toLowerCase());
    files.push({ name, body: Buffer.from(data.subarray(at, at + size)) });
    at += size;
  }
  if (!files.some((file) => file.name === "dist/cli.js")) throw new Error("the build output has no compiled app in it");
  return files;
}

/** The output of a build in `root` (a checkout that has just run `npm run build`). */
export async function collectOutput(root: string): Promise<OutputFile[]> {
  const files: OutputFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${relative(root, path)} is a link, which a build output never holds`);
      if (entry.isDirectory()) await walk(path);
      else {
        const name = relative(root, path).split(sep).join("/");
        if (name !== "dist/build-info.json") files.push({ name, body: await readFile(path) });
      }
    }
  };
  for (const folder of outputFolders) await walk(join(root, ...folder.split("/")));
  return files;
}

/** Replaces `root`'s dist/ and public/fonts/ with the output's files; tsc's build info goes too (it no longer matches). */
export async function placeOutput(root: string, files: OutputFile[]): Promise<void> {
  const base = resolve(root);
  for (const folder of outputFolders) await removeTree(join(base, ...folder.split("/")));
  await rm(join(base, ".build-cache"), { recursive: true, force: true });
  for (const file of files) {
    const target = resolve(base, ...file.name.split("/"));
    if (!target.startsWith(base + sep)) throw new Error("the build output points outside the build folder");
    await mkdir(dirname(target), { recursive: true });
    const found = await lstat(target).catch(() => null);
    if (found) throw new Error("the build output names one file twice");
    await writeFile(target, file.body);
  }
}

export interface FetchOutputInput {
  repo: string; commit: string; source: string;
  fetch?: typeof fetch;
  /** How long to wait for GitHub to finish building it (default 6 minutes: about what compiling here takes). */
  waitMs?: number; pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  /** Tests: Fulcio's certificates of their own. */
  chain?: Parameters<typeof verifyOutputBundle>[2];
}

async function readCapped(response: Response): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("the build output is larger than any build");
  return Buffer.from(await response.arrayBuffer());
}

/** Where GitHub's build of `commit` stands: its beta-output run for that push, as GitHub's public list of runs says. */
export async function outputRun(fetchImpl: typeof fetch, repo: string, commit: string, agent: string): Promise<"building" | "queued" | "failed" | "done" | "none" | "unknown"> {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs?head_sha=${commit}&event=push&per_page=20`,
      { headers: { accept: "application/vnd.github+json", "user-agent": agent }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return "unknown";
    const runs = ((await response.json()) as { workflow_runs?: { path?: string; status?: string; conclusion?: string | null }[] }).workflow_runs ?? [];
    const run = runs.find((one) => one.path === ".github/workflows/beta-output.yml");
    if (!run) return "none";
    if (run.status === "completed") return run.conclusion === "success" ? "done" : "failed";
    return run.status === "in_progress" ? "building" : "queued";
  } catch { return "unknown"; }
}

/**
 * Takes GitHub's build output for `commit` into `source`, once it is there and checks out in full. Answers why not when
 * it did not (then the caller compiles the change itself); never throws for a missing or refused output.
 */
export async function useBuiltOutput(input: FetchOutputInput): Promise<{ used: true; digest: string; ms: number } | { used: false; why: string }> {
  const fetchImpl = input.fetch ?? globalThis.fetch, now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = now(), deadline = started + (input.waitMs ?? 6 * 60_000), agent = "BranchAgent-beta-update";
  if (!/^[0-9a-f]{40}$/.test(input.commit)) return { used: false, why: "the change has no id" };
  let body: Buffer | null = null, lastLook = Number.NEGATIVE_INFINITY;
  for (;;) {
    try {
      const response = await fetchImpl(outputUrl(input.repo, input.commit), { headers: { "user-agent": agent }, signal: AbortSignal.timeout(120_000) });
      if (response.ok) { body = await readCapped(response); break; }
      if (response.status !== 404) return { used: false, why: `GitHub answered ${response.status} for the build output` };
    } catch (error) { return { used: false, why: `the build output could not be downloaded (${(error as Error).message})` }; }
    if (now() + (input.pollMs ?? 15_000) > deadline) return { used: false, why: "GitHub's build of this change did not arrive in time" };
    // Waiting is only worth it while GitHub is building it: one that has not started (GitHub's queue is long) or has
    // failed is not waited for. Asked at most once a minute (GitHub allows 60 such questions an hour without sign-in).
    if (now() - lastLook >= 60_000) {
      lastLook = now();
      const run = await outputRun(fetchImpl, input.repo, input.commit, agent);
      input.log?.(`GitHub's build of this change: ${run}`);
      if (run === "queued") return { used: false, why: "GitHub's build of this change has not started yet (its queue is busy)" };
      if (run === "failed") return { used: false, why: "GitHub's build of this change did not finish" };
      if (run === "none" && now() - started > 90_000) return { used: false, why: "GitHub is not building this change" };
    }
    await sleep(input.pollMs ?? 15_000);
  }
  const digest = createHash("sha256").update(body).digest("hex");
  let lookup;
  try { lookup = await fetchAttestationBundles({ fetch: fetchImpl, repo: input.repo, digestHex: digest, userAgent: agent }); }
  catch (error) { return { used: false, why: (error as Error).message }; }
  const refusals: string[] = [];
  for (const bundle of lookup?.bundles ?? []) {
    try { verifyOutputBundle(bundle, { digestHex: digest, commit: input.commit }, input.chain); }
    catch (error) { refusals.push((error as Error).message); continue; }
    try { await placeOutput(input.source, unpackOutput(body)); }
    catch (error) { return { used: false, why: (error as Error).message }; }
    return { used: true, digest, ms: now() - started };
  }
  return { used: false, why: refusals[0] ?? "GitHub has no build-provenance record for the build output" };
}
