import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { NetworkPolicy } from "./network-policy.js";
import { pinnedFetch } from "./pinned-fetch.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { agentSkillLimits, readAgentSkill } from "./agent-skills.js";
import { zipWrite } from "./skill-package.js";

// Tree-first pinning and regular-blob selection adapted from Hermes Agent skills_hub_github.py
// a9a54245b2311c705d29050b7f9868c015917aec, Nous Research, MIT (THIRD_PARTY_NOTICES.md).
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const GitHubSkillRequest = z.object({
  owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
  path: z.string().max(500).default(""), treeSha: sha.optional(),
}).strict();
const Tree = z.object({ sha, truncated: z.boolean(), tree: z.array(z.object({ path: z.string().max(1000),
  mode: z.string().max(10), type: z.enum(["blob", "tree", "commit"]), sha,
  size: z.number().int().min(0).optional() })).max(15000) });
export interface GitHubSkillHost { store: Store; runtime: { owner: string }; web: { policy: NetworkPolicy };
  sessionLock: { state(): { locked: boolean } } }
export interface GitHubSkillOrigin { owner: string; repo: string; path: string; treeSha: string; url: string; digest: string }
interface Quarantine { owner: string; at: number; bytes: Buffer; origin: GitHubSkillOrigin }
const quarantines = new WeakMap<Store, Map<string, Quarantine>>();
const ttl = 15 * 60_000;

export function requireGitHubSkillOwner(app: GitHubSkillHost): void {
  app.store.profiles.requireOwner("Importing a skill from GitHub");
  if (startedWithShortLivedKey()) throw new Error("Import GitHub skills in the owner's app window.");
  if (app.sessionLock.state().locked) throw new Error("Unlock Branch before importing a GitHub skill.");
}
function safePath(path: string): boolean {
  return path === "" || path.split("/").every((part) => /^[A-Za-z0-9_.][A-Za-z0-9._ -]{0,99}$/.test(part) && part !== "." && part !== "..");
}
function cache(app: GitHubSkillHost): Map<string, Quarantine> {
  let entries = quarantines.get(app.store);
  if (!entries) { entries = new Map(); quarantines.set(app.store, entries); }
  for (const [id, entry] of entries) if (entry.at + ttl <= Date.now()) { entry.bytes.fill(0); entries.delete(id); }
  return entries;
}

/** In-memory quarantine only; no file or skill is installed, unpacked to disk, or trusted by repository name. */
export function quarantineGitHubSkill(app: GitHubSkillHost, bytes: Buffer, origin: GitHubSkillOrigin): string {
  requireGitHubSkillOwner(app);
  const entries = cache(app);
  if (entries.size >= 8) { const oldest = entries.keys().next().value!; entries.get(oldest)!.bytes.fill(0); entries.delete(oldest); }
  const ticket = randomUUID();
  entries.set(ticket, { owner: app.runtime.owner, at: Date.now(), bytes: Buffer.from(bytes), origin });
  return ticket;
}
/** A one-use approved preview: bytes are the same server-held snapshot, not a client-provided archive or provenance. */
export function takeGitHubSkill(app: GitHubSkillHost, ticket: string): Quarantine {
  requireGitHubSkillOwner(app);
  const entries = cache(app), entry = entries.get(ticket);
  if (!entry || entry.owner !== app.runtime.owner) throw new Error("This GitHub skill preview expired. Inspect it again.");
  entries.delete(ticket);
  if (createHash("sha256").update(entry.bytes).digest("hex") !== entry.origin.digest)
    throw new Error("The quarantined skill changed. Inspect it again.");
  return entry;
}

export async function fetchGitHubSkill(app: GitHubSkillHost, input: unknown) {
  requireGitHubSkillOwner(app);
  const source = GitHubSkillRequest.parse(input);
  if (!safePath(source.path)) throw new Error("Use a plain relative skill folder path without dot segments.");
  const signal = AbortSignal.timeout(90_000), base = `https://api.github.com/repos/${source.owner}/${source.repo}`;
  const read = async (path: string, cap: number, raw = false) => githubRead(app, base + path, cap, raw, signal);
  let ref = source.treeSha;
  if (!ref) {
    const repo = z.object({ default_branch: z.string().min(1).max(200) }).safeParse(JSON.parse((await read("", 131072)).toString("utf8")));
    if (!repo.success) throw new Error("GitHub sent an unsupported repository reply.");
    ref = repo.data.default_branch;
  }
  const parsed = Tree.safeParse(JSON.parse((await read(`/git/trees/${encodeURIComponent(ref)}?recursive=1`, 2 * 1024 * 1024)).toString("utf8")));
  if (!parsed.success || parsed.data.truncated) throw new Error("The GitHub tree is incomplete or too large for one skill import.");
  if (source.treeSha && parsed.data.sha !== source.treeSha) throw new Error("GitHub returned a different tree revision.");
  const { selected, leftOut } = selectFiles(parsed.data.tree, source.path);
  const entries = await readFiles(app, selected, read);
  const archive = zipWrite(entries), folder = readAgentSkill(archive);
  requireGitHubSkillOwner(app);
  return { folder, leftOut, origin: { owner: source.owner, repo: source.repo, path: source.path, treeSha: parsed.data.sha,
    url: `https://github.com/${source.owner}/${source.repo}/tree/${parsed.data.sha}${source.path ? "/" + source.path.split("/").map(encodeURIComponent).join("/") : ""}` } };
}

type SelectedFile = { path: string; sha: string; size: number };
function selectFiles(tree: z.infer<typeof Tree>["tree"], path: string) {
  const prefix = path ? `${path}/` : "", selected: SelectedFile[] = [], leftOut: string[] = [], names = new Set<string>();
  for (const entry of tree) {
    if (!entry.path.startsWith(prefix) || entry.type === "tree") continue;
    const relative = entry.path.slice(prefix.length);
    if (!relative || !safePath(relative) || names.has(relative)) throw new Error("The skill tree contains an unsafe or duplicate file name.");
    names.add(relative);
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new Error("The skill tree contains a symlink or submodule; it was not imported.");
    if (relative !== "SKILL.md" && !/^references\/[^/]+\.(md|markdown|txt)$/i.test(relative)) {
      if (leftOut.length < 64) leftOut.push(relative);
      continue;
    }
    if (entry.size === undefined || entry.size > agentSkillLimits.entryBytes || selected.length >= 13)
      throw new Error("This skill exceeds the text file or reference limits.");
    selected.push({ path: relative, sha: entry.sha, size: entry.size });
  }
  if (!selected.some((file) => file.path === "SKILL.md")) throw new Error("That exact folder has no SKILL.md.");
  return { selected, leftOut };
}
async function readFiles(app: GitHubSkillHost, selected: SelectedFile[], read: (path: string, cap: number, raw?: boolean) => Promise<Buffer>) {
  const entries: [string, string][] = [];
  let total = 0;
  for (const file of selected.sort((a, b) => a.path.localeCompare(b.path))) {
    const bytes = await read(`/git/blobs/${file.sha}`, agentSkillLimits.entryBytes, true);
    requireGitHubSkillOwner(app);
    const fingerprint = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (bytes.length !== file.size || fingerprint !== file.sha) throw new Error("A GitHub file did not match the pinned tree.");
    total += bytes.length;
    if (total > agentSkillLimits.totalBytes) throw new Error("The skill is too large.");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("Only UTF-8 text skill files can be imported.");
    entries.push([file.path, text]);
  }
  return entries;
}

async function githubRead(app: GitHubSkillHost, address: string, cap: number, raw: boolean, signal: AbortSignal): Promise<Buffer> {
  requireGitHubSkillOwner(app);
  // Guarded sender rechecks the principal after the policy's DNS await; no environment/CLI/auth tokens are used.
  const send = app.web.policy.guard((input, init) => { requireGitHubSkillOwner(app); return pinnedFetch(input, init); });
  const response = await send(address, { redirect: "error", headers: { accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
    "x-github-api-version": "2022-11-28" }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  requireGitHubSkillOwner(app);
  if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub could not read this public skill (${response.status}). No retry or install was made.`); }
  if (!response.body) throw new Error("GitHub sent an empty reply.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      requireGitHubSkillOwner(app);
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw new Error("The GitHub reply is too large.");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
