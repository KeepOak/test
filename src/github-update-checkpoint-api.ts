import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { createBranch } from "./index.js";
import { currentPerson } from "./people/context.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { currentTaskRun } from "./task-scope.js";
import { fromThisComputer } from "./listen-address.js";
import { lockdownActive } from "./lockdown.js";
import { HttpError } from "./server-http.js";
import { ProposalSchema, checkpointBranch, publicRecipient, readCheckpointConfig, saveCheckpointConfig, type CheckpointConfig } from "./install/github-checkpoint-contract.js";
import { encryptDataCopy, recoverDataCopy } from "./install/github-checkpoint-archive.js";
import { CheckpointRemote } from "./install/github-checkpoint-remote.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;
type Preview = { config: CheckpointConfig; expires: number };
type RecoveryPreview = Preview & { privateKeyFile: string; commit: string; digest: string };
const previews = new WeakMap<Branch, Map<string, Preview>>();
const recoveries = new WeakMap<Branch, Map<string, RecoveryPreview>>();
const busy = new Set<string>();
const confirmation = "Encrypt the finalized update data copy, including saved conversations and device-bound keys, to this dedicated private repository before each update. I retain the matching recovery private key outside Branch.";
const recoveryConfirmation = "Read this exact local private-key file and decrypt this exact checkpoint commit into a local restore point only. Do not replace current saved work.";

function ownerHere(app: Branch, request: IncomingMessage): void {
  if (request.socket.destroyed) throw new HttpError(409, "Checkpoint caller disconnected; operation held.");
  if (!fromThisComputer(request.socket?.remoteAddress, request.headers) || startedWithShortLivedKey() || currentTaskRun() || currentPerson() || app.store.profiles.active())
    throw new HttpError(403, "Only the owner in this computer's app can authorize a GitHub update checkpoint.");
  if (lockdownActive(app.store, app.runtime.owner)) throw new HttpError(409, "GitHub checkpoints are held during Lockdown.");
  if (app.sessionLock.locked()) throw new HttpError(409, "Unlock Branch before a GitHub checkpoint operation.");
  app.sessionLock.require();
}

async function token(app: Branch, config: Pick<CheckpointConfig, "owner" | "project" | "tokenSecret">): Promise<string> {
  if (config.owner !== app.runtime.owner || !app.store.projects.list(config.owner).some((project) => project.id === config.project)) throw new Error("Checkpoint owner or exact secret project is unavailable; update held.");
  const values = await app.store.secrets.resolve(config.owner, config.project, [config.tokenSecret], { purpose: "encrypted pre-update GitHub checkpoint" });
  if (!values[config.tokenSecret]) throw new Error("The exact configured GitHub secret is unavailable; update held.");
  return values[config.tokenSecret]!;
}

async function remote(app: Branch, request: IncomingMessage, dataDir: string, config: CheckpointConfig): Promise<CheckpointRemote> {
  ownerHere(app, request);
  return new CheckpointRemote(config.repository, await token(app, config), app.web.policy.guard(globalThis.fetch), async () => {
    ownerHere(app, request);
    if (JSON.stringify(await readCheckpointConfig(dataDir)) !== JSON.stringify(config)) throw new Error("Checkpoint authorization changed; operation held.");
  });
}

async function exclusive<T>(dataDir: string, work: () => Promise<T>): Promise<T> {
  if (busy.has(dataDir)) throw new HttpError(409, "A checkpoint operation is already in progress; retry the update after it finishes.");
  busy.add(dataDir); try { return await work(); } finally { busy.delete(dataDir); }
}

/** Called after the actual local update copy is finalized. Rejection propagates to the updater before file replacement. */
export async function checkpointBeforeUpdate(app: Branch, request: IncomingMessage, dataDir: string, folder: { name: string; path: string }): Promise<unknown> {
  const config = await readCheckpointConfig(dataDir); if (!config) return null;
  return exclusive(dataDir, async () => {
    const github = await remote(app, request, dataDir, config), archive = await encryptDataCopy(dataDir, folder, config);
    try { return await github.upload(config, archive); }
    finally { for (const chunk of archive.chunks) chunk.fill(0); }
  });
}

async function preview(app: Branch, request: IncomingMessage, body: unknown): Promise<unknown> {
  ownerHere(app, request); const proposal = ProposalSchema.parse(body), recipient = publicRecipient(proposal.publicKey);
  const config: CheckpointConfig = { ...proposal, ...recipient, format: 1, owner: app.runtime.owner,
    repositoryID: 1, enrollment: randomUUID(), approvedAt: new Date().toISOString() };
  const github = new CheckpointRemote(config.repository, await token(app, config), app.web.policy.guard(globalThis.fetch), () => ownerHere(app, request));
  config.repositoryID = await github.repositoryIdentity(); await github.validateExisting(config); ownerHere(app, request);
  const pending = previews.get(app) ?? new Map<string, Preview>(); previews.set(app, pending);
  for (const [id, value] of pending) if (value.expires < Date.now()) pending.delete(id);
  if (pending.size >= 8) throw new HttpError(409, "Too many checkpoint previews; allow an earlier preview to expire.");
  pending.set(config.enrollment, { config, expires: Date.now() + 10 * 60000 });
  return { preview: config.enrollment, repository: config.repository, repositoryID: config.repositoryID, fingerprint: config.fingerprint,
    branch: checkpointBranch, maxBytes: config.maxBytes, confirmation, expiresInSeconds: 600 };
}

async function enroll(app: Branch, request: IncomingMessage, dataDir: string, body: unknown): Promise<unknown> {
  ownerHere(app, request);
  const input = z.object({ preview: z.string().uuid(), confirmation: z.literal(confirmation), dedicatedRepository: z.literal(true), recoveryKeyHeld: z.literal(true) }).strict().parse(body);
  const pending = previews.get(app), value = pending?.get(input.preview); pending?.delete(input.preview);
  if (!value || value.expires < Date.now() || value.config.owner !== app.runtime.owner) throw new HttpError(409, "Checkpoint preview expired; review the target again.");
  return exclusive(dataDir, async () => {
    const github = new CheckpointRemote(value.config.repository, await token(app, value.config), app.web.policy.guard(globalThis.fetch), () => ownerHere(app, request));
    await github.repositoryIdentity(value.config.repositoryID); await github.validateExisting(value.config); ownerHere(app, request);
    await saveCheckpointConfig(dataDir, value.config);
    return { enabled: true, repository: value.config.repository, repositoryID: value.config.repositoryID, fingerprint: value.config.fingerprint };
  });
}

async function recoveryPreview(app: Branch, request: IncomingMessage, dataDir: string, body: unknown): Promise<unknown> {
  ownerHere(app, request);
  const input = z.object({ privateKeyFile: z.string().min(1).max(2000), commit: z.string().regex(/^[a-f0-9]{40}$/).optional(), stageOnly: z.literal(true) }).strict().parse(body);
  const config = await readCheckpointConfig(dataDir); if (!config) throw new Error("Enroll the exact private repository and recovery public key before recovery.");
  const github = await remote(app, request, dataDir, config), saved = await github.download(config, input.commit);
  try {
    ownerHere(app, request);
    const pending = recoveries.get(app) ?? new Map<string, RecoveryPreview>(); recoveries.set(app, pending);
    for (const [id, value] of pending) if (value.expires < Date.now()) pending.delete(id);
    if (pending.size >= 8) throw new HttpError(409, "Too many recovery previews; wait for an earlier preview to expire.");
    const id = randomUUID();
    pending.set(id, { config, privateKeyFile: input.privateKeyFile, commit: saved.commit, digest: saved.envelope.digest, expires: Date.now() + 120000 });
    return { preview: id, commit: saved.commit, fingerprint: config.fingerprint, privateKeyFile: input.privateKeyFile, confirmation: recoveryConfirmation, expiresInSeconds: 120 };
  } finally { saved.encrypted.fill(0); }
}

async function recover(app: Branch, request: IncomingMessage, dataDir: string, body: unknown): Promise<unknown> {
  ownerHere(app, request);
  const input = z.object({ preview: z.string().uuid(), confirmation: z.literal(recoveryConfirmation), stageOnly: z.literal(true) }).strict().parse(body);
  const pending = recoveries.get(app), value = pending?.get(input.preview); pending?.delete(input.preview);
  if (!value || value.expires < Date.now() || JSON.stringify(await readCheckpointConfig(dataDir)) !== JSON.stringify(value.config)) throw new HttpError(409, "Recovery preview expired or its authority changed; review the exact checkpoint again.");
  return exclusive(dataDir, async () => {
    const github = await remote(app, request, dataDir, value.config), saved = await github.download(value.config, value.commit);
    try {
      ownerHere(app, request);
      if (saved.envelope.digest !== value.digest) throw new Error("Recovery preview ciphertext changed.");
      const copy = await recoverDataCopy(dataDir, app.version, value.config, saved.envelope, saved.encrypted, value.privateKeyFile, () => ownerHere(app, request));
      return { ...copy, commit: saved.commit, staged: true, message: "A local data-copy restore point is ready for your review. Your current saved work was not replaced." };
    } finally { saved.encrypted.fill(0); }
  });
}

export async function githubCheckpointApi(app: Branch, request: IncomingMessage, path: string, dataDir: string, readBody: (request: IncomingMessage) => Promise<unknown>): Promise<unknown | undefined> {
  if (!path.startsWith("/api/deployment/github-checkpoint")) return undefined;
  ownerHere(app, request);
  if (request.method === "GET" && path === "/api/deployment/github-checkpoint") {
    const config = await readCheckpointConfig(dataDir);
    return config ? { enabled: true, repository: config.repository, repositoryID: config.repositoryID, fingerprint: config.fingerprint, maxBytes: config.maxBytes, branch: checkpointBranch } : { enabled: false };
  }
  if (request.method !== "POST") throw new HttpError(405, "Unsupported checkpoint operation.");
  if (path === "/api/deployment/github-checkpoint/preview") {
    const body = await readBody(request); return exclusive(dataDir, () => preview(app, request, body));
  }
  if (path === "/api/deployment/github-checkpoint/enroll") return enroll(app, request, dataDir, await readBody(request));
  if (path === "/api/deployment/github-checkpoint/recover") return recover(app, request, dataDir, await readBody(request));
  if (path === "/api/deployment/github-checkpoint/recover-preview") {
    const body = await readBody(request); return exclusive(dataDir, () => recoveryPreview(app, request, dataDir, body));
  }
  if (path === "/api/deployment/github-checkpoint/disable") {
    z.object({ disable: z.literal(true) }).strict().parse(await readBody(request));
    return exclusive(dataDir, async () => { ownerHere(app, request); await saveCheckpointConfig(dataDir, null); return { enabled: false }; });
  }
  throw new HttpError(404, "Unknown checkpoint operation.");
}
