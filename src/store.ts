import { dirname } from "node:path";
import { forgetTeamResults, markDeletedTurnParts } from "./team-tasks.js"; // Q61
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Event, Message, Run, RunStatus } from "./contracts.js";
import { reconcileTranscript } from "./transcript.js";
import { notRunMark, notRunResult } from "./approved-call.js"; // QA R1
import { SessionHistory } from "./history.js";
import { SessionBranches, type ConversationFiles } from "./sessions.js";
import { SessionLibrary } from "./session-library.js";
import { SessionSummaries, type SessionSummary } from "./session-summary.js";
import { WorkingSessions, type WorkingNote } from "./working-session.js";
import { MemoryFacts, type MemoryRecord } from "./memory.js";
import { InstalledSkills } from "./skills.js";
import { Projects } from "./projects.js";
import { Locker, type LockerKeySource } from "./locker.js";
import { Secrets } from "./vault.js";
import { Receipts } from "./receipts.js";
import { CollabEvents, ownerMember } from "./collab-events.js";
import { AuditLog, audit } from "./audit.js";
import { achievementTallies, type AchievementTallies, type EventScan } from "./achievement-tallies.js"; // phase2/delight
import { MemoryReview } from "./memory-review.js";
import { SkillGovernance } from "./skill-governance.js";
import { exportBackup, importBackup, type RestoreOptions } from "./backup.js";
import { RestoreHeld } from "./restore-held.js";
import { RestoredTrunks } from "./trunks/restored.js"; // #484: Trunks a restore brought back cut down
import { ensureThreadTable } from "./trunks/threads.js"; // defaulttrunk
import { WorkspaceHistory } from "./workspace-history.js";
import type { WorkspaceFiles } from "./files.js";
import { UsageStore } from "./usage.js";
// Wave 6 (collaboration and workflows): labels and project notes, share links, household profiles.
import { Labels } from "./labels.js";
import { LeftOutMessages } from "./left-out.js";
import { ReadMarks } from "./read-marks.js";
import { ConversationPaths } from "./conversation-paths.js";
import { ConversationMarks, busyWords } from "./conversation-actions.js";
import { ensureForgotten, findResidue, forgetResidue, rememberForgotten } from "./conversation-residue.js";
import { MediaComments } from "./media-comments.js";
import { ShareLinks } from "./conversation-share.js";
import { Profiles } from "./profiles.js";
// Wave 7 (tool loading): what this computer has learned about which tools a request needs.
import { ToolUsage } from "./tool-usage.js";
import { SpanStore } from "./tracing.js";
// mac7/wake-pins: settings the owner pinned. Imports nothing but zod and this file's own type.
import { PinnedSettingError, pinnedDeleteRefusal, pinnedWriteRefusal } from "./settings-kit/pins.js";

type Row = Record<string, unknown>;
export type RecordTable = "memory" | "specialists" | "procedures" | "schedules" | "settings" | "deliveries" | "governance" | "triggers" | "webhooks" | "workflows" | "flow_graphs";
export interface SavedRecord {
  id: string;
  owner: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export class Store {
  private readonly db: DatabaseSync;
  private readonly history: SessionHistory;
  private readonly branches: SessionBranches;
  private readonly library: SessionLibrary;
  readonly summaries: SessionSummaries;
  readonly working: WorkingSessions;
  /** Pass 17: messages left out of what the model sees, read marks, and named paths of a conversation. */
  readonly leftOut: LeftOutMessages;
  readonly readMarks: ReadMarks;
  readonly paths: ConversationPaths;
  /** Pinned, renamed, archived and Recently Deleted conversations (src/conversation-actions.ts). */
  readonly conversations: ConversationMarks;
  /** The clock Recently Deleted counts its 30 days by; tests move it. */
  clock: () => number = Date.now;
  private readonly memories: MemoryFacts;
  readonly review: MemoryReview;
  private governanceStore: SkillGovernance | undefined;
  private restoreHeldStore: RestoreHeld | undefined;
  private restoredTrunksStore: RestoredTrunks | undefined;
  private historyStore: WorkspaceHistory | undefined;
  readonly skills: InstalledSkills;
  readonly projects: Projects;
  /** Wave 6: labels and project notes, read-only share links, and the household's profiles. */
  readonly labels: Labels;
  /** FQ-collaboration: comments pinned to a moment in a media file. */
  readonly mediaComments: MediaComments;
  readonly shares: ShareLinks;
  readonly profiles: Profiles;
  /** Wave 7: which tools past tasks needed, and what has been learned about them. */
  readonly toolUsage: ToolUsage;
  private lockerStore: Locker | undefined;
  private secretsStore: Secrets | undefined;
  private receiptsStore: Receipts | undefined;
  private collabEventsStore: CollabEvents | undefined;
  /**
   * Set once the locker is open: every event is passed through it on the way to the log, so a
   * secret value can never be written down even if a tool put one in its result by mistake.
   */
  guardEvent: (data: Record<string, unknown>) => Record<string, unknown> = (data) => data;
  private auditStore: AuditLog | undefined;
  private spanStore: SpanStore | undefined;
  private closed = false;
  get sqlite() { return this.db; }
  /** False once the app has closed the database, so something still running can stop instead of reading it. */
  get isOpen(): boolean { return !this.closed; }
  /**
   * The folder the database lives in, which is also where things that belong to the owner rather
   * than to one piece of work are kept — their SOUL.md and USER.md, for instance, which should
   * follow them from one workspace to the next instead of being rewritten in each.
   */
  readonly folder: string;
  constructor(path: string) {
    this.folder = dirname(path);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        "PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
      );
    } catch (e) {
      this.db.close();
      // mac7/install-torture: a second Branch on the same folder is refused in words a person can act on.
      if (e instanceof Error && e.message.includes("locked"))
        throw new Error(
          `Branch is already open and using the work saved in ${this.folder}, so this second Branch stopped rather than write to the same files. Nothing was changed. `
            // mac7/smoke-fixes (B4): the sentence now says what does work, instead of leaving the
            // terminal looking broken while the window is open.
            + "These work against the Branch that is already open, from any terminal: branch status, branch doctor, branch token, "
            + "branch trace, branch schedule, branch approve, branch lockdown, branch permissions, branch theme, branch model, "
            + "branch gateway, and the places that only look (memory, usage, sessions, inbox, library, "
            + "settings, places, tools, skills, projects, snapshots, channels, mcp, customize, automations). "
            + "Anything else that writes to the saved work — backup, restore, security audit, activity verify — "
            + "needs that Branch closed first: close it and try again.",
        );
      throw e;
    }
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), owner TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_reads(message_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, read TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(run_id TEXT PRIMARY KEY REFERENCES tasks(id), estimated_input INTEGER NOT NULL DEFAULT 0, estimated_output INTEGER NOT NULL DEFAULT 0, reported_input INTEGER NOT NULL DEFAULT 0, reported_output INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS compactions(session_id TEXT PRIMARY KEY REFERENCES sessions(id), through_id INTEGER NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trigger_log(id INTEGER PRIMARY KEY AUTOINCREMENT, trigger_id TEXT NOT NULL, owner TEXT NOT NULL, run_id TEXT, payload_summary TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery_log(id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id TEXT NOT NULL, owner TEXT NOT NULL, event_type TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, next_retry_at TEXT, created_at TEXT NOT NULL);`);
    for (const table of ["memory", "specialists", "procedures", "schedules", "settings", "deliveries", "governance", "triggers", "webhooks", "workflows", "flow_graphs"])
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table}(id TEXT NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(id,owner));`,
      );
    if (!this.db.prepare("PRAGMA table_info(sessions)").all().some((row) => row.name === "temporary"))
      this.db.exec("ALTER TABLE sessions ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0");
    if (!this.db.prepare("PRAGMA table_info(tasks)").all().some((row) => row.name === "source"))
      this.db.exec("ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'web'");
    // Wave 8: which project a task was done under, so the figures can be counted per project.
    if (!this.db.prepare("PRAGMA table_info(tasks)").all().some((row) => row.name === "project"))
      this.db.exec("ALTER TABLE tasks ADD COLUMN project TEXT NOT NULL DEFAULT 'default'");
    // Parity B1: when each message was written, for the conversation's day stamps and "Sent at". Rows from before this
    // have none; every insert (a reply, a branch, an import) is stamped by the trigger unless it carries its own time.
    if (!this.db.prepare("PRAGMA table_info(messages)").all().some((row) => row.name === "created_at"))
      this.db.exec("ALTER TABLE messages ADD COLUMN created_at TEXT");
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS message_time_insert AFTER INSERT ON messages WHEN new.created_at IS NULL BEGIN
        UPDATE messages SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=new.id; END;`);
    // A conversation's latest task (src/session-library.ts projectOf) is found through this index, not a scan of every task.
    this.db.exec("CREATE INDEX IF NOT EXISTS tasks_session_created ON tasks(session_id, created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS events_run_kind ON events(run_id, kind, id)"); // exact task attribution without repeated history scans
    this.conversations = new ConversationMarks(this.db, () => this.clock());
    ensureThreadTable(this.db); // defaulttrunk: which Trunk each conversation is with (src/trunks/threads.ts), read by history
    ensureForgotten(this.db);
    this.labels = new Labels(this.db);
    this.mediaComments = new MediaComments(this.db);
    this.toolUsage = new ToolUsage(this.db);
    this.shares = new ShareLinks(this.db);
    this.profiles = new Profiles(this.db, "local");
    this.memories = new MemoryFacts(this.db);
    this.review = new MemoryReview(this.db, this.memories);
    this.skills = new InstalledSkills(this.db);
    this.projects = new Projects(this);
    this.migrateUsage();
    // The spans table is created up front, so the metrics page can count them from the first launch.
    void this.spans;
    this.history = new SessionHistory(this.db);
    this.branches = new SessionBranches(this.db, () => this.files);
    this.library = new SessionLibrary(this.db, () => this.files);
    this.summaries = new SessionSummaries(this.db);
    this.working = new WorkingSessions(this.db);
    this.leftOut = new LeftOutMessages(this.db);
    this.readMarks = new ReadMarks(this.db);
    this.paths = new ConversationPaths(this.db);
    this.recoverInterruptedRuns();
    this.interruptSchedules();
    this.interruptWorkflows();
    this.discardTemporarySessions();
    // The newest 20 000 spans are kept and the rest let go, once per launch, so a machine left
    // running for weeks does not grow a spans table without end.
    try { this.spans.prune("local"); } catch { /* tidying is never a reason not to start */ }
  }
  private migrateUsage(): void {
    const usageColumns = this.db
      .prepare("PRAGMA table_info(usage)")
      .all()
      .map((row) => row.name);
    // Prompt-cache reads and writes, as parts of reported_input, so each can be priced at its own rate (src/pricing.ts).
    for (const column of ["attempts", "unreported_calls", "incomplete_calls", "reported_cached_input", "reported_cache_write", "reported_cache_write_hour"])
      if (!usageColumns.includes(column))
        this.db.exec(
          `ALTER TABLE usage ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
        );
  }
  /** `agent` narrows to the conversations that agent took part in (src/history.ts); unset for the owner. */
  searchHistory(owner: string, input: Parameters<SessionHistory["search"]>[1], excludeSessionId?: string, agent?: string) {
    return this.history.search(owner, input, excludeSessionId, agent);
  }
  readHistory(owner: string, input: Parameters<SessionHistory["read"]>[1], excludeSessionId?: string, agent?: string) {
    return this.history.read(owner, input, excludeSessionId, agent);
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  branchSession(owner: string, input: Parameters<SessionBranches["branch"]>[1], agent?: string, before = false): ReturnType<SessionBranches["branch"]> {
    return this.branches.branch(owner, input, agent, before);
  }
  sessionView(owner: string, sessionId: string) {
    const view = this.branches.view(owner, sessionId), out = this.leftOut.ids(sessionId);
    const messages = out.size ? view.messages.map((m) => (out.has(m.messageId) ? { ...m, leftOut: true } : m)) : view.messages;
    return { ...view, messages, imported: this.library.imported(sessionId), temporary: this.sessionTemporary(sessionId) };
  }
  /** `agent` narrows the list to the conversations that agent took part in (src/history.ts); unset for the owner. */
  searchSessions(owner: string, input: unknown, agent?: string) {
    return this.library.search(owner, input, this.hiddenSessions().slice(0, 500), agent);
  }
  /** The recent conversations with what was last said in each, for picking one up on a phone. */
  recentSessions(owner: string, limit?: number, offset = 0) {
    return this.library.recent(owner, limit, this.hiddenSessions().slice(0, 500), undefined, offset);
  }
  /** A project's conversations, newest first, in the same shape as recentSessions (src/session-library.ts projectOf). */
  projectSessions(owner: string, project: string, limit = 100) {
    return this.library.recent(owner, limit, this.hiddenSessions().slice(0, 500), project);
  }
  /** How many conversations each project has, by project id. */
  projectSessionCounts(owner: string): Record<string, number> {
    return this.library.projectCounts(owner, this.hiddenSessions().slice(0, 500));
  }
  /**
   * phase2/rooms (integration review): conversations kept out of Recents and search. Set by
   * src/index.ts to each Trunk's side of a room, whose first message is the room's instructions to
   * that Trunk; the room itself is the conversation the owner opens.
   */
  hiddenSessions: () => readonly string[] = () => [];
  exportSession(owner: string, sessionId: string) {
    return this.library.export(owner, sessionId);
  }
  /** What a retention rule would sweep up, so the owner sees the list before anything is deleted. */
  prunableSessions(owner: string, days: number, megabytes: number, now = Date.now()) {
    return this.library.prunable(owner, days, megabytes, now);
  }
  /**
   * Batch 26 (wave 8): removes one conversation for good (the retention sweep, src/retention.ts), whether it was
   * temporary or not. Only the owner of it may, never while a task of it (or of a room's Trunks' sides) is running or
   * waiting on an answer, and by the same path as "Delete now", so what its tasks left goes with it.
   */
  forgetSession(owner: string, sessionId: string): { discarded: boolean; messages: number } {
    if (!this.ownsSession(owner, sessionId)) throw new Error("Conversation not found");
    if (this.conversationBusy(sessionId)) throw new Error(busyWords("delete"));
    return this.purgeForGood(sessionId);
  }
  /** Whether a conversation, or one that goes with it, has a task running or waiting on an answer. */
  conversationBusy(sessionId: string): boolean {
    return this.conversations.busy([sessionId, ...this.conversationCompanions(sessionId)]);
  }
  /**
   * Conversations that go with this one and share its fate: a room's Trunks' own sides (set by src/index.ts). Their
   * work counts as the room's when deleting, and they are removed for good with it.
   */
  conversationCompanions: (sessionId: string) => readonly string[] = () => [];
  /** Called before a conversation is removed for good, so a Trunk or room pointing at it is given another or removed. */
  beforeConversationPurge: (sessionId: string) => void = () => undefined;
  /** The files tasks kept beside the database (src/artifacts.ts), listed and removed with their conversation. */
  runFiles: { held(runIds: readonly string[]): { name: string; bytes: number }[]; forget(runIds: readonly string[]): void } =
    { held: () => [], forget: () => undefined };
  /** The files a conversation's messages carry (they live in its own folder beside the database), by name and size. */
  private attachedFiles(sessionId: string): { name: string; bytes: number }[] {
    return this.db.prepare("SELECT body FROM messages WHERE session_id=? AND body LIKE '%\"attachments\"%'").all(sessionId)
      .flatMap((row) => ((JSON.parse(String(row.body)) as Message).attachments ?? []).map((ref) => ({ name: ref.name, bytes: ref.bytes })));
  }
  private runIdsOf(sessionIds: readonly string[]): string[] {
    return this.db.prepare("SELECT id FROM tasks WHERE session_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(sessionIds)).map((row) => String(row.id));
  }
  pinConversation(owner: string, sessionId: string, input: unknown) { return this.conversations.pin(owner, sessionId, input); }
  renameConversation(owner: string, sessionId: string, input: unknown) { return this.conversations.rename(owner, sessionId, input); }
  archiveConversation(owner: string, sessionId: string, input: unknown) {
    return this.conversations.archive(owner, sessionId, input, this.conversationCompanions(sessionId));
  }
  deleteConversation(owner: string, sessionId: string) {
    return this.conversations.delete(owner, sessionId, this.conversationCompanions(sessionId));
  }
  restoreConversation(owner: string, sessionId: string) { return this.conversations.restore(owner, sessionId); }
  /** Archived and Recently Deleted, a page at a time. Reading them never removes anything (purgeExpiredConversations). */
  putAwayConversations(owner: string, input: unknown = {}) {
    return this.conversations.putAway(owner, input, this.hiddenSessions());
  }
  /** Exactly what "Delete now" removes, so the question can list it. */
  deleteNowPreview(owner: string, sessionId: string) {
    this.conversations.requireDeletable(owner, sessionId, this.conversationCompanions(sessionId));
    const ids = [sessionId, ...this.conversationCompanions(sessionId)], list = JSON.stringify(ids);
    const messages = Number(this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id IN (SELECT value FROM json_each(?))").get(list)?.n ?? 0);
    const runIds = this.runIdsOf(ids), residue = findResidue(this.db, runIds);
    return { sessionId, messages, tasks: runIds.length, files: [...ids.flatMap((id) => this.attachedFiles(id)), ...this.runFiles.held(runIds)],
      todos: residue.todos.map((todo) => todo.text),
      cards: residue.cards.map((card) => card.title), versions: residue.versions.map((version) => version.path),
      facts: [...residue.facts.map((fact) => fact.text), ...residue.copies], outside: residue.outside };
  }
  /** "Delete now": removes one conversation in Recently Deleted for good, with what goes with it. */
  deleteConversationNow(owner: string, sessionId: string) {
    const preview = this.deleteNowPreview(owner, sessionId);
    this.purgeForGood(sessionId);
    return { deleted: true, messages: preview.messages, tasks: preview.tasks, files: preview.files.length,
      facts: preview.facts.length, todos: preview.todos.length, cards: preview.cards.length, versions: preview.versions.length,
      outside: preview.outside };
  }
  /** "Delete all": empties this person's Recently Deleted. A conversation with work still going is left, and counted. */
  emptyRecentlyDeleted(owner: string) {
    const ids = this.conversations.deletedIds(owner);
    const busy = ids.filter((id) => this.conversationBusy(id));
    for (const id of ids) if (!busy.includes(id)) this.purgeForGood(id);
    return { deleted: ids.length - busy.length, kept: busy.length };
  }
  /**
   * The engine's own upkeep (src/index.ts, at start and every hour; no route calls it): removes every conversation whose
   * 30 days in Recently Deleted are over, unless it has work still going, and writes each one's title to the audit record.
   */
  purgeExpiredConversations(): number {
    let removed = 0;
    for (const id of this.conversations.expired()) {
      if (this.conversationBusy(id)) continue;
      const owner = String(this.db.prepare("SELECT owner FROM sessions WHERE id=?").get(id)?.owner ?? "");
      audit(this, owner || "local", { action: "history.pruned", actor: "Recently Deleted", subject: this.conversations.titleOf(id).slice(0, 300),
        reason: "Its 30 days in Recently Deleted were over", outcome: "deleted" });
      this.purgeForGood(id);
      removed += 1;
    }
    return removed;
  }
  /**
   * privacy (Settings › Your data, Delete everything): removes one of this person's conversations for good, wherever it
   * is (Recent, Archived or Recently Deleted), exactly as "Delete now" does, with what goes with it. Work still going
   * refuses it.
   */
  deleteConversationForGood(owner: string, sessionId: string): void {
    if (!this.ownsSession(owner, sessionId)) throw new Error("Conversation not found");
    if (this.conversations.busy([sessionId, ...this.conversationCompanions(sessionId)]))
      throw new Error("A task is still working. Stop it or wait for it, then try again.");
    this.purgeForGood(sessionId);
  }
  /** Every way a conversation is removed for good goes through here: Delete now, Delete all, the 30 days, retention, discard. */
  private purgeForGood(sessionId: string): { discarded: boolean; messages: number } {
    const companions = [...this.conversationCompanions(sessionId)], runIds = this.runIdsOf([sessionId, ...companions]);
    const residue = findResidue(this.db, runIds), at = new Date(this.clock()).toISOString();
    this.beforeConversationPurge(sessionId);
    const result = this.purgeSession(sessionId);
    for (const id of companions) if (this.db.prepare("SELECT 1 AS found FROM sessions WHERE id=?").get(id)) this.purgeSession(id);
    const step = this.openStep("purge_residue");
    try {
      forgetResidue(this.db, runIds, residue);
      // Kept as digests, so an older backup put back over this install cannot bring it back to Recent (src/conversation-residue.ts).
      rememberForgotten(this.db, [sessionId, ...companions], runIds, at);
      this.closeStep(step);
    } catch (error) { this.undoStep(step); throw error; }
    this.afterCommit(() => this.runFiles.forget(runIds));
    return result;
  }
  importSession(owner: string, input: unknown) {
    return this.library.import(owner, input);
  }
  duplicateSession(owner: string, sessionId: string): Promise<{ sessionId: string; copiedMessages: number }> {
    return this.library.duplicate(owner, sessionId);
  }
  createRun(owner: string, prompt: string, sessionId?: string, temporary = false, source = "web", project?: string): Run {
    const now = new Date().toISOString();
    if (
      sessionId &&
      !this.db
        .prepare("SELECT id FROM sessions WHERE id=? AND owner=?")
        .get(sessionId, owner)
    )
      throw new Error("Session not found");
    if (sessionId) {
      this.reconcileMessages(sessionId, "previous run interruption");
      // A new message in an archived or deleted conversation brings it back to Recent, as a new text does in iMessage.
      this.conversations.revive(sessionId);
    }
    const session = sessionId ?? randomUUID();
    this.db
      .prepare("INSERT OR IGNORE INTO sessions(id,owner,created_at,temporary) VALUES(?,?,?,?)")
      .run(session, owner, now, Number(temporary));
    const run: Run = {
      id: randomUUID(),
      sessionId: session,
      owner,
      prompt,
      status: "running",
      output: "",
      createdAt: now,
      updatedAt: now,
      // The project a task was done under is settled when it starts and never changes afterwards. Dogfood D14: a
      // conversation stays in its own project, so opening another project never moves an older conversation into it
      // (nor lends it that project's instructions); only a new conversation starts in the active one.
      project: project ?? (sessionId ? this.sessionProject(sessionId) : undefined) ?? this.projects.active(owner).id,
    };
    this.db
      .prepare("INSERT INTO tasks(id,session_id,owner,prompt,status,output,created_at,updated_at,source,project) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(run.id, session, owner, prompt, run.status, "", now, now, source, run.project!);
    this.db.prepare("INSERT INTO usage(run_id) VALUES(?)").run(run.id);
    return run;
  }
  /** The project a conversation is in: the one its latest task ran under, or undefined before its first task. */
  sessionProject(sessionId: string): string | undefined {
    const row = this.db.prepare("SELECT project FROM tasks WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(sessionId);
    return row?.project == null ? undefined : String(row.project);
  }
  run(id: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    return row ? this.toRun(row) : undefined;
  }
  /** Opens the secrets locker with a key source; values stay encrypted in the database. */
  openLocker(keys: LockerKeySource): Locker {
    this.receiptsStore ??= new Receipts(keys);
    // Collaboration events are signed per member; a member is the owner or a profile on this computer.
    this.collabEventsStore ??= new CollabEvents(this.db, keys,
      () => [ownerMember, ...this.profiles.list().map((profile) => profile.id)]);
    this.lockerStore ??= new Locker(this.db, keys);
    this.secretsStore ??= new Secrets(this.db, this.lockerStore);
    return this.lockerStore;
  }
  /** References, replacement dates, the use audit and the shared scrubber, in front of the locker. */
  get secrets(): Secrets {
    if (!this.secretsStore) throw new Error("The secrets locker is not open in this launch");
    return this.secretsStore;
  }
  /** Every table of the person's state, for a backup file; secrets are left out (device-bound key). */
  backup(appVersion: string) { return exportBackup(this.db, appVersion); }
  /** Restores a backup into a fresh install; refuses when this copy already has state. */
  /**
   * Q168 B: what a restore held for the owner's yes is added to the waiting list, and the answer says what is
   * waiting, so the window and `branch restore` can both say so.
   */
  restore(input: unknown, options: RestoreOptions = {}) {
    const { held, replaced, ...result } = importBackup(this.db, input, options);
    // #484: setup's untouched Trunks gave way to the backup's; written down, one entry per owner, with their names.
    for (const owner of new Set(replaced.map((trunk) => trunk.owner))) {
      const names = replaced.filter((trunk) => trunk.owner === owner).map((trunk) => trunk.name);
      audit(this, owner, { action: "data.imported", actor: owner, subject: "a backup, over setup's first Trunks",
        reason: `Setup's Trunks nobody had written to (${names.join(", ")}) and their introductions were replaced by the backup`, outcome: "saved" });
    }
    return { ...result, held: this.restoreHeld.merge(held), replaced: replaced.map((trunk) => trunk.name) };
  }
  /** Rows from a restore waiting for the owner's yes (src/restore-held.ts). */
  get restoreHeld(): RestoreHeld {
    return (this.restoreHeldStore ??= new RestoreHeld(this));
  }
  /** #484: the Trunks a restore brought back cut down, each waiting for the owner to give back what it had. */
  get restoredTrunks(): RestoredTrunks {
    return (this.restoredTrunksStore ??= new RestoredTrunks(this));
  }
  /** Skill failure patterns, exclusions, demotion, benchmarks and drafts for this owner. */
  get governance(): SkillGovernance {
    return (this.governanceStore ??= new SkillGovernance(this, "local"));
  }
  governanceFor(owner: string): SkillGovernance { return owner === "local" ? this.governance : new SkillGovernance(this, owner); }
  /** Completed top-level runs created after a moment, oldest first, for consolidation. */
  runsSince(owner: string, after: string, limit = 20): Run[] {
    return this.db.prepare("SELECT * FROM tasks WHERE owner=? AND status='completed' AND created_at>? ORDER BY created_at ASC LIMIT ?").all(owner, after, limit).map((row) => this.toRun(row));
  }
  /** phase2/delight: counts of the owner's own finished work, for achievements (src/achievement-tallies.ts).
   *  `scan` carries the events already counted and is moved on by at most one batch. */
  achievementTallies(owner: string, scan: EventScan, aside: readonly string[] = []): { tallies: AchievementTallies; caughtUp: boolean } {
    return achievementTallies(this.db, owner, scan, aside);
  }
  /** Workspace file history and snapshots for the given workspace. */
  openWorkspaceHistory(files: WorkspaceFiles, owner: string): WorkspaceHistory {
    return (this.historyStore ??= new WorkspaceHistory(this.db, files, owner));
  }
  get workspaceHistory(): WorkspaceHistory {
    if (!this.historyStore) throw new Error("Workspace history is not open in this launch");
    return this.historyStore;
  }
  /** Signs and verifies tool-success receipts with a key derived from the locker key. */
  get receipts(): Receipts {
    if (!this.receiptsStore) throw new Error("Receipts need the secrets locker to be open");
    return this.receiptsStore;
  }
  /** Signed collaboration events, published under a household member. */
  get collabEvents(): CollabEvents {
    if (!this.collabEventsStore) throw new Error("Collaboration events need the secrets locker to be open");
    return this.collabEventsStore;
  }
  get locker(): Locker {
    if (!this.lockerStore) throw new Error("The secrets locker is not open in this launch");
    return this.lockerStore;
  }
  /** The append-only record of what the assistant was allowed to do. */
  get audit(): AuditLog {
    return (this.auditStore ??= new AuditLog(this.db));
  }
  sessionTemporary(sessionId: string): boolean {
    return Number(this.db.prepare("SELECT temporary FROM sessions WHERE id=?").get(sessionId)?.temporary ?? 0) === 1;
  }
  /** Overview: marks a task the engine started on its own (a conversation's opening row, a Trunk's introduction, reading
      a schedule, a learning pass), so GET /api/state can set it aside by where it came from, never by its words. */
  markAside(runId: string, options: { recent?: false } = {}): void {
    this.event(runId, "run.aside", options);
  }
  /**
   * DESIGN-DIRECTION PR 2: each task's plain title for lists: the one the engine gave it (`run.titled`, a room turn's),
   * else its prompt's whole first line (a list shows a task's words whole and wraps them; each list cuts for itself).
   * One query for the whole list.
   */
  runTitles(runs: readonly Run[]): Map<string, string> {
    const given = new Map(this.db.prepare("SELECT run_id AS id, json_extract(data,'$.title') AS title FROM events WHERE kind='run.titled' AND run_id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(runs.map((run) => run.id))).map((row) => [String(row.id), String(row.title ?? "")]));
    return new Map(runs.map((run) => [run.id, given.get(run.id) || run.prompt.split(/\r?\n/)[0]!]));
  }
  /** fix399: whether the engine marked this task's conversation to stay out of Recent and search (markAside recent: false). */
  keptFromRecent(runId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM events WHERE run_id=? AND kind='run.aside' AND json_extract(data,'$.recent')=0").get(runId);
  }
  /** Overview (GET /api/state): of these tasks, the ones the engine marked as its own (markAside), the ones another task
      started (a helper, or a learning pass: "run.started" names a parent) and the ones in a temporary conversation (a
      small decision, a temporary chat), in two queries for the whole list. */
  engineOwnRuns(ids: readonly string[]): Set<string> {
    const list = JSON.stringify(ids), rows = [
      ...this.db.prepare("SELECT DISTINCT run_id AS id FROM events WHERE (kind='run.aside' OR (kind='run.started' AND json_extract(data,'$.parentRunId') IS NOT NULL)) AND run_id IN (SELECT value FROM json_each(?))").all(list),
      ...this.db.prepare("SELECT t.id AS id FROM tasks t JOIN sessions s ON s.id=t.session_id WHERE s.temporary=1 AND t.id IN (SELECT value FROM json_each(?))").all(list),
    ];
    return new Set(rows.map((row) => String(row.id)));
  }
  /** Removes a temporary conversation and everything recorded for it; nothing of it remains searchable. */
  discardSession(owner: string, sessionId: string): { discarded: boolean; messages: number } {
    if (!this.ownsSession(owner, sessionId)) throw new Error("Conversation not found");
    if (!this.sessionTemporary(sessionId)) throw new Error("Only temporary conversations can be discarded");
    if (this.conversationBusy(sessionId)) throw new Error(busyWords("delete"));
    return this.purgeForGood(sessionId);
  }
  private purgeSession(sessionId: string): { discarded: boolean; messages: number } {
    const runIds = JSON.stringify(this.db.prepare("SELECT id FROM tasks WHERE session_id=?").all(sessionId).map((row) => String(row.id)));
    const step = this.openStep("purge_session");
    try {
      // Q63: an open team task this conversation held part of is marked as such, in this transaction and
      // before its events go (the mark follows each run's own record up to its turn).
      markDeletedTurnParts(this.db, sessionId);
      this.db.prepare("DELETE FROM events WHERE run_id IN (SELECT id FROM tasks WHERE session_id=?)").run(sessionId);
      this.db.prepare("DELETE FROM usage WHERE run_id IN (SELECT id FROM tasks WHERE session_id=?)").run(sessionId);
      // Wave 7: what this conversation taught about which tools a request needs goes with it.
      this.toolUsage.forgetSession(sessionId);
      // Q61: a team task keeps no copy of the answers this conversation held (read before its runs go).
      forgetTeamResults(this.db, sessionId);
      this.db.prepare("DELETE FROM tasks WHERE session_id=?").run(sessionId);
      const messages = this.db.prepare("DELETE FROM messages WHERE session_id=?").run(sessionId).changes;
      this.db.prepare("DELETE FROM message_reads WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM compactions WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM session_pins WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM session_left_out WHERE session_id=?").run(sessionId);
      this.readMarks.forgetSession(sessionId);
      this.paths.forgetSession(sessionId);
      // Pass 17: a path, or the conversation paths came off, can be thrown away; what came off it stands alone.
      this.db.prepare("DELETE FROM session_branches WHERE session_id=? OR parent_session_id=?").run(sessionId, sessionId);
      this.db.prepare("DELETE FROM session_summaries WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM session_work WHERE session_id=?").run(sessionId);
      this.forgetConversationRows(sessionId, runIds);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
      this.closeStep(step);
      this.afterCommit(() => { for (const listener of this.sessionClosedListeners) try { listener(sessionId); } catch { /* never fails a discard */ } });
      return { discarded: true, messages: Number(messages) };
    } catch (error) { this.undoStep(step); throw error; }
  }
  /**
   * The rest of what names a conversation or its tasks: where it came from, its share links, labels, name and pin, its
   * waiting line, rewinds, snapshots, undo, token count and the traces of its tasks. A table another part opens later is
   * left alone when it is not there. Kept on purpose: the append-only records (audit, activity_chain), which are
   * chained and name a task only by id, and whatever a task wrote into the owner's own folders or lists.
   */
  private forgetConversationRows(sessionId: string, runIds: string): void {
    const has = (table: string) => !!this.db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name=?").get(table);
    for (const table of ["session_origins", "conversation_shares", "memory_suppressions", "session_tokens", "rewinds", "workspace_undo", "conversation_marks", "trunk_threads"])
      if (has(table)) this.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
    if (has("labels")) this.db.prepare("DELETE FROM labels WHERE target='conversation' AND target_id=?").run(sessionId);
    if (has("run_queue")) this.db.prepare("DELETE FROM run_queue WHERE session_id=? OR run_id IN (SELECT value FROM json_each(?))").run(sessionId, runIds);
    if (has("turn_snapshots")) this.db.prepare("DELETE FROM turn_snapshots WHERE session_id=? OR run_id IN (SELECT value FROM json_each(?))").run(sessionId, runIds);
    if (has("spans")) this.db.prepare("DELETE FROM spans WHERE run_id IN (SELECT value FROM json_each(?))").run(runIds);
  }
  private discardTemporarySessions(): void {
    for (const row of this.db.prepare("SELECT id FROM sessions WHERE temporary=1").all())
      this.purgeSession(String(row.id));
  }
  /** An empty conversation with no task in it, for history the app writes itself. */
  createSession(owner: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO sessions(id,owner,created_at,temporary) VALUES(?,?,?,0)").run(id, owner, new Date().toISOString());
    return id;
  }
  /**
   * Wave 6: files a conversation and its tasks under another person in this household, so a task
   * started while somebody's profile is switched on lands in their list and not the owner's.
   */
  reassignSession(sessionId: string, toOwner: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE sessions SET owner=? WHERE id=?").run(toOwner, sessionId);
      this.db.prepare("UPDATE tasks SET owner=? WHERE session_id=?").run(toOwner, sessionId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  ownsSession(owner: string, sessionId: string): boolean {
    return !!this.db.prepare("SELECT id FROM sessions WHERE id=? AND owner=?").get(sessionId, owner);
  }
  runs(owner: string): Run[] {
    return this.db
      .prepare(
        // A conversation in Recently Deleted keeps its tasks, out of sight with it.
        "SELECT * FROM tasks WHERE owner=? AND session_id NOT IN (SELECT session_id FROM conversation_marks WHERE deleted_at IS NOT NULL) ORDER BY created_at DESC, rowid DESC LIMIT 100",
      )
      .all(owner)
      .map((row) => this.toRun(row));
  }
  /** models-ui: this person's task ids started since then, newest first, at most `limit` (Settings › Data & usage, by Trunk). */
  taskIdsSince(owner: string, since: string, limit: number): string[] {
    return this.db.prepare("SELECT id FROM tasks WHERE owner=? AND created_at >= ? ORDER BY created_at DESC LIMIT ?")
      .all(owner, since, limit).map((row) => String(row.id));
  }
  /** Weekly recap: finish time includes a task started earlier; deleted conversations remain out of sight. */
  completedRunsBetween(owner: string, since: string, until: string, limit: number): Run[] {
    return this.db.prepare("SELECT * FROM tasks WHERE owner=? AND status='completed' AND updated_at>=? AND updated_at<=? "
      + "AND session_id NOT IN (SELECT session_id FROM conversation_marks WHERE deleted_at IS NOT NULL) "
      + "ORDER BY updated_at DESC, rowid DESC LIMIT ?")
      .all(owner, since, until, limit).map((row) => this.toRun(row));
  }
  /** Original Trunk attribution for an already owner-scoped list, read once rather than loading every task's events. */
  runTrunkIds(ids: readonly string[]): Map<string, string> {
    const rows = this.db.prepare("SELECT run_id, json_extract(data,'$.trunkId') AS trunk FROM events "
      + "WHERE kind='trunk.turn' AND run_id IN (SELECT value FROM json_each(?)) ORDER BY id")
      .all(JSON.stringify(ids));
    const trunks = new Map<string, string>();
    for (const row of rows) if (typeof row.trunk === "string" && row.trunk && !trunks.has(String(row.run_id)))
      trunks.set(String(row.run_id), row.trunk);
    return trunks;
  }
  /** Settings › Permissions › Messages per conversation per hour: how many tasks a conversation started since then. */
  sessionTasksSince(sessionId: string, since: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE session_id=? AND created_at >= ?").get(sessionId, since) as { n: number }).n);
  }
  /** Every task in one of this person's conversations, id and status only, without the recent-task window's limit (DG-101). */
  sessionRuns(owner: string, sessionId: string): { id: string; status: string }[] {
    return this.db.prepare("SELECT id, status FROM tasks WHERE session_id=? AND owner=? ORDER BY created_at")
      .all(sessionId, owner).map((row) => ({ id: String(row.id), status: String(row.status) }));
  }
  /** Running or waiting work that is still the newest task in its conversation. */
  activeRuns(owner: string): Run[] {
    return this.db.prepare(`SELECT current.* FROM tasks current
      WHERE current.owner=? AND current.status IN ('running','needs_input')
        AND NOT EXISTS (SELECT 1 FROM tasks newer
          WHERE newer.owner=current.owner AND newer.session_id=current.session_id
            AND (newer.created_at > current.created_at
              OR (newer.created_at = current.created_at AND newer.rowid > current.rowid)))
      ORDER BY current.created_at DESC`).all(owner).map((row) => this.toRun(row));
  }
  /**
   * Q51: each conversation's newest task when it waits for the owner: it stopped to ask (`needs_input`) or Branch
   * closed on it and it can be continued (`interrupted`). Read on its own, so a task still waiting stays listed however
   * much other history comes after it; at most `limit`, newest first.
   */
  waitingRuns(owner: string, limit = 50): Run[] {
    return this.db.prepare(`SELECT current.* FROM tasks current
      WHERE current.owner=? AND current.status IN ('needs_input','interrupted')
        AND NOT EXISTS (SELECT 1 FROM tasks newer
          WHERE newer.owner=current.owner AND newer.session_id=current.session_id
            AND (newer.created_at > current.created_at
              OR (newer.created_at = current.created_at AND newer.rowid > current.rowid)))
      ORDER BY current.created_at DESC LIMIT ?`).all(owner, limit).map((row) => this.toRun(row));
  }
  /** The newest message written in one conversation, by anyone, or 0 when there is none (NAS 3fd7700). */
  lastMessageId(sessionId: string): number {
    const row = this.db.prepare("SELECT MAX(id) AS id FROM messages WHERE session_id=?").get(sessionId) as { id: number | null } | undefined;
    return Number(row?.id ?? 0);
  }
  /** The newest task in one conversation (A6, NAS 166fbe3), read on its own, however much other work came after it. */
  newestIn(owner: string, sessionId: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE owner=? AND session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(owner, sessionId);
    return row ? this.toRun(row) : undefined;
  }
  /**
   * Q050: a task that stopped to ask goes on working under its own id once it is answered. Only a task still waiting
   * is taken back up, in one step, so a second answer to the same question never revives a task that has moved on.
   */
  reopenAsked(id: string): Run | undefined {
    const changed = this.db.prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=? AND status='needs_input'")
      .run(new Date().toISOString(), id);
    return Number(changed.changes) === 1 ? this.run(id) : undefined;
  }
  finish(id: string, status: RunStatus, output: string, options: { mend?: boolean } = {}): Run {
    const run = this.run(id);
    if (!run) throw new Error("Run not found");
    // unhold-control: a run that wrote nothing into its conversation (a command pressed by hand) leaves the transcript alone.
    const known = status === "needs_input" ? this.askedCall(id) : undefined;
    const added = options.mend === false ? 0 : this.reconcileMessages(run.sessionId, status, known);
    // QA R1: an approved call the engine ran that then asked the person in words itself: its earlier "not run" result
    // gives way to the question's, so the model reads what is true now.
    if (options.mend !== false) for (const [callId, content] of known ?? []) if (content !== notRunResult) this.replaceNotRun(run.sessionId, callId, content);
    if (added) this.event(id, "session.reconciled", { added, reason: status });
    // NAS 3fd7700: where the conversation stood when this task stopped to ask, so a yes carries it on only while
    // nothing else (a heartbeat's note, a Trunk routine's report) has been written there since.
    if (status === "needs_input") this.event(id, "run.stopped_to_ask", { lastMessageId: this.lastMessageId(run.sessionId) });
    this.db
      .prepare("UPDATE tasks SET status=?,output=?,updated_at=? WHERE id=?")
      .run(status, output, new Date().toISOString(), id);
    // A task waiting on the owner's answer is not over, so nothing it started is taken away yet.
    if (status !== "needs_input" && status !== "running")
      for (const listener of this.runFinishedListeners) try { listener(id, status); } catch { /* never fails a finish */ }
    return this.run(id)!;
  }
  message(sessionId: string, message: Message, sourceId?: number, createdAt?: string | null): number {
    const result = this.db
      .prepare("INSERT INTO messages(session_id,body,source_id,created_at) VALUES(?,?,?,?)")
      .run(sessionId, JSON.stringify(message), sourceId ?? null, createdAt ?? null);
    return Number(result.lastInsertRowid);
  }
  /**
   * Messages the model should see: a summary of compacted history, then everything after it, plus
   * any earlier message the owner pinned so it is never folded away.
   */
  workingMessages(sessionId: string): { summary: string | null; rows: { id: number; message: Message }[] } {
    const compaction = this.db.prepare("SELECT through_id, summary FROM compactions WHERE session_id=?").get(sessionId);
    const after = compaction ? Number(compaction.through_id) : 0;
    const pinned = [...this.summaries.pinnedMessageIds(sessionId)];
    const keep = pinned.length ? ` OR id IN (${pinned.map(() => "?").join(",")})` : "";
    // Pass 17: a message the owner left out of context stays in the conversation but is never sent.
    const rows = this.db.prepare(`SELECT id, body FROM messages WHERE session_id=? AND (id>?${keep})
        AND COALESCE(source_id,id) NOT IN (SELECT source_id FROM session_left_out WHERE session_id=?) ORDER BY id`)
      .all(sessionId, after, ...pinned, sessionId)
      .map((row) => ({ id: Number(row.id), message: JSON.parse(String(row.body)) as Message }));
    // attach-anything: what was read out of a message's files goes to the model after the message, and only here.
    const reads = new Map(this.db.prepare("SELECT message_id, read FROM message_reads WHERE session_id=?").all(sessionId)
      .map((row) => [Number(row.message_id), String(row.read)]));
    for (const row of rows) if (reads.has(row.id)) row.message = { ...row.message, content: row.message.content + reads.get(row.id) };
    return { summary: compaction ? String(compaction.summary) : null, rows };
  }
  /**
   * attach-anything: what Branch read out of a message's files (words, a transcript), kept beside the message rather
   * than in it. A message is read back by many ways out (the window, exports, copies, a script's key); the words of the
   * files are for the model alone, so they never ride along with the message itself.
   */
  saveRead(sessionId: string, messageId: number, read: string): void {
    this.db.prepare("INSERT OR REPLACE INTO message_reads(message_id, session_id, read) VALUES(?,?,?)").run(messageId, sessionId, read);
  }
  /** Message rows the owner pinned in this conversation, by their current row identifier. */
  pinnedMessageIds(sessionId: string): Set<number> { return this.summaries.pinnedMessageIds(sessionId); }
  sessionSummary(owner: string, sessionId: string) {
    if (!this.ownsSession(owner, sessionId)) throw new Error("Conversation not found");
    const saved = this.summaries.get(sessionId);
    return { sessionId, summary: saved?.summary ?? null, text: saved?.text ?? "", createdAt: saved?.createdAt ?? null,
      pins: this.summaries.pins(sessionId), working: this.working.line(sessionId) };
  }
  saveSessionSummary(owner: string, sessionId: string, summary: SessionSummary | null, text: string) {
    return this.summaries.save(owner, sessionId, summary, text);
  }
  pinMessage(owner: string, sessionId: string, messageId: number, pinned: boolean) {
    if (!this.ownsSession(owner, sessionId)) throw new Error("Conversation not found");
    return this.summaries.setPinned(sessionId, messageId, pinned);
  }
  noteWorking(owner: string, sessionId: string, patch: WorkingNote) { return this.working.note(owner, sessionId, patch); }
  saveCompaction(sessionId: string, throughId: number, summary: string): void {
    this.db.prepare(`INSERT INTO compactions VALUES(?,?,?,?) ON CONFLICT(session_id)
      DO UPDATE SET through_id=excluded.through_id, summary=excluded.summary, created_at=excluded.created_at`)
      .run(sessionId, throughId, summary, new Date().toISOString());
  }
  messages(sessionId: string): Message[] {
    return this.db
      .prepare("SELECT body FROM messages WHERE session_id=? ORDER BY id")
      .all(sessionId)
      .map((row) => JSON.parse(String(row.body)) as Message);
  }
  /**
   * QA (first task): a call stopped before execution to ask the person never ran. Its result says so, and what to do after
   * the answer, instead of "side effects may have occurred", which told qwen3:14b the opposite of the note that carries
   * the task on after a yes (Runtime.continueNote), so it asked the person again whether to start. Approvals raised after
   * execution started preserve the unknown result, because the outer tool may already have had side effects.
   */
  private askedCall(runId: string): ReadonlyMap<string, string> {
    const events = this.events(runId);
    const callId = events.filter((event) => event.kind === "attention.needed").at(-1)?.data.callId;
    if (typeof callId !== "string") return new Map();
    if (events.some((event) => event.kind === "policy.execution_unknown" && event.data.id === callId)) return new Map();
    // QA R1: the engine runs an approved call again under its own id, so only a policy question after the call last
    // started is the one it stopped on; one before it was answered, and the call then asked in words itself.
    const lastStart = events.filter((event) => event.kind === "tool.started" && event.data.id === callId).at(-1)?.id ?? 0;
    const approval = events.some((event) => event.kind === "policy.ask" && event.data.id === callId && event.id > lastStart);
    return new Map([[callId, approval ? notRunResult
      : JSON.stringify({ ok: false, status: "waiting", outcome: "asked", error: "The question was put to the person. Their answer is their next message." })]]);
  }
  /**
   * After the person answers, the asking call's "not run" result says what they answered, so the model reads the same
   * thing in its transcript as in the note that carries the task on. Only that recorded result is ever rewritten.
   */
  answerAskedCall(sessionId: string, callId: string, allowed: boolean): boolean {
    const rows = this.db.prepare("SELECT id, body FROM messages WHERE session_id=? ORDER BY id DESC").all(sessionId);
    for (const row of rows) {
      const body = JSON.parse(String(row.body)) as Message;
      if (body.role !== "tool" || body.toolCallId !== callId) continue;
      if (!String(body.content ?? "").includes('"outcome":"not_run"')) return false;
      const content = JSON.stringify(allowed
        ? { ok: false, status: "allowed", outcome: "not_run", error: "The person said yes to this call. It has not run yet: make this same call again now, exactly as before." }
        : { ok: false, status: "refused", outcome: "not_run", error: "The person said no to this call. It did not run and will not; do not make it again." });
      this.db.prepare("UPDATE messages SET body=? WHERE id=?").run(JSON.stringify({ ...body, content }), Number(row.id));
      return true;
    }
    return false;
  }
  /**
   * QA R1: the stored result of one call, replaced with what the engine now knows (the approved call it ran itself after the
   * owner's yes). Only the newest result for that call is written; false when the conversation holds none.
   */
  setToolResult(sessionId: string, callId: string, content: string): boolean {
    const rows = this.db.prepare("SELECT id, body FROM messages WHERE session_id=? ORDER BY id DESC").all(sessionId);
    for (const row of rows) {
      const body = JSON.parse(String(row.body)) as Message;
      if (body.role !== "tool" || body.toolCallId !== callId) continue;
      this.db.prepare("UPDATE messages SET body=? WHERE id=?").run(JSON.stringify({ ...body, content }), Number(row.id));
      return true;
    }
    return false;
  }
  /** QA R1: the newest result of `callId`, replaced with `content` only while it is still the "not run" placeholder. */
  private replaceNotRun(sessionId: string, callId: string, content: string): void {
    const rows = this.db.prepare("SELECT id, body FROM messages WHERE session_id=? ORDER BY id DESC").all(sessionId);
    for (const row of rows) {
      const body = JSON.parse(String(row.body)) as Message;
      if (body.role !== "tool" || body.toolCallId !== callId) continue;
      if (String(body.content ?? "").includes(notRunMark)) this.db.prepare("UPDATE messages SET body=? WHERE id=?").run(JSON.stringify({ ...body, content }), Number(row.id));
      return;
    }
  }
  reconcileMessages(sessionId: string, reason: string, known?: ReadonlyMap<string, string>): number {
    const rows = this.db.prepare("SELECT id,body,source_id,created_at FROM messages WHERE session_id=? ORDER BY id").all(sessionId);
    const sources = new Map(rows.map((row) => [JSON.parse(String(row.body)) as Message, Number(row.source_id)]));
    // attach-anything: what was read out of a message's files follows the message to its new row.
    const oldIds = new Map([...sources.keys()].map((message, i) => [message, Number(rows[i]!.id)]));
    // A repaired transcript keeps when each message was first written.
    const times = new Map([...sources.keys()].map((message, i) => [message, rows[i]!.created_at == null ? null : String(rows[i]!.created_at)]));
    const repaired = reconcileTranscript([...sources.keys()], reason, known);
    if (!repaired.added) return 0;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM messages WHERE session_id=?").run(sessionId);
      const moveRead = this.db.prepare("UPDATE message_reads SET message_id=? WHERE message_id=? AND session_id=?");
      for (const message of repaired.messages) {
        const id = this.message(sessionId, message, sources.get(message), times.get(message));
        const was = oldIds.get(message);
        if (was !== undefined) moveRead.run(id, was, sessionId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return repaired.added;
  }
  private readonly sessionClosedListeners = new Set<(sessionId: string) => void>();
  /**
   * Called when a conversation is thrown away, so anything held open for it (a program left
   * running, for instance) goes with it. Listeners must not throw and are never awaited.
   */
  /**
   * The files conversations hold. A copy of a conversation needs its own copy of them, so branching,
   * duplicating and importing ask this for it. It is set once, when the app is built, because the
   * store is opened before the folder the files live in is: a store used without it can still read
   * and write conversations, and refuses to make a copy of one that holds files rather than make a
   * copy that cannot open them.
   */
  files: ConversationFiles | null = null;
  useFiles(files: ConversationFiles): void { this.files = files; }
  onSessionClosed(listener: (sessionId: string) => void): () => void {
    this.sessionClosedListeners.add(listener);
    return () => { this.sessionClosedListeners.delete(listener); };
  }
  private readonly runFinishedListeners = new Set<(runId: string, status: RunStatus) => void>();
  /**
   * Called when a task is over for good, so anything it started and nobody asked to keep — a
   * language server, a program being debugged — goes with it. A task that has only stopped to ask
   * the owner something is not over, so this is not called for it. Listeners must not throw and are
   * never awaited.
   */
  onRunFinished(listener: (runId: string, status: RunStatus) => void): () => void {
    this.runFinishedListeners.add(listener);
    return () => { this.runFinishedListeners.delete(listener); };
  }
  private readonly eventListeners = new Set<(runId: string, kind: string, data: Record<string, unknown>) => void>();
  /** Called after every stored event; listeners must not throw and are never awaited. */
  onEvent(listener: (runId: string, kind: string, data: Record<string, unknown>) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }
  event(runId: string, kind: string, input: Record<string, unknown>): void {
    this.eventUnannounced(runId, kind, input)();
  }
  /**
   * Q61: writes the event row now and hands back the announcement to listeners, for a caller that
   * writes it inside a transaction and must only tell anyone once that transaction has committed.
   */
  eventUnannounced(runId: string, kind: string, input: Record<string, unknown>): () => void {
    const data = this.guardEvent(input);
    this.db
      .prepare(
        "INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)",
      )
      .run(runId, kind, JSON.stringify(data), new Date().toISOString());
    return () => {
      for (const listener of this.eventListeners) { try { listener(runId, kind, data); } catch { /* a listener must never break the caller */ } }
    };
  }
  events(runId: string): Event[] {
    return this.db
      .prepare("SELECT * FROM events WHERE run_id=? ORDER BY id LIMIT 2000")
      .all(runId)
      .map((row) => ({
        id: Number(row.id),
        runId: String(row.run_id),
        kind: String(row.kind),
        data: JSON.parse(String(row.data)),
        createdAt: String(row.created_at),
      }));
  }
  /** A bounded event-log snapshot: callers retain this high-water mark across pages. */
  eventLogEnd(runId: string): number {
    return Number(this.db.prepare("SELECT MAX(id) AS last FROM events WHERE run_id=?").get(runId)?.last ?? 0);
  }
  eventLogPage(runId: string, after: number, through: number): Event[] {
    return this.db.prepare("SELECT * FROM events WHERE run_id=? AND id>? AND id<=? ORDER BY id LIMIT 500")
      .all(runId, after, through).map((row) => ({ id: Number(row.id), runId: String(row.run_id),
        kind: String(row.kind), data: JSON.parse(String(row.data)), createdAt: String(row.created_at) }));
  }
  /** The newest events across all of one owner's tasks, for the diagnostics bundle. */
  recentEvents(owner: string, limit = 200): Event[] {
    return this.db
      .prepare(
        "SELECT e.* FROM events e JOIN tasks t ON t.id=e.run_id WHERE t.owner=? ORDER BY e.id DESC LIMIT ?",
      )
      .all(owner, Math.max(1, Math.min(2000, limit)))
      .map((row) => ({
        id: Number(row.id),
        runId: String(row.run_id),
        kind: String(row.kind),
        data: JSON.parse(String(row.data)),
        createdAt: String(row.created_at),
      }));
  }
  beginUsage(runId: string, estimatedInput: number): void {
    this.db
      .prepare(
        "UPDATE usage SET estimated_input=estimated_input+?,attempts=attempts+1,unreported_calls=unreported_calls+1,incomplete_calls=incomplete_calls+1 WHERE run_id=?",
      )
      .run(estimatedInput, runId);
  }
  addUsage(
    runId: string,
    estimatedInput: number,
    estimatedOutput: number,
    reported?: { input: number; output: number; cachedInput?: number | undefined; cacheWrite?: number | undefined; cacheWrite1h?: number | undefined },
    completed = true,
  ): void {
    this.db
      .prepare(
        "UPDATE usage SET estimated_input=estimated_input+?,estimated_output=estimated_output+?,reported_input=reported_input+?,reported_output=reported_output+?,reported_cached_input=reported_cached_input+?,reported_cache_write=reported_cache_write+?,reported_cache_write_hour=reported_cache_write_hour+?,reports=reports+?,unreported_calls=MAX(0,unreported_calls-?),incomplete_calls=MAX(0,incomplete_calls-?) WHERE run_id=?",
      )
      .run(
        estimatedInput,
        estimatedOutput,
        reported?.input ?? 0,
        reported?.output ?? 0,
        reported?.cachedInput ?? 0,
        reported?.cacheWrite ?? 0,
        reported?.cacheWrite1h ?? 0,
        reported ? 1 : 0,
        reported ? 1 : 0,
        completed ? 1 : 0,
        runId,
      );
  }
  usage(runId: string): Record<string, number> {
    const r = this.db.prepare("SELECT * FROM usage WHERE run_id=?").get(runId);
    return {
      estimatedInput: Number(r?.estimated_input ?? 0),
      estimatedOutput: Number(r?.estimated_output ?? 0),
      reportedInput: Number(r?.reported_input ?? 0),
      reportedOutput: Number(r?.reported_output ?? 0),
      reportedCachedInput: Number(r?.reported_cached_input ?? 0),
      reportedCacheWrite: Number(r?.reported_cache_write ?? 0),
      reportedCacheWrite1h: Number(r?.reported_cache_write_hour ?? 0),
      reports: Number(r?.reports ?? 0),
      attempts: Number(r?.attempts ?? 0),
      unreportedCalls: Number(r?.unreported_calls ?? 0),
      incompleteCalls: Number(r?.incomplete_calls ?? 0),
    };
  }
  /**
   * Q48: runs `work` as one transaction, so a settings change and its change record are saved
   * together or not at all. Inside a transaction that is already open it simply runs, and the outer
   * one decides. Only what is written to the database is rolled back: a copy a module keeps in memory
   * of what it was told is not.
   */
  atomically<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN");
    this.deferred = [];
    try {
      const result = work();
      // A save that is still running when this returns would be committed half done.
      if (typeof (result as { then?: unknown } | null)?.then === "function") throw new Error("A change saved as one piece has to finish at once.");
      this.db.exec("COMMIT");
      const later = this.deferred;
      this.deferred = null;
      for (const step of later) try { step(); } catch { /* a file or listener after the commit never undoes it */ }
      return result;
    } catch (error) {
      this.deferred = null; // what a purge would have done to files and listeners is dropped with the rollback
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /**
   * your-data/for-good: what a purge does outside the database (its files, the listeners that remove attachments) waits
   * for the transaction `atomically` opened, and is dropped if that rolls back. Outside one it happens at once.
   */
  private deferred: (() => void)[] | null = null;
  private afterCommit(work: () => void): void {
    if (this.deferred) this.deferred.push(work); else work();
  }
  /** BEGIN, or a savepoint when a transaction is already open, so Delete everything can purge many conversations as one. */
  private openStep(name: string): string | null {
    if (this.db.isTransaction) { this.db.exec(`SAVEPOINT ${name}`); return name; }
    this.db.exec("BEGIN");
    return null;
  }
  private closeStep(savepoint: string | null): void { this.db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT"); }
  private undoStep(savepoint: string | null): void {
    if (!savepoint) { this.db.exec("ROLLBACK"); return; }
    this.db.exec(`ROLLBACK TO ${savepoint}`);
    this.db.exec(`RELEASE ${savepoint}`);
  }
  save(
    table: RecordTable,
    owner: string,
    id: string,
    data: Record<string, unknown>,
    /** Memory only: the agent writing, so saving a fact never ends one that agent may not change. */
    agent?: string,
  ): SavedRecord {
    if (table === "memory") return this.memories.save(owner, id, data, agent);
    // mac7/wake-pins: the one place every settings write passes through, so a setting the owner
    // pinned meets the same refusal from the window, the API, the terminal, a settings file, a
    // preset and a tool the model calls. The owner is never refused here.
    if (table === "settings") {
      const refusal = pinnedWriteRefusal(this, this.profiles.ownerName, this.profiles.isOwner(), id, data);
      if (refusal) throw new PinnedSettingError(refusal);
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO ${table} VALUES(?,?,?,?,?) ON CONFLICT(id,owner) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
      )
      .run(id, owner, JSON.stringify(data), now, now);
    return this.get(table, owner, id)!;
  }
  get(table: RecordTable, owner: string, id: string): SavedRecord | undefined {
    if (table === "memory") return this.memories.get(owner, id);
    const row = this.db
      .prepare(`SELECT * FROM ${table} WHERE owner=? AND id=?`)
      .get(owner, id);
    return row ? this.toRecord(row) : undefined;
  }
  list(table: RecordTable, owner: string): SavedRecord[] {
    if (table === "memory") return this.memories.list(owner);
    return this.db
      .prepare(
        `SELECT * FROM ${table} WHERE owner=? ORDER BY updated_at DESC LIMIT 500`,
      )
      .all(owner)
      .map((row) => this.toRecord(row));
  }
  delete(table: RecordTable, owner: string, id: string): boolean {
    if (table === "memory") return this.memories.delete(owner, id);
    // mac7/wake-pins (integration review): removing the record puts every field it held back to
    // what it means when it is missing, so a pin has to be met here exactly as it is on the way in.
    if (table === "settings") {
      const refusal = pinnedDeleteRefusal(this, this.profiles.ownerName, this.profiles.isOwner(), id);
      if (refusal) throw new PinnedSettingError(refusal);
    }
    return (
      this.db
        .prepare(`DELETE FROM ${table} WHERE owner=? AND id=?`)
        .run(owner, id).changes > 0
    );
  }
  usageStore(): UsageStore { return new UsageStore(this.db); }
  /** The spans of running and finished tasks, beside the events. Created on first use. */
  get spans(): SpanStore {
    return (this.spanStore ??= new SpanStore(this.db));
  }
  memoryCapacity(owner: string) { return this.memories.capacity(owner); }
  configureMemory(owner: string, input: unknown) { return this.memories.configure(owner, input); }
  updateMemory(owner: string, input: unknown, sourceRunId: string) {
    return this.memories.update(owner, input, sourceRunId);
  }
  searchMemory(owner: string, query: string, agent?: string) { return this.memories.search(owner, query, agent); }
  memoryAt(owner: string, input: unknown, agent?: string) { return this.memories.at(owner, input, agent); }
  memoryTimeline(owner: string, entity: string, agent?: string) { return this.memories.timeline(owner, entity, agent); }
  setMemorySuppressed(owner: string, sessionId: string, suppressed: boolean) { return this.memories.setSuppressed(owner, sessionId, suppressed); }
  exportMemory(owner: string) { return this.memories.export(owner); }
  importMemory(owner: string, input: unknown) { return this.memories.import(owner, input); }
  forgetMemoryPreview(owner: string, sessionId: string, outside: readonly MemoryRecord[] = []) { return this.memories.forgetPreview(owner, sessionId, outside); }
  forgetMemory(owner: string, input: unknown, outside: readonly MemoryRecord[] = []) {
    const forgotten = this.memories.forget(owner, input, outside);
    // Wave 7: forgetting what a conversation said also forgets what it taught about tools.
    this.toolUsage.forgetSession(forgotten.sessionId);
    return forgotten;
  }
  memorySuppressed(owner: string, sessionId: string) { return this.memories.suppressed(owner, sessionId); }
  memoryHygiene(owner: string, input: unknown, now?: number) { return this.memories.hygiene(owner, input, now); }
  archivedMemory(owner: string) { return this.memories.archived(owner); }
  restoreMemory(owner: string, id: string, preserveExpiry = false) { return this.memories.restore(owner, id, preserveExpiry); }
  /** Seasons: moves one fact into the archive with a note; nothing is destroyed and the Memory view can bring it back. */
  setAsideMemory(owner: string, id: string, note: string) { return this.memories.setAside(owner, id, note); }
  archivedMemoryCount(owner: string) { return this.memories.archivedCount(owner); }
  purgeArchivedMemory(owner: string, seen: number) { return this.memories.purgeArchive(owner, seen); }
  /** Keeps a note made while doing one job, so finishing that job no longer clears it. */
  promoteMemory(owner: string, id: string) { return this.memories.promote(owner, id); }
  /** Clears the notes one job made for itself; notes the owner asked to keep are left alone. */
  clearTaskScratch(owner: string, runId: string) { return this.memories.clearTaskScratch(owner, runId); }
  claimSchedule(
    owner: string,
    id: string,
    now: string,
  ): SavedRecord | undefined {
    const result = this.db
      .prepare(
        "UPDATE schedules SET data=json_set(data,'$.status','running'),updated_at=? WHERE owner=? AND id=? AND json_extract(data,'$.status')='pending' AND json_extract(data,'$.dueAt')<=? RETURNING *",
      )
      .get(now, owner, id, now);
    return result ? this.toRecord(result) : undefined;
  }
  /**
   * A turn asked for by hand or by a webhook takes the schedule in one conditional write, as `claimSchedule` does for
   * a due turn, so two callers (or a caller and the clock) can never both start it. The status it had is kept in
   * `statusBeforeTrigger` so the turn can put it back. A `slot` that already started a turn of this schedule is never
   * claimed again: the same webhook delivery sent twice starts one turn.
   */
  claimScheduleTrigger(owner: string, id: string, now: string, slot: string | null): SavedRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE schedules SET data=json_set(data,'$.statusBeforeTrigger',json_extract(data,'$.status'),'$.status','running'),updated_at=?
         WHERE owner=? AND id=? AND json_extract(data,'$.status') IN ('pending','paused','completed','failed')
         AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(data,'$.triggerSlots') WHERE json_extract(value,'$.slot')=?))
         RETURNING *`,
      )
      .get(now, owner, id, slot, slot);
    return result ? this.toRecord(result) : undefined;
  }
  dueSchedules(owner: string, now: string): SavedRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM schedules WHERE owner=? AND json_extract(data,'$.status')='pending' AND json_extract(data,'$.dueAt')<=? ORDER BY json_extract(data,'$.dueAt') LIMIT 100",
      )
      .all(owner, now)
      .map((row) => this.toRecord(row));
  }
  logTriggerFire(triggerId: string, owner: string, runId: string | null, payloadSummary: string, status: string): void {
    this.db
      .prepare(
        "INSERT INTO trigger_log(trigger_id, owner, run_id, payload_summary, status, created_at) VALUES(?, ?, ?, ?, ?, ?)",
      )
      .run(triggerId, owner, runId, payloadSummary, status, new Date().toISOString());
  }
  getTriggerLog(
    triggerId: string,
    owner: string,
    limit = 50,
  ): Array<{ id: number; runId: string | null; payloadSummary: string; status: string; createdAt: string }> {
    return this.db
      .prepare(
        "SELECT id, run_id as runId, payload_summary as payloadSummary, status, created_at as createdAt FROM trigger_log WHERE trigger_id = ? AND owner = ? ORDER BY id DESC LIMIT ?",
      )
      .all(triggerId, owner, limit) as Array<{ id: number; runId: string | null; payloadSummary: string; status: string; createdAt: string }>;
  }
  logWebhookDelivery(
    webhookId: string,
    owner: string,
    eventType: string,
    status: string,
    attempt: number,
    nextRetryAt: string | null,
  ): void {
    this.db
      .prepare(
        "INSERT INTO delivery_log(webhook_id, owner, event_type, status, attempt, next_retry_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
      )
      .run(webhookId, owner, eventType, status, attempt, nextRetryAt, new Date().toISOString());
  }
  getWebhookLog(
    webhookId: string,
    owner: string,
    limit = 50,
  ): Array<{ id: number; eventType: string; status: string; attempt: number; nextRetryAt: string | null; createdAt: string }> {
    return this.db
      .prepare(
        "SELECT id, event_type as eventType, status, attempt, next_retry_at as nextRetryAt, created_at as createdAt FROM delivery_log WHERE webhook_id = ? AND owner = ? ORDER BY id DESC LIMIT ?",
      )
      .all(webhookId, owner, limit) as Array<{ id: number; eventType: string; status: string; attempt: number; nextRetryAt: string | null; createdAt: string }>;
  }
  /** A workflow left working when the app closed is marked so the owner can carry it on. */
  private interruptWorkflows(): void {
    this.db.exec("UPDATE workflows SET data=json_set(data,'$.status','interrupted') WHERE json_extract(data,'$.status')='running'");
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_state'").get())
      this.db.exec("UPDATE workflow_state SET status='interrupted' WHERE status='running'");
  }
  private interruptSchedules(): void {
    this.db.exec(
      "UPDATE schedules SET data=json_set(data,'$.status','interrupted') WHERE json_extract(data,'$.status')='running'",
    );
  }
  private recoverInterruptedRuns(): void {
    for (const row of this.db
      .prepare("SELECT id FROM tasks WHERE status='running'")
      .all())
      this.finish(
        String(row.id),
        "interrupted",
        "Process stopped before completion; side effects were not replayed",
      );
    for (const row of this.db.prepare("SELECT id FROM sessions").all())
      this.reconcileMessages(String(row.id), "startup recovery");
  }
  private toRun(r: Row): Run {
    return {
      id: String(r.id),
      sessionId: String(r.session_id),
      owner: String(r.owner),
      prompt: String(r.prompt),
      status: r.status as RunStatus,
      output: String(r.output),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      project: r.project === undefined || r.project === null ? "default" : String(r.project),
    };
  }
  private toRecord(r: Row): SavedRecord {
    return {
      id: String(r.id),
      owner: String(r.owner),
      data: JSON.parse(String(r.data)),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
}
