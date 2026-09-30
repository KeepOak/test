import { createHash } from "node:crypto";
import { z } from "zod";
import { checkpointBranch, chunkBytes, sha256, type CheckpointConfig } from "./github-checkpoint-contract.js";
import { EnvelopeSchema, type Envelope } from "./github-checkpoint-archive.js";

const SHA = z.string().regex(/^[a-f0-9]{40}$/);
const ObjectSchema = z.object({ sha: SHA });
const RefSchema = z.object({ object: z.object({ type: z.literal("commit"), sha: SHA }) });
const CommitSchema = z.object({ sha: SHA, tree: ObjectSchema });
const TreeSchema = z.object({ truncated: z.boolean().optional(), tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: SHA })).max(50) });
const RepoSchema = z.object({ id: z.number().int().positive(), private: z.boolean(), archived: z.boolean(), disabled: z.boolean(), default_branch: z.string(), permissions: z.object({ push: z.boolean() }) });
const gitBlob = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
type TreeEntry = { path: string; mode: string; type: string; sha: string };

export class CheckpointRemote {
  private readonly deadline = Date.now() + 180000;
  private requests = 0;
  private readonly root: string;
  constructor(readonly repository: string, private readonly token: string, private readonly fetcher: typeof fetch, private readonly authorize: () => void | Promise<void>) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split("/").some((part) => [".", ".."].includes(part))) throw new Error("Invalid checkpoint repository.");
    if (["keepoak/branch-agent", "stabrea/branch-agent"].includes(repository.toLowerCase())) throw new Error("Choose a dedicated private checkpoint repository.");
    if (!token || /[\r\n]/.test(token)) throw new Error("The exact configured GitHub secret is unavailable; update held.");
    this.root = `https://api.github.com/repos/${repository}`;
  }

  private async call(path: string, method = "GET", body?: unknown, missing = false): Promise<unknown> {
    await this.authorize(); const remaining = this.deadline - Date.now();
    if (++this.requests > 256) throw new Error("Checkpoint request budget exceeded; update held.");
    if (remaining <= 0) throw new Error("Checkpoint exceeded its three-minute network budget; update held.");
    const signal = AbortSignal.timeout(Math.min(20000, remaining));
    const response = await this.fetcher(`${this.root}${path}`, { method, redirect: "error", signal,
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (missing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub checkpoint request failed (HTTP ${response.status}); update held.`); }
    const reader = response.body?.getReader(); if (!reader) throw new Error("GitHub returned no checkpoint response.");
    const parts: Buffer[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length; if (size > 6 * 1024 * 1024) throw new Error("GitHub checkpoint response exceeded its bound.");
        parts.push(Buffer.from(part.value));
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  }

  async repositoryIdentity(expected?: number): Promise<number> {
    const repo = RepoSchema.parse(await this.call(""));
    if (!repo.private || repo.archived || repo.disabled || !repo.permissions.push || repo.default_branch === checkpointBranch || (expected !== undefined && repo.id !== expected))
      throw new Error("The pinned checkpoint repository must remain private, writable, dedicated and separate from its default branch.");
    await this.call(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`); // owner initializes the repository, not this updater
    return repo.id;
  }

  private async ref(): Promise<string | null> {
    const value = await this.call(`/git/ref/heads/${checkpointBranch}`, "GET", undefined, true);
    return value === null ? null : RefSchema.parse(value).object.sha;
  }

  private async tree(commit: string): Promise<TreeEntry[]> {
    const result = CommitSchema.parse(await this.call(`/git/commits/${SHA.parse(commit)}`));
    if (result.sha !== commit) throw new Error("GitHub commit identity mismatch.");
    const tree = TreeSchema.parse(await this.call(`/git/trees/${result.tree.sha}?recursive=1`));
    if (tree.truncated || tree.tree.some((entry) => entry.type !== "blob" && !(entry.path === "chunks" && entry.type === "tree"))) throw new Error("Unsupported checkpoint tree.");
    return tree.tree.filter((entry) => entry.type === "blob");
  }

  private async blob(sha: string, max: number): Promise<Buffer> {
    const value = z.object({ sha: SHA, encoding: z.literal("base64"), content: z.string().max(6 * 1024 * 1024), size: z.number().int().nonnegative() }).parse(await this.call(`/git/blobs/${SHA.parse(sha)}`));
    const bytes = Buffer.from(value.content.replace(/\n/g, ""), "base64");
    if (value.sha !== sha || bytes.length !== value.size || bytes.length > max || gitBlob(bytes) !== sha) throw new Error("GitHub checkpoint blob failed verification.");
    return bytes;
  }

  private async putBlob(bytes: Buffer): Promise<string> {
    const result = ObjectSchema.parse(await this.call("/git/blobs", "POST", { content: bytes.toString("base64"), encoding: "base64" }));
    if (result.sha !== gitBlob(bytes)) throw new Error("GitHub created a different checkpoint blob.");
    const saved = await this.blob(result.sha, Math.max(chunkBytes, bytes.length));
    if (sha256(saved) !== sha256(bytes)) throw new Error("GitHub checkpoint readback mismatch.");
    return result.sha;
  }

  async validateExisting(config: CheckpointConfig): Promise<void> {
    const head = await this.ref(); if (!head) return;
    const entries = await this.tree(head), manifest = entries.find((entry) => entry.path === "envelope.json");
    if (!manifest) throw new Error("The checkpoint branch already contains unrelated files; choose a dedicated repository.");
    const envelope = EnvelopeSchema.parse(JSON.parse((await this.blob(manifest.sha, 24000)).toString("utf8")));
    const names = ["envelope.json", ...envelope.chunks.map((chunk) => chunk.path)];
    if (envelope.repositoryID !== config.repositoryID || envelope.fingerprint !== config.fingerprint || new Set(names).size !== names.length
      || entries.length !== names.length || entries.some((entry) => entry.mode !== "100644" || !names.includes(entry.path)))
      throw new Error("The existing checkpoint branch does not match this repository, recovery key and encrypted-only scope.");
  }

  async download(config: CheckpointConfig, commit?: string): Promise<{ commit: string; envelope: Envelope; encrypted: Buffer }> {
    await this.repositoryIdentity(config.repositoryID);
    const head = commit ? SHA.parse(commit) : await this.ref(); if (!head) throw new Error("There is no remote checkpoint yet.");
    const entries = await this.tree(head), manifest = entries.find((entry) => entry.path === "envelope.json");
    if (!manifest) throw new Error("The checkpoint branch contains unrelated files; update held.");
    const envelope = EnvelopeSchema.parse(JSON.parse((await this.blob(manifest.sha, 24000)).toString("utf8")));
    if (envelope.repositoryID !== config.repositoryID || envelope.fingerprint !== config.fingerprint) throw new Error("Remote checkpoint recipient or repository changed.");
    const names = ["envelope.json", ...envelope.chunks.map((chunk) => chunk.path)];
    if (new Set(names).size !== names.length || entries.length !== names.length || entries.some((entry) => entry.mode !== "100644" || !names.includes(entry.path))) throw new Error("Checkpoint tree contains unapproved paths.");
    const chunks: Buffer[] = [];
    for (const chunk of envelope.chunks) {
      const entry = entries.find((item) => item.path === chunk.path); if (!entry) throw new Error("Checkpoint chunk missing.");
      const bytes = await this.blob(entry.sha, chunkBytes);
      if (bytes.length !== chunk.bytes || sha256(bytes) !== chunk.digest) throw new Error("Checkpoint chunk digest mismatch.");
      chunks.push(bytes);
    }
    const encrypted = Buffer.concat(chunks); if (sha256(encrypted) !== envelope.digest) throw new Error("Checkpoint ciphertext digest mismatch.");
    await this.repositoryIdentity(config.repositoryID);
    return { commit: head, envelope, encrypted };
  }

  async upload(config: CheckpointConfig, value: { envelope: Envelope; chunks: Buffer[] }): Promise<{ commit: string; repositoryID: number }> {
    await this.repositoryIdentity(config.repositoryID);
    const previous = await this.ref(); if (previous) await this.download(config, previous); // never repurpose another branch
    const tree: TreeEntry[] = [];
    for (const [n, bytes] of value.chunks.entries()) tree.push({ path: value.envelope.chunks[n]!.path, mode: "100644", type: "blob", sha: await this.putBlob(bytes) });
    tree.push({ path: "envelope.json", mode: "100644", type: "blob", sha: await this.putBlob(Buffer.from(JSON.stringify(value.envelope))) });
    const createdTree = ObjectSchema.parse(await this.call("/git/trees", "POST", { tree }));
    const commit = ObjectSchema.parse(await this.call("/git/commits", "POST", { message: "Encrypted Branch update checkpoint [skip ci]", tree: createdTree.sha,
      parents: previous ? [previous] : [], author: { name: "Branch checkpoint", email: "checkpoint@users.noreply.github.com" } }));
    await this.repositoryIdentity(config.repositoryID);
    if (await this.ref() !== previous) throw new Error("The checkpoint branch changed concurrently; update held.");
    if (previous) await this.call(`/git/refs/heads/${checkpointBranch}`, "PATCH", { sha: commit.sha, force: false });
    else await this.call("/git/refs", "POST", { ref: `refs/heads/${checkpointBranch}`, sha: commit.sha });
    if (await this.ref() !== commit.sha) throw new Error("GitHub checkpoint branch did not retain the saved commit.");
    const verified = await this.download(config, commit.sha);
    if (verified.envelope.digest !== value.envelope.digest) throw new Error("GitHub finalized checkpoint mismatch.");
    return { commit: commit.sha, repositoryID: config.repositoryID };
  }
}
