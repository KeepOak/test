import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, relative } from "node:path";
import { z } from "zod";
import { audit, auditCsv } from "./audit.js";
import { folderFor } from "./attachments.js";
import { readComfort } from "./comfort/settings.js";
import type { createBranch } from "./index.js";
import { lockdownActive } from "./lockdown.js";
import { conversationMarkdown } from "./memory-export.js";
import { presetRunsLocally } from "./models.js";
import { hereOnly, throughADoor } from "./remote/window-key.js";
import { HttpError, readJsonBody } from "./server-http.js";
import { buildZip, type ZipEntry } from "./zip-write.js";

/**
 * Settings › Your data: what Branch keeps for the person at the window, what leaves this computer, one export of all of
 * it, and deleting all of it. Everything is read under `profiles.scope()`: a household person sees, exports and deletes
 * only their own; the owner's keys, connections, logs and folder are the owner's alone. No secret value is ever read
 * here: keys and connections are counted and named, never opened. Deleting is never automatic (the ship-on rule's (c)):
 * the person types the words, Lockdown refuses it, a door refuses it, and every delete is written to the owner's record.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export interface DoorFacts { phoneDoor: () => boolean; beyondThisComputer: () => boolean; phones: () => { name: string }[] }

export const handlesYourDataPath = (path: string): boolean => path === "/api/your-data" || path.startsWith("/api/your-data/");
export const deletePhrase = "delete everything";
const maximumExportBytes = 512 * 1024 * 1024;
const memoryTables = ["memory", "memory_archive", "memory_versions", "memory_proposals", "memory_checkpoints", "memory_terms",
  "memory_vectors", "memory_uses", "memory_suppressions", "memory_outside_forgotten"] as const;

interface Kind { kind: string; count: number; bytes: number | null; where: string | null }
const one = (app: Branch, sql: string, ...values: string[]): { n: number; b: number } => {
  const row = app.store.sqlite.prepare(sql).get(...values) as { n?: number; b?: number } | undefined;
  return { n: Number(row?.n ?? 0), b: Number(row?.b ?? 0) };
};
const tableExists = (app: Branch, table: string): boolean =>
  app.store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;

function sessionsOf(app: Branch, scope: string): { id: string; temporary: boolean; createdAt: string }[] {
  return (app.store.sqlite.prepare("SELECT id, temporary, created_at FROM sessions WHERE owner=? ORDER BY created_at").all(scope) as
    { id: string; temporary: number; created_at: string }[]).map((row) => ({ id: row.id, temporary: row.temporary === 1, createdAt: row.created_at }));
}

/** Every file under a folder, with its size; a folder that is not there has none. */
function filesUnder(root: string): { path: string; bytes: number }[] {
  if (!existsSync(root)) return [];
  const out: { path: string; bytes: number }[] = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name), stat = statSync(path);
      if (stat.isDirectory()) walk(path); else out.push({ path, bytes: stat.size });
    }
  };
  walk(root);
  return out;
}
const attachmentsRoot = (app: Branch): string => join(app.store.folder, "attachments");
function sessionFiles(app: Branch, scope: string): { path: string; bytes: number; session: string }[] {
  return sessionsOf(app, scope).flatMap((session) => filesUnder(join(attachmentsRoot(app), folderFor(session.id, session.temporary)))
    .map((file) => ({ ...file, session: session.id })));
}

function ownKinds(app: Branch, scope: string, owner: boolean): Kind[] {
  const where = (place: string): string | null => (owner ? place : null); // inside `folder`, the owner's only
  const talk = one(app, `SELECT (SELECT count(*) FROM sessions WHERE owner=?1) AS n,
    (SELECT coalesce(sum(length(m.body)),0) FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.owner=?1)
    + (SELECT coalesce(sum(length(prompt)+length(output)),0) FROM tasks WHERE owner=?1) AS b`, scope);
  const memory = one(app, "SELECT count(*) AS n, coalesce(sum(length(data)),0) AS b FROM memory WHERE owner=?", scope);
  const files = sessionFiles(app, scope);
  const runs = one(app, `SELECT count(DISTINCT t.id) AS n, coalesce(sum(length(e.data)),0) AS b FROM tasks t
    LEFT JOIN events e ON e.run_id=t.id WHERE t.owner=?`, scope);
  const receipts = one(app, `SELECT count(*) AS n, coalesce(sum(length(json_extract(e.data,'$.receipt'))),0) AS b FROM events e
    JOIN tasks t ON t.id=e.run_id WHERE t.owner=? AND e.kind='tool.completed' AND json_extract(e.data,'$.receipt') IS NOT NULL`, scope);
  return [
    { kind: "conversations", count: talk.n, bytes: talk.b, where: where("branch.sqlite") },
    { kind: "memory", count: memory.n, bytes: memory.b, where: where("branch.sqlite") },
    { kind: "files", count: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), where: where("attachments") },
    { kind: "recordings", count: runs.n, bytes: runs.b, where: where("branch.sqlite") },
    { kind: "receipts", count: receipts.n, bytes: receipts.b, where: where("branch.sqlite") },
  ];
}

/** The owner's keys and connections, counted and named: never a value. */
function keysAndConnections(app: Branch, doors: DoorFacts) {
  const owner = app.runtime.owner;
  const secrets = tableExists(app, "secret_meta")
    ? app.store.sqlite.prepare("SELECT project, name FROM secret_meta WHERE owner=? ORDER BY project, name").all(owner) as { project: string; name: string }[]
    : [];
  return {
    models: [...app.runtime.models.presets.values()].map((preset) => ({ name: preset.name, service: preset.provider.name, model: preset.model })),
    secrets: secrets.map((row) => ({ project: String(row.project), name: String(row.name) })),
    chatApps: app.channels.summary().channels.map((channel) => ({ kind: channel.kind, name: channel.botName ?? channel.kind })),
    phones: doors.phones().map((phone) => ({ name: phone.name })),
    webhooks: app.webhooks.list(owner).map((hook) => ({ name: hook.name, host: hostOf(hook.url), enabled: hook.enabled })),
  };
}
const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return ""; } };

function ownerKinds(app: Branch, doors: DoorFacts): Kind[] {
  const keys = keysAndConnections(app, doors);
  const count = keys.models.length + keys.secrets.length + keys.chatApps.length + keys.phones.length + keys.webhooks.length;
  const logs = filesUnder(join(app.store.folder, "logs"));
  const records = one(app, "SELECT count(*) AS n, coalesce(sum(length(subject)+length(reason)),0) AS b FROM audit WHERE owner=?", app.runtime.owner);
  return [
    { kind: "keys", count, bytes: null, where: "locker.key" },
    { kind: "logs", count: logs.length + records.n, bytes: logs.reduce((sum, file) => sum + file.bytes, 0) + records.b, where: "logs" },
  ];
}

interface Leaves { id: string; kind: string; name: string; sends: string; page: string | null }
const sends = {
  model: "What you write in a conversation, the files you add to it and the answers so far, so it can reply.",
  chat: "Replies and notices to the chats you linked, and the messages those chats send in.",
  door: "Your conversations and questions, to a phone you let in over your private Tailscale network.",
  beyond: "Branch answers on your home network, so a device there that has the key can reach it.",
  phone: "What you open on that phone: conversations, questions waiting for you and your answers.",
  webhook: "A short note of each event you chose, posted to this address.",
  updates: "Which version of Branch this is, when it asks the release site for a newer one. Nothing you wrote.",
};

/** What leaves this computer, read from what is switched on now. A household person sees only the model services. */
function leaves(app: Branch, doors: DoorFacts, owner: boolean): Leaves[] {
  const models: Leaves[] = [...app.runtime.models.presets.values()].filter((preset) => !presetRunsLocally(preset))
    .map((preset) => ({ id: `model:${preset.id}`, kind: "model", name: `${preset.name} · ${preset.provider.name}`, sends: sends.model, page: owner ? "models" : null }));
  if (!owner) return models;
  const hooks = app.webhooks.list(app.runtime.owner).filter((hook) => hook.enabled);
  return [
    ...models,
    ...app.channels.summary().channels.map((channel) => ({ id: `chat:${channel.id}`, kind: "chat", name: channel.botName ?? channel.kind, sends: sends.chat, page: "chatapps" })),
    ...(doors.phoneDoor() ? [{ id: "door:phone", kind: "door", name: "Tailscale", sends: sends.door, page: "gateway" }] : []),
    ...(doors.beyondThisComputer() ? [{ id: "door:network", kind: "door", name: "", sends: sends.beyond, page: "gateway" }] : []),
    ...doors.phones().map((phone, i) => ({ id: `phone:${i}`, kind: "phone", name: phone.name, sends: sends.phone, page: "gateway" })),
    ...hooks.map((hook) => ({ id: `webhook:${hook.id}`, kind: "webhook", name: `${hook.name} · ${hostOf(hook.url)}`, sends: sends.webhook, page: "advanced" })),
    ...(readComfort(app.store, app.runtime.owner, "notify").autoUpdate !== "off"
      ? [{ id: "updates", kind: "updates", name: "", sends: sends.updates, page: "notifications" }] : []),
  ];
}

function summary(app: Branch, doors: DoorFacts) {
  const owner = app.store.profiles.isOwner(), scope = app.store.profiles.scope();
  return {
    owner,
    person: owner ? null : app.store.profiles.active()?.name ?? null,
    folder: owner ? app.store.folder : null,
    kinds: [...ownKinds(app, scope, owner), ...(owner ? ownerKinds(app, doors) : [])],
    leaves: leaves(app, doors, owner),
    lockdown: lockdownActive(app.store, app.runtime.owner),
    deletePhrase,
  };
}

/* ---------- Export: one .zip, built part by part so the window can show how far it has got ---------- */
interface Job { id: string; scope: string; done: number; total: number; zip: Buffer | null; error: string | null; startedAt: number }
const jobs = new Map<string, Job>();
const jobLifeMs = 30 * 60 * 1000;
const json = (name: string, value: unknown): ZipEntry => ({ name, data: Buffer.from(JSON.stringify(value, null, 2), "utf8") });

function conversationParts(app: Branch, scope: string): ZipEntry[] {
  return sessionsOf(app, scope).flatMap((session) => {
    const view = app.store.sessionView(scope, session.id) as { title?: string };
    const messages = app.store.messages(session.id);
    const head = { sessionId: session.id, createdAt: session.createdAt, ...(view.title ? { title: view.title } : {}) };
    return [
      { name: `conversations/${session.createdAt.slice(0, 10)}-${session.id.slice(0, 8)}.md`, data: Buffer.from(conversationMarkdown(head, messages), "utf8") },
      json(`conversations/${session.createdAt.slice(0, 10)}-${session.id.slice(0, 8)}.json`, { ...head, messages }),
    ];
  });
}
function memoryPart(app: Branch, scope: string): ZipEntry[] {
  const rows = app.store.sqlite.prepare("SELECT id, data, created_at, updated_at FROM memory WHERE owner=? ORDER BY created_at").all(scope) as
    { id: string; data: string; created_at: string; updated_at: string }[];
  return [json("memory.json", rows.map((row) => ({ id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, fact: JSON.parse(row.data) })))];
}
function filesPart(app: Branch, scope: string): ZipEntry[] {
  return sessionFiles(app, scope).map((file) => ({
    name: `files/${file.session.slice(0, 8)}/${relative(join(attachmentsRoot(app)), file.path).split(/[\/]/).slice(1).join("/")}`,
    data: readFileSync(file.path),
  }));
}
function runsPart(app: Branch, scope: string): ZipEntry[] {
  const tasks = app.store.sqlite.prepare("SELECT id, session_id, prompt, status, created_at FROM tasks WHERE owner=? ORDER BY created_at").all(scope) as
    { id: string; session_id: string; prompt: string; status: string; created_at: string }[];
  const events = app.store.sqlite.prepare("SELECT kind, data, created_at FROM events WHERE run_id=? ORDER BY id");
  const recordings = [], receipts = [];
  for (const task of tasks) {
    const steps = (events.all(task.id) as { kind: string; data: string; created_at: string }[]).map((row) => ({ kind: row.kind, at: row.created_at, data: JSON.parse(row.data) as Record<string, unknown> }));
    recordings.push({ taskId: task.id, conversationId: task.session_id, prompt: task.prompt, status: task.status, createdAt: task.created_at, steps });
    for (const step of steps) if (step.kind === "tool.completed" && step.data.receipt)
      receipts.push({ taskId: task.id, tool: step.data.name ?? null, receipt: step.data.receipt });
  }
  return [json("recordings.json", recordings), json("receipts.json", receipts)];
}
function ownerParts(app: Branch, doors: DoorFacts): ZipEntry[] {
  const logs = filesUnder(join(app.store.folder, "logs"));
  return [
    json("keys-and-connections.json", keysAndConnections(app, doors)),
    { name: "logs/record.csv", data: Buffer.from(auditCsv(app.store.audit.list(app.runtime.owner, { limit: 1000 })), "utf8") },
    ...logs.map((file) => ({ name: `logs/${relative(join(app.store.folder, "logs"), file.path)}`, data: readFileSync(file.path) })),
    json("backup.json", app.store.backup(app.version)),
  ];
}
const readme = (owner: boolean): string => [
  "Everything Branch keeps for you, as plain files.",
  "conversations/: each conversation as a page you can read (.md) and as data (.json).",
  "memory.json: what Branch remembers for you. files/: the files you added to conversations.",
  "recordings.json: every step each task took. receipts.json: the signed proof of each tool that finished.",
  ...(owner ? ["keys-and-connections.json: the names of your keys and connections. No key, password or token is in this file.",
    "logs/: the record of what Branch was allowed to do, and its own logs. backup.json: everything else, for a restore."] : []),
  "Keys, passwords and sign-ins never go in an export.", "",
].join("\n");

function startExport(app: Branch, doors: DoorFacts): Job {
  const scope = app.store.profiles.scope(), owner = app.store.profiles.isOwner();
  for (const [id, job] of jobs) if (job.scope === scope || Date.now() - job.startedAt > jobLifeMs) jobs.delete(id);
  const parts: (() => ZipEntry[])[] = [
    () => [{ name: "README.txt", data: Buffer.from(readme(owner), "utf8") }],
    () => conversationParts(app, scope), () => memoryPart(app, scope), () => filesPart(app, scope), () => runsPart(app, scope),
    ...(owner ? [() => ownerParts(app, doors)] : []),
  ];
  const job: Job = { id: randomUUID(), scope, done: 0, total: parts.length + 1, zip: null, error: null, startedAt: Date.now() };
  jobs.set(job.id, job);
  void runExport(app, job, parts);
  return job;
}
async function runExport(app: Branch, job: Job, parts: (() => ZipEntry[])[]): Promise<void> {
  const entries: ZipEntry[] = [];
  try {
    let bytes = 0;
    for (const part of parts) {
      await new Promise((resolve) => setImmediate(resolve));
      const made = part();
      bytes += made.reduce((sum, entry) => sum + entry.data.length, 0);
      if (bytes > maximumExportBytes) throw new Error("Your data is larger than one export can hold (512 MB). Nothing was saved.");
      entries.push(...made);
      job.done++;
    }
    await new Promise((resolve) => setImmediate(resolve));
    job.zip = buildZip(entries);
    job.done = job.total;
    audit(app.store, app.runtime.owner, { action: "data.exported", actor: job.scope, subject: "everything kept for this person",
      reason: "Settings › Your data: everything except keys, passwords and sign-ins, as one .zip", outcome: "saved" });
  } catch (error) {
    job.error = error instanceof Error ? error.message : String(error);
  }
}
function jobView(job: Job) {
  return { id: job.id, done: job.done, total: job.total, ready: job.zip !== null, bytes: job.zip?.length ?? null, error: job.error };
}
function ownJob(app: Branch, id: string): Job {
  const job = jobs.get(id);
  if (!job || job.scope !== app.store.profiles.scope() || Date.now() - job.startedAt > jobLifeMs) throw new HttpError(404, "Export not found");
  return job;
}

/* ---------- Delete everything: typed, never under Lockdown, never through a door, always written down ---------- */
function deleteEverything(app: Branch, confirm: string) {
  const scope = app.store.profiles.scope(), owner = app.runtime.owner;
  if (confirm.trim().toLowerCase() !== deletePhrase) throw new HttpError(400, `Type "${deletePhrase}" to confirm. Nothing was deleted.`);
  if (lockdownActive(app.store, owner)) throw new HttpError(409, "Lockdown is on, so nothing is deleted. Turn Lockdown off first.");
  const sessions = sessionsOf(app, scope).map((session) => session.id);
  if (sessions.some((id) => app.store.conversations.busy([id, ...app.store.conversationCompanions(id)])))
    throw new HttpError(409, "A task is still working. Stop it or wait for it, then try again. Nothing was deleted.");
  // #458's "Delete now" for each one, wherever it is (Recent, Archived, Recently Deleted): a room's own sides go with it.
  let conversations = 0;
  for (const id of sessions) {
    if (!app.store.ownsSession(scope, id)) continue; // went with a room deleted just before
    app.store.deleteConversationForGood(scope, id);
    conversations++;
  }
  let memory = 0;
  for (const table of memoryTables) {
    if (!tableExists(app, table)) continue;
    const changes = Number(app.store.sqlite.prepare(`DELETE FROM ${table} WHERE owner=?`).run(scope).changes);
    if (table === "memory") memory = changes;
  }
  audit(app.store, owner, { action: "history.pruned", actor: scope, subject: "everything kept for this person",
    reason: `Settings › Your data: deleted ${conversations} conversations with their files, recordings and receipts, and ${memory} remembered facts`, outcome: "deleted" });
  return { deleted: { conversations, memory }, kept: app.store.profiles.isOwner()
    ? "Your keys, connections and settings stay, and so does the record that this was deleted." : "The record that this was deleted stays." };
}

const DeleteSchema = z.object({ confirm: z.string().max(100) }).strict();

/** The routes. Answers the value to send, or undefined once it has written the download itself. */
export async function yourDataApi(app: Branch, request: IncomingMessage, response: ServerResponse, path: string, doors: DoorFacts): Promise<unknown> {
  const method = request.method ?? "GET";
  if (method === "GET" && path === "/api/your-data") return summary(app, doors);
  if (throughADoor(request)) throw new HttpError(403, hereOnly);
  if (method === "POST" && path === "/api/your-data/export") {
    z.object({}).strict().parse(await readJsonBody(request));
    return jobView(startExport(app, doors));
  }
  const exporting = /^\/api\/your-data\/export\/([a-f0-9-]{36})(\/file)?$/.exec(path);
  if (exporting && method === "GET") {
    const job = ownJob(app, exporting[1]!);
    if (!exporting[2]) return jobView(job);
    if (!job.zip) throw new HttpError(409, job.error ?? "The export is not ready yet");
    response.writeHead(200, { "content-type": "application/zip", "content-length": job.zip.length, "cache-control": "no-store",
      "content-disposition": `attachment; filename="branch-your-data-${new Date(job.startedAt).toISOString().slice(0, 10)}.zip"` });
    response.end(job.zip);
    return undefined;
  }
  if (method === "POST" && path === "/api/your-data/delete") return deleteEverything(app, DeleteSchema.parse(await readJsonBody(request)).confirm);
  throw new HttpError(404, "Endpoint not found");
}
