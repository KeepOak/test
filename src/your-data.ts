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
import { memoryHistorySettings } from "./memory-git.js";
import { memoryProviderSettings } from "./memory-provider.js";
import { finish, latest, openJournal, optimizeWordIndexes, steps, unfinished, unfinishedSentence, type Journal } from "./your-data-forgood.js";
import type { MemoryRecord } from "./memory.js";
import { staysOnThisComputer } from "./backup.js";
import { hiddenMarker, redactLeaksIn } from "./leak-guard.js";
import { conversationMarkdown } from "./memory-export.js";
import { presetRunsLocally } from "./models.js";
import { relaySettings } from "./reach/relay.js";
import { reachMode } from "./reach/settings.js";
import { hereOnly, throughADoor } from "./remote/window-key.js";
import { HttpError, readJsonBody } from "./server-http.js";
import { traceExportSettings } from "./tracing-export.js";
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
const maximumExportsAtOnce = 2;
/** A person's facts that are not in use now; exported beside memory.json. */
const pastMemoryTables = ["memory_archive", "memory_versions", "memory_proposals", "memory_checkpoints"] as const;
const memoryTables = ["memory", "memory_archive", "memory_versions", "memory_proposals", "memory_checkpoints", "memory_terms",
  "memory_vectors", "memory_uses", "memory_suppressions"] as const; // never memory_outside_forgotten: see deleteEverything

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

/** The facts an outside memory service keeps for this person, when one is switched on; none otherwise. Throws when it cannot say. */
async function outsideFacts(app: Branch, scope: string): Promise<MemoryRecord[]> {
  return app.memory.backend.isOutside(scope) ? app.memory.backend.list(scope) : [];
}

async function ownKinds(app: Branch, scope: string, owner: boolean): Promise<Kind[]> {
  const where = (place: string): string | null => (owner ? place : null); // inside `folder`, the owner's only
  const talk = one(app, `SELECT (SELECT count(*) FROM sessions WHERE owner=?1) AS n,
    (SELECT coalesce(sum(length(m.body)),0) FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.owner=?1)
    + (SELECT coalesce(sum(length(prompt)+length(output)),0) FROM tasks WHERE owner=?1) AS b`, scope);
  const memory = one(app, "SELECT count(*) AS n, coalesce(sum(length(data)),0) AS b FROM memory WHERE owner=?", scope);
  // Facts on an outside service are counted too; one that cannot be asked leaves the count at what is kept here.
  const outside = await outsideFacts(app, scope).catch(() => [] as MemoryRecord[]);
  const files = sessionFiles(app, scope);
  const runs = one(app, `SELECT count(DISTINCT t.id) AS n, coalesce(sum(length(e.data)),0) AS b FROM tasks t
    LEFT JOIN events e ON e.run_id=t.id WHERE t.owner=?`, scope);
  const receipts = one(app, `SELECT count(*) AS n, coalesce(sum(length(json_extract(e.data,'$.receipt'))),0) AS b FROM events e
    JOIN tasks t ON t.id=e.run_id WHERE t.owner=? AND e.kind='tool.completed' AND json_extract(e.data,'$.receipt') IS NOT NULL`, scope);
  return [
    { kind: "conversations", count: talk.n, bytes: talk.b, where: where("branch.sqlite") },
    { kind: "memory", count: memory.n + outside.length, bytes: memory.b + outside.reduce((sum, record) => sum + JSON.stringify(record.data).length, 0),
      where: where("branch.sqlite") },
    { kind: "files", count: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), where: where("attachments") },
    { kind: "recordings", count: runs.n, bytes: runs.b, where: where("branch.sqlite") },
    { kind: "receipts", count: receipts.n, bytes: receipts.b, where: where("branch.sqlite") },
    ...(owner ? [{ kind: "private-search-cache", count: app.personal.privateIndex.cache.count(), bytes: null, where: "Process memory only; not exported" }] : []),
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
  memory: "Every fact Branch remembers for you, each time one is saved, looked up or forgotten, instead of keeping them here.",
  history: "A copy of everything Branch remembers for you, each time what it remembers changes.",
  traces: "Every step of each finished task, with what was said and done in it, and the usage counts.",
  moderation: "Each message the assistant is about to send to a chat app you linked, so it can be checked first.",
  voice: "What you say into the microphone, voice messages from your chats, and the replies read aloud.",
  chat: "Replies and notices to the chats you linked, and the messages those chats send in.",
  relay: "Messages to and from the chats you linked, sealed so only this computer and your relay can open them.",
  door: "Your conversations and questions, to a phone you let in over your private Tailscale network.",
  beyond: "Branch answers on your home network, so a device there that has the key can reach it.",
  phone: "What you open on that phone: conversations, questions waiting for you and your answers.",
  webhook: "A short note of each event you chose, posted to this address.",
  updates: "Which version of Branch this is, when it asks the release site for a newer one. Nothing you wrote.",
};
const here = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const leavesHere = (address: string): boolean => { try { return !here.has(new URL(address).hostname.toLowerCase()); } catch { return true; } };
const gitHost = (remote: string): string => /^git@([^:]+):/.exec(remote)?.[1] ?? hostOf(remote);

/** Where this person's facts go when they are kept off this computer: an outside memory service, or a copy of their history. */
function memoryLeaves(app: Branch, scope: string, owner: boolean): Leaves[] {
  const service = memoryProviderSettings(app.store, scope), history = memoryHistorySettings(app.store, scope);
  return [
    ...(app.memory.backend.isOutside(scope) && leavesHere(service.url)
      ? [{ id: "memory:outside", kind: "memory", name: hostOf(service.url), sends: sends.memory, page: owner ? "advanced" : null }] : []),
    ...(history.mode !== "off" && history.remote
      ? [{ id: "memory:history", kind: "history", name: gitHost(history.remote), sends: sends.history, page: null }] : []),
  ];
}

/** Trace sending carries every task's steps, household people's included; only the owner is told the address. */
function everybodysLeaves(app: Branch, owner: boolean): Leaves[] {
  const trace = traceExportSettings(app.store, app.runtime.owner);
  return trace.enabled && trace.endpoint && leavesHere(trace.endpoint)
    ? [{ id: "traces", kind: "traces", name: owner ? hostOf(trace.endpoint) : "", sends: sends.traces, page: null }] : [];
}

/** The check on what goes out to the owner's chat apps, when it is switched on and not on this computer. */
function moderationLeaves(app: Branch): Leaves[] {
  const moderation = app.moderation.settings();
  return moderation.enabled && moderation.endpoint && leavesHere(moderation.endpoint)
    ? [{ id: "model:moderation", kind: "model", name: hostOf(moderation.endpoint), sends: sends.moderation, page: null }] : [];
}

/** The services the owner's speech goes to: a chosen speech engine that is not on this computer, or the model service's own. */
function voiceLeaves(app: Branch): Leaves[] {
  const owner = app.runtime.owner, plan = app.voice.plan(owner), engines = app.voice.engines?.view(owner);
  const names = new Set<string>();
  for (const [which, route] of [["listen", plan.stt], ["speak", plan.tts]] as const) {
    const chosen = engines && engines.settings.mode !== "off" && engines.settings[which] ? engines.engines.find((engine) => engine.id === engines.settings[which]) : undefined;
    if (chosen) { if (!chosen.local && !plan.settings.keepAudioOnThisComputer) names.add(chosen.label); continue; }
    if ((route.kind === "openai" || route.kind === "gemini") && route.provider && leavesHere(route.provider.endpoint)) names.add(hostOf(route.provider.endpoint));
  }
  return [...names].map((name) => ({ id: `voice:${name}`, kind: "voice", name, sends: sends.voice, page: "voice" }));
}

function relayLeaves(app: Branch): Leaves[] {
  const relay = relaySettings(app.store, app.runtime.owner);
  return reachMode(app.store, app.runtime.owner, "relay") !== "off" && relay.address && relay.relayId
    ? [{ id: "relay", kind: "relay", name: hostOf(relay.address), sends: sends.relay, page: "gateway" }] : [];
}

/**
 * What leaves this computer, read from what is switched on now. A household person sees the model services, where their
 * own facts go, and trace sending, which carries their tasks too (without the owner's address). Connections a Trunk
 * uses only inside a task it was asked to do (an app, a tool server, a website) are not listed: each asks as it goes.
 */
function leaves(app: Branch, doors: DoorFacts, owner: boolean): Leaves[] {
  const scope = app.store.profiles.scope();
  const models: Leaves[] = [...app.runtime.models.presets.values()].filter((preset) => !presetRunsLocally(preset))
    .map((preset) => ({ id: `model:${preset.id}`, kind: "model", name: `${preset.name} · ${preset.provider.name}`, sends: sends.model, page: owner ? "models" : null }));
  const everybody = [...models, ...memoryLeaves(app, scope, owner), ...everybodysLeaves(app, owner)];
  if (!owner) return everybody;
  const hooks = app.webhooks.list(app.runtime.owner).filter((hook) => hook.enabled);
  return [
    ...everybody,
    ...voiceLeaves(app),
    ...moderationLeaves(app),
    ...app.channels.summary().channels.map((channel) => ({ id: `chat:${channel.id}`, kind: "chat", name: channel.botName ?? channel.kind, sends: sends.chat, page: "chatapps" })),
    ...relayLeaves(app),
    ...(doors.phoneDoor() ? [{ id: "door:phone", kind: "door", name: "Tailscale", sends: sends.door, page: "gateway" }] : []),
    ...(doors.beyondThisComputer() ? [{ id: "door:network", kind: "door", name: "", sends: sends.beyond, page: "gateway" }] : []),
    ...doors.phones().map((phone, i) => ({ id: `phone:${i}`, kind: "phone", name: phone.name, sends: sends.phone, page: "gateway" })),
    ...hooks.map((hook) => ({ id: `webhook:${hook.id}`, kind: "webhook", name: `${hook.name} · ${hostOf(hook.url)}`, sends: sends.webhook, page: "advanced" })),
    ...(readComfort(app.store, app.runtime.owner, "notify").autoUpdate !== "off"
      ? [{ id: "updates", kind: "updates", name: "", sends: sends.updates, page: "notifications" }] : []),
  ];
}

async function summary(app: Branch, doors: DoorFacts) {
  const owner = app.store.profiles.isOwner(), scope = app.store.profiles.scope();
  return {
    owner,
    person: owner ? null : app.store.profiles.active()?.name ?? null,
    folder: owner ? app.store.folder : null,
    kinds: [...await ownKinds(app, scope, owner), ...(owner ? ownerKinds(app, doors) : [])],
    leaves: leaves(app, doors, owner),
    lockdown: lockdownActive(app.store, app.runtime.owner),
    unfinished: unfinishedSentence(app, scope, (id) => finishing.has(id)),
    delete: deleteView(app, scope),
    deletePhrase,
  };
}

/* ---------- Export: one .zip, built part by part so the window can show how far it has got ---------- */
interface Job { id: string; scope: string; done: number; total: number; zip: Buffer | null; error: string | null; startedAt: number }
const jobs = new Map<string, Job>();
type Part = () => ZipEntry[] | Promise<ZipEntry[]>;
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
async function memoryPart(app: Branch, scope: string): Promise<ZipEntry[]> {
  const rows = app.store.sqlite.prepare("SELECT id, data, created_at, updated_at FROM memory WHERE owner=? ORDER BY created_at").all(scope) as
    { id: string; data: string; created_at: string; updated_at: string }[];
  const kept = Object.fromEntries(pastMemoryTables.filter((table) => tableExists(app, table))
    .map((table) => [table.replace("memory_", ""), app.store.sqlite.prepare(`SELECT * FROM ${table} WHERE owner=?`).all(scope)]));
  let outside: MemoryRecord[];
  try { outside = await outsideFacts(app, scope); }
  catch (error) {
    throw new Error(`The outside memory service could not be asked what it keeps, so nothing was saved (${error instanceof Error ? error.message : String(error)}).`);
  }
  const service = outside.length ? hostOf(memoryProviderSettings(app.store, scope).url) : "";
  return [json("memory.json", [
    ...rows.map((row) => ({ id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, fact: JSON.parse(row.data) })),
    ...outside.map((record) => ({ id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt, fact: record.data, keptBy: service })),
  ]), json("memory-archive.json", kept)];
}
function filesPart(app: Branch, scope: string): ZipEntry[] {
  return sessionFiles(app, scope).map((file) => ({
    name: `files/${file.session.slice(0, 8)}/${relative(join(attachmentsRoot(app)), file.path).split(/[\\/]/).slice(1).join("/")}`,
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
    { name: "logs/record.csv", data: Buffer.from(auditCsv(app.store.audit.everything(app.runtime.owner)), "utf8") },
    ...logs.map((file) => ({ name: `logs/${relative(join(app.store.folder, "logs"), file.path)}`, data: readFileSync(file.path) })),
  ];
}
/**
 * The owner's own settings, schedules and workflows, for bringing them back: only rows under the owner's own name, so
 * nothing of a household person's; sign-ins and this computer's own settings are left out as a backup leaves them out,
 * and anything key-shaped or a saved secret's value is hidden.
 */
function ownerSettingsPart(app: Branch): ZipEntry[] {
  const owner = app.runtime.owner;
  const rows = (table: string) => (app.store.sqlite.prepare(`SELECT id, data, created_at, updated_at FROM ${table} WHERE owner=? ORDER BY id`).all(owner) as
    { id: string; data: string; created_at: string; updated_at: string }[])
    .filter((row) => table !== "settings" || !staysOnThisComputer(row.id))
    .map((row) => ({ id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, value: JSON.parse(row.data) as unknown }));
  const kept = { settings: rows("settings"), schedules: rows("schedules"), workflows: rows("workflows") };
  return [json("settings.json", hideNamed(redactLeaksIn(app.store.secrets.scrubber.deep(kept)).value))];
}
/** A value under a name that says it is a key, and every header value, is hidden, unless it only names a saved secret. */
const keyish = /key|token|secret|passw|authori[sz]ation|cookie|credential|bearer/i;
function hideNamed(value: unknown, underHeaders = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => hideNamed(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, entry]) =>
    [name, typeof entry === "string" && entry && !entry.startsWith("secret://") && (underHeaders || keyish.test(name))
      ? hiddenMarker("password") : hideNamed(entry, /^headers$/i.test(name))]));
}
const readme = (owner: boolean): string => [
  "Everything Branch keeps for you, as plain files.",
  "conversations/: each conversation as a page you can read (.md) and as data (.json).",
  "memory.json: what Branch remembers for you. memory-archive.json: facts put away, earlier wordings, suggestions and checkpoints.",
  "files/: the files you added to conversations.",
  "recordings.json: every step each task took. receipts.json: the signed proof of each tool that finished.",
  ...(owner ? ["keys-and-connections.json: the names of your keys and connections. No key, password or token is in this file.",
    "logs/: the record of what Branch was allowed to do, and its own logs.",
    "settings.json: your own settings, schedules and workflows. Sign-ins and this computer's own settings are left out."] : []),
  "Keys, passwords and sign-ins never go in an export.", "",
].join("\n");

function startExport(app: Branch, doors: DoorFacts): Job {
  const scope = app.store.profiles.scope(), owner = app.store.profiles.isOwner();
  for (const [id, job] of jobs) if (Date.now() - job.startedAt > jobLifeMs) jobs.delete(id);
  // One at a time for each person: another is refused while theirs is being made; a finished one makes way for the new.
  if ([...jobs.values()].some((job) => job.scope === scope && !job.zip && !job.error))
    throw new HttpError(409, "An export is already being made. Wait for it to finish, then try again.");
  // And no more than two at once across everybody: each is built in memory, up to 512 MB.
  if ([...jobs.values()].filter((job) => !job.zip && !job.error).length >= maximumExportsAtOnce)
    throw new HttpError(409, "Two exports are already being made on this computer. Wait for one to finish, then try again.");
  for (const [id, job] of jobs) if (job.scope === scope) jobs.delete(id);
  const parts: Part[] = [
    () => [{ name: "README.txt", data: Buffer.from(readme(owner), "utf8") }],
    () => conversationParts(app, scope), () => memoryPart(app, scope), () => filesPart(app, scope), () => runsPart(app, scope),
    ...(owner ? [() => ownerParts(app, doors), () => ownerSettingsPart(app)] : []),
  ];
  const job: Job = { id: randomUUID(), scope, done: 0, total: parts.length + 1, zip: null, error: null, startedAt: Date.now() };
  jobs.set(job.id, job);
  void runExport(app, job, parts);
  return job;
}
async function runExport(app: Branch, job: Job, parts: Part[]): Promise<void> {
  const entries: ZipEntry[] = [];
  try {
    let bytes = 0;
    for (const part of parts) {
      await new Promise((resolve) => setImmediate(resolve));
      const made = await part();
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
/**
 * Everything that can refuse is asked first (the words, Lockdown, a working task, the outside memory service). Then the
 * whole purge is one transaction with its journal row and its record: it all commits, or on any failure nothing has
 * changed and the answer says to try again. What lies outside the database is done after, step by step, from the
 * journal (src/your-data-forgood.ts), and whatever cannot finish now finishes later.
 */
async function deleteEverything(app: Branch, confirm: string) {
  const scope = app.store.profiles.scope(), owner = app.runtime.owner;
  if (confirm.trim().toLowerCase() !== deletePhrase) throw new HttpError(400, `Type "${deletePhrase}" to confirm. Nothing was deleted.`);
  if (lockdownActive(app.store, owner)) throw new HttpError(409, "Lockdown is on, so nothing is deleted. Turn Lockdown off first.");
  // A delete of this person's that was cut short carries on, beside this one.
  for (const journal of unfinished(app, scope)) void finishOnce(app, journal);
  const sessions = sessionsOf(app, scope).map((session) => session.id);
  const withCompanions = (id: string) => [id, ...app.store.conversationCompanions(id)];
  // QA retest 2026-09-28 (D1): a task only waiting on the person's answer held the delete with "still working" while the
  // status bar said nothing was running; it now says which it is, and where to answer it.
  if (sessions.some((id) => app.store.conversations.busy(withCompanions(id), ["running"])))
    throw new HttpError(409, "A task is still working. Stop it or wait for it, then try again. Nothing was deleted.");
  if (sessions.some((id) => app.store.conversations.busy(withCompanions(id))))
    throw new HttpError(409, "A task is waiting for your answer. Answer it or stop it (the Inbox lists it), then try again. Nothing was deleted.");
  // An export being made would mix what was there with what is left.
  if ([...jobs.values()].some((job) => job.scope === scope && !job.zip && !job.error))
    throw new HttpError(409, "An export is still being made. Wait for it to finish, then try again. Nothing was deleted.");
  let outside: Awaited<ReturnType<Branch["memory"]["backend"]["everythingOutside"]>>;
  try { outside = await app.memory.backend.everythingOutside(scope); }
  catch (error) { throw new HttpError(409, errorWords(error)); }
  // The memory history is one folder, the owner's: only the owner's delete starts it again, or it would wipe theirs.
  const history = scope === owner;
  if (history) app.personal.privateIndex.configure({ enabled: false, selections: [] });
  const theirHistory = !history && app.memoryHistory.settings(scope).mode !== "off";
  let done: { journal: Journal; conversations: number; memory: number };
  try { done = app.store.atomically(() => purge(app, scope, sessions, outside, history)); }
  catch (error) {
    rereadAfterRollback(app, sessions);
    throw new HttpError(500, `Something went wrong part way, so nothing was deleted (${errorWords(error)}). Try again.`);
  }
  for (const [id, job] of jobs) if (job.scope === scope) jobs.delete(id); // a finished export of what was deleted goes too
  // The rest runs after this answer; the page follows it through GET /api/your-data (`delete`).
  void finishOnce(app, done.journal);
  return { deleted: { conversations: done.conversations, memory: done.memory }, journal: done.journal.id, removed: done.journal.removed,
    kept: app.store.profiles.isOwner()
      ? "Your keys, connections and settings stay, and so does the record that this was deleted."
      : `The record that this was deleted stays.${theirHistory ? " So do earlier versions in the owner's history of what is remembered, which may hold what you remembered while yours was on." : ""}` };
}

/** The database half, run inside one transaction by the caller: purge, marks, journal and record together. */
function purge(app: Branch, scope: string, sessions: string[], outside: { url: string; ids: string[]; inUse: number } | null, history: boolean) {
  const db = app.store.sqlite;
  const secure = Number((db.prepare("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete);
  db.exec("PRAGMA secure_delete=ON"); // what is deleted is overwritten, not left in the file's free space
  try {
    const runIds = (db.prepare("SELECT id FROM tasks WHERE owner=?").all(scope) as { id: string }[]).map((row) => row.id);
    // #458's "Delete now" for each one, wherever it is (Recent, Archived, Recently Deleted): a room's own sides go with it.
    let conversations = 0;
    for (const id of sessions) {
      if (!app.store.ownsSession(scope, id)) continue; // went with a room deleted just before
      app.store.deleteConversationForGood(scope, id);
      conversations++;
    }
    // The word index keeps each fact's text under a row number only memory_terms ties to its owner, so it goes first.
    if (tableExists(app, "memory_search") && tableExists(app, "memory_terms"))
      db.prepare("DELETE FROM memory_search WHERE rowid IN (SELECT row_id FROM memory_terms WHERE owner=?)").run(scope);
    let memory = outside?.inUse ?? 0;
    for (const table of memoryTables) {
      if (!tableExists(app, table)) continue;
      const changes = Number(db.prepare(`DELETE FROM ${table} WHERE owner=?`).run(scope).changes);
      if (table === "memory") memory += changes;
    }
    optimizeWordIndexes(db); // a deleted message's or fact's words leave the search indexes' own pages now
    // Facts on an outside service are marked forgotten here, now, so none is read back whatever the service does later.
    if (outside) app.memory.backend.markAllForgotten(scope, outside.ids);
    const removed = [`${conversations === 1 ? "One conversation with its" : `${conversations} conversations with their`} files, recordings and receipts, and ${memory === 1 ? "one remembered fact" : `${memory} remembered facts`}.`];
    const journal = openJournal(app, { scope, sessions, runIds, outside: outside ? { url: outside.url, pending: outside.ids } : null, history }, removed);
    audit(app.store, app.runtime.owner, { action: "history.pruned", actor: scope, subject: "everything kept for this person",
      reason: `Settings › Your data: deleted ${conversations} conversations with their files, recordings and receipts, and ${memory} remembered facts`, outcome: "deleted" });
    return { journal, conversations, memory };
  } finally { db.exec(`PRAGMA secure_delete=${secure}`); }
}

/**
 * A rolled-back purge put the database back, but a Trunk's own conversation and a room's seats are also kept in memory,
 * and a room removed on the way ended the answers kept for its seats: both are read from the database again.
 */
function rereadAfterRollback(app: Branch, sessions: string[]): void {
  const touched = sessions.flatMap((id) => [id, ...app.store.conversationCompanions(id)]);
  try { app.trunks.reload(); } catch (error) { console.error(`Trunks could not be read again: ${errorWords(error)}`); }
  app.runtime.rereadCarried(touched);
}

/** What the page shows of this person's newest delete: how far its steps have got, what went and what is left. */
function deleteView(app: Branch, scope: string) {
  const journal = latest(app, scope);
  if (!journal) return null;
  const elsewhere = savedElsewhere(app, scope, journal.startedAt);
  return { id: journal.id, done: journal.done.length, total: steps.length, working: finishing.has(journal.id),
    removed: journal.removed, waiting: journal.waiting, elsewhere,
    elsewhereNote: elsewhere.length ? "Branch did not touch these copies you saved outside its folder. They still hold what they held when you saved them; delete them yourself if you want them gone." : null };
}
/** The copies this person saved out of Branch before that delete (every export is written to the owner's record), newest first. */
function savedElsewhere(app: Branch, scope: string, before: string): { at: string; what: string }[] {
  return app.store.audit.list(app.runtime.owner, { action: "data.exported", to: before, limit: 1000 })
    .filter((entry) => entry.actor === scope).map((entry) => ({ at: entry.at, what: entry.subject }));
}

const errorWords = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const finishing = new Map<string, Promise<Journal>>();
/** Runs a journal's steps once at a time: a press and a start that both want it share the same run. */
function finishOnce(app: Branch, journal: Journal): Promise<Journal> {
  const running = finishing.get(journal.id);
  if (running) return running;
  const next = finish(app, journal).finally(() => finishing.delete(journal.id));
  finishing.set(journal.id, next);
  return next;
}
/** At start: every delete that was cut short carries on. Never throws. */
export async function resumeUnfinishedDeletes(app: Branch): Promise<void> {
  try { for (const journal of unfinished(app)) await finishOnce(app, journal); }
  catch (error) { console.error(`Delete everything could not carry on: ${errorWords(error)}`); }
}

const DeleteSchema = z.object({ confirm: z.string().max(100) }).strict();

/** The routes. Answers the value to send, or undefined once it has written the download itself. */
export async function yourDataApi(app: Branch, request: IncomingMessage, response: ServerResponse, path: string, doors: DoorFacts): Promise<unknown> {
  const method = request.method ?? "GET";
  if (method === "GET" && path === "/api/your-data") return await summary(app, doors);
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
  if (method === "POST" && path === "/api/your-data/delete") return await deleteEverything(app, DeleteSchema.parse(await readJsonBody(request)).confirm);
  throw new HttpError(404, "Endpoint not found");
}
