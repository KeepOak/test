import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";
import { factKinds, type FactKind } from "./memory-layers.js";
import { noteFor, type MemoryMirror } from "./memory-mirror.js";
import { redactLeaks } from "./leak-guard.js";
import type { GitOutcome, GitRunOptions } from "./integrations/git-run.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { markChosen, sentKeys, shippedUnlessChosen } from "./ship-on.js";
import { accessAgent } from "./trunks/memory-scope.js";

/**
 * A history of what the assistant remembers, kept with Git (A2317, after Letta Code's git-backed
 * memory). The database stays the real store. When the owner switches this on, the same notes the
 * memory mirror writes (one per kind of fact) are written into a private repository in Branch's
 * own data folder after each task, and committed when they changed, with a message that says how
 * many remembered lines came and went. The workspace, and any repository in it, is never touched.
 *
 * Off by default. "When needed" and "on" both keep the history; "on" also offers the two reading
 * tools from the first round. A remote may be named to copy the history to: it must be an https
 * address the network rules allow, or an ssh address, and never one carrying a password; Git
 * sends it with this computer's own sign-in. What went wrong the last time is kept and shown.
 */
const remoteAddress = z.string().max(300).refine((value) => {
  if (/^git@[A-Za-z0-9.][A-Za-z0-9.-]*:[A-Za-z0-9._/-]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    // A host starting with "-" would read as an option to ssh.
    return (url.protocol === "https:" || url.protocol === "ssh:") && !url.password && (url.protocol === "ssh:" || !url.username)
      && !url.hostname.startsWith("-") && !url.username.startsWith("-");
  } catch { return false; }
}, "Use an https or ssh address without a password in it");
export const MemoryHistorySettingsSchema = z.object({
  mode: FeatureModeSchema.default("off"),
  remote: remoteAddress.optional(),
}).strict();
/** What the screen sends: the same, where a remote of null means "no copy anywhere". */
const MemoryHistoryInputSchema = z.object({ mode: FeatureModeSchema.optional(), remote: remoteAddress.nullable().optional() }).strict();
export type MemoryHistorySettings = z.infer<typeof MemoryHistorySettingsSchema>;
export interface MemoryHistoryVersion { commit: string; at: string; message: string; files: number }
export interface MemoryHistoryStatus { lastRecorded?: string; lastProblem?: string }

const SETTINGS = "memory-history", STATUS = "memory-history-status";
const author = ["-c", "user.name=Branch Agent", "-c", "user.email=branch-agent@localhost", "-c", "commit.gpgsign=false"];
type GitCall = (options: GitRunOptions, signal: AbortSignal) => Promise<GitOutcome>;

// The owner's rule (ships on, 2026-09-26): a private Git history of what the assistant remembers, kept on this computer; a copy goes elsewhere only to a remote the owner names; none of (a)–(f).
export const memoryHistoryShipsAs: FeatureMode = "when-needed";

export function memoryHistorySettings(store: Pick<Store, "get">, owner: string): MemoryHistorySettings {
  const saved = MemoryHistorySettingsSchema.safeParse(store.get("settings", owner, SETTINGS)?.data ?? {});
  return saved.success ? shippedUnlessChosen(store, owner, SETTINGS, saved.data, { mode: memoryHistoryShipsAs }) : MemoryHistorySettingsSchema.parse({});
}

export class MemoryHistory {
  private queue: Promise<unknown> = Promise.resolve();
  /** The notes on disk are the last version recorded: set only by a commit or an empty staged diff, so a failed one is tried again. */
  private clean = false;
  readonly folder: string;
  constructor(dataDir: string, private readonly store: Store, private readonly mirror: MemoryMirror,
    private readonly git: GitCall, private readonly policy?: NetworkPolicy) {
    this.folder = join(dataDir, "memory-history");
  }
  settings(owner: string): MemoryHistorySettings { return memoryHistorySettings(this.store, owner); }
  configure(owner: string, input: unknown): MemoryHistorySettings {
    const change = MemoryHistoryInputSchema.parse(input ?? {});
    const merged = { ...this.settings(owner), ...change };
    if (merged.remote == null) delete merged.remote;
    const value = MemoryHistorySettingsSchema.parse(merged);
    this.store.save("settings", owner, SETTINGS, value);
    markChosen(this.store, owner, SETTINGS, sentKeys(change));
    return value;
  }
  status(owner: string): MemoryHistoryStatus {
    return (this.store.get("settings", owner, STATUS)?.data ?? {}) as MemoryHistoryStatus;
  }

  /** Writes the notes and commits them when they changed; one at a time. Never throws: a problem is kept. */
  record(owner: string, signal: AbortSignal = AbortSignal.timeout(60000)): Promise<MemoryHistoryVersion | null> {
    const next = this.queue.then(() => this.recordNow(owner, signal)).catch((error: unknown) => {
      this.note(owner, { lastProblem: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
      return null;
    });
    this.queue = next;
    return next;
  }
  private async recordNow(owner: string, signal: AbortSignal): Promise<MemoryHistoryVersion | null> {
    const settings = this.settings(owner);
    if (settings.mode === "off") return null;
    await this.ensureRepository(signal);
    const { counts, changed } = await this.writeNotes(owner);
    // Every finished task records; most change nothing remembered, and then no Git runs (each call costs a process).
    if (!changed && this.clean) return null;
    this.clean = false;
    await this.run(["add", "-A", "."], signal);
    const staged = await this.run(["diff", "--cached", "--numstat"], signal);
    if (!staged.trim()) { this.clean = true; return null; }
    const message = describeMemoryChange(staged, counts);
    await this.run([...author, "commit", "--quiet", "--message", message], signal);
    this.clean = true;
    const [version] = await this.versions(1, signal);
    this.note(owner, { lastRecorded: version?.at ?? new Date().toISOString() });
    if (settings.remote) await this.send(settings.remote, signal);
    return version ?? null;
  }
  /** Whether a history has been kept here at all. */
  async kept(): Promise<boolean> {
    return readdir(join(this.folder, ".git")).then(() => true, () => false);
  }
  /**
   * your-data/for-good: every earlier version is forgotten. The repository is removed and, while the history is on,
   * started again with one version of what is remembered now; with `push`, Branch's own branch at the copy is replaced
   * by it. Answers whether the copy was replaced. One at a time with `record`; throws a plain problem.
   */
  rewrite(owner: string, push: boolean, signal: AbortSignal = AbortSignal.timeout(120000)): Promise<{ pushed: boolean }> {
    const next = this.queue.then(async () => {
      const settings = this.settings(owner);
      this.clean = false;
      await rm(this.folder, { recursive: true, force: true, maxRetries: 3 });
      if (settings.mode === "off") return { pushed: false };
      await this.ensureRepository(signal);
      await this.writeNotes(owner);
      await this.run(["add", "-A", "."], signal);
      await this.run([...author, "commit", "--quiet", "--allow-empty", "--message", "Started again: everything remembered before was deleted"], signal);
      this.clean = true;
      if (!settings.remote || !push) return { pushed: false };
      const host = settings.remote.startsWith("git@") ? settings.remote.slice(4, settings.remote.indexOf(":")) : new URL(settings.remote).hostname;
      await this.policy?.assertAllowed(new URL(`https://${host}/`), "memory history copy");
      await this.run(["push", "--quiet", "--force", settings.remote, "HEAD:refs/heads/branch-memory-history"], signal, 120000);
      return { pushed: true };
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private note(owner: string, change: MemoryHistoryStatus): void {
    const status: MemoryHistoryStatus = { ...this.status(owner), ...change };
    if ("lastRecorded" in change) delete status.lastProblem;
    try { this.store.save("settings", owner, STATUS, status as Record<string, unknown>); } catch { /* closing */ }
  }

  private async run(args: string[], signal: AbortSignal, timeoutMs = 30000): Promise<string> {
    const outcome = await this.git({ cwd: this.folder, args, timeoutMs }, signal);
    if (outcome.status !== "completed")
      throw new Error(`Git could not keep the memory history: ${(outcome.stderr || outcome.stdout).trim().split("\n")[0]?.slice(0, 200) ?? ""}`);
    return outcome.stdout;
  }
  private async ensureRepository(signal: AbortSignal): Promise<void> {
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    const known = await readdir(join(this.folder, ".git")).then(() => true, () => false);
    if (!known) { this.clean = false; await this.run(["init", "--quiet", "--initial-branch=memory"], signal); }
  }
  /** One note per kind of fact, exactly as the mirror writes them; kinds with nothing left are removed. `changed`: a note differed. */
  private async writeNotes(owner: string): Promise<{ counts: Map<FactKind, number>; changed: boolean }> {
    const grouped = this.mirror.grouped(owner);
    const counts = new Map<FactKind, number>();
    let changed = false;
    for (const kind of factKinds) {
      const path = join(this.folder, `${kind}.md`);
      const records = grouped.get(kind) ?? [];
      counts.set(kind, records.length);
      const before = await readFile(path, "utf8").catch(() => null);
      // Integration review: a key or password someone asked to be remembered is never committed or sent.
      const text = records.length ? redactLeaks(noteFor(kind, records)).text : null;
      if (text === before) continue;
      changed = true;
      if (text !== null) await writeFile(path, text, { mode: 0o600 });
      else await rm(path, { force: true });
    }
    return { counts, changed };
  }
  private async send(remote: string, signal: AbortSignal): Promise<void> {
    const host = remote.startsWith("git@") ? remote.slice(4, remote.indexOf(":")) : new URL(remote).hostname;
    await this.policy?.assertAllowed(new URL(`https://${host}/`), "memory history copy");
    await this.run(["push", "--quiet", remote, "HEAD:refs/heads/branch-memory-history"], signal, 120000);
  }

  /** The recorded versions, newest first. */
  async versions(limit = 30, signal: AbortSignal = AbortSignal.timeout(15000)): Promise<MemoryHistoryVersion[]> {
    const known = await readdir(join(this.folder, ".git")).then(() => true, () => false);
    if (!known) return [];
    const text = await this.run(["log", `--max-count=${limit}`, "--pretty=format:%H%x1f%aI%x1f%s", "--shortstat"], signal).catch(() => "");
    const versions: MemoryHistoryVersion[] = [];
    for (const line of text.split("\n")) {
      const parts = line.split("\x1f");
      if (parts.length === 3) versions.push({ commit: parts[0]!.slice(0, 12), at: parts[1]!, message: parts[2]!, files: 0 });
      else if (versions.length && /file/.test(line)) versions[versions.length - 1]!.files = Number(/(\d+) file/.exec(line)?.[1] ?? 0);
    }
    return versions;
  }
  /** What one note said at one version. */
  async noteAt(commit: string, kind: FactKind, signal: AbortSignal = AbortSignal.timeout(15000)): Promise<string> {
    if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error("Name a version by the code the history listed.");
    return (await this.run(["show", `${commit}:${kind}.md`], signal).catch(() => {
      throw new Error("That version has no note of that kind.");
    })).slice(0, 60000);
  }
}

/** "Remembered 12 facts: 2 lines added, 1 removed, in 2 notes." */
export function describeMemoryChange(numstat: string, counts: Map<FactKind, number>): string {
  let added = 0, removed = 0, notes = 0;
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [plus, minus] = line.split("\t");
    added += Number(plus) || 0;
    removed += Number(minus) || 0;
    notes++;
  }
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return `Remembered ${total} fact${total === 1 ? "" : "s"}: ${added} line${added === 1 ? "" : "s"} added, ${removed} removed, in ${notes} note${notes === 1 ? "" : "s"}`;
}

export function registerMemoryHistory(registry: ToolRegistry, history: MemoryHistory, owner: string): void {
  const refuseWhenOff = () => {
    if (history.settings(owner).mode === "off") throw new Error("The history of what is remembered is switched off. Turn it on in the Memory screen.");
  };
  /**
   * FQ-routing.isolated-agents: unlike memory.at/search/timeline, this history is not kept per fact
   * — writeNotes() (above) groups every fact the owner has, of every scope, into one note per kind,
   * and each commit is of that whole note. There is no per-fact attribution to filter a log entry or
   * a note's text by, the way visibleTo() filters a list of records, so an agent-scoped caller (a
   * Trunk, a delegated specialist) is refused outright rather than shown a note that can hold other
   * agents' facts, or the owner's own private ones.
   */
  const refuseForAgent = (agent: string | undefined) => {
    if (agent) throw new Error("The history of what is remembered mixes every agent's facts in one note, so it is not available to a Trunk or a delegated specialist.");
  };
  registry.register({
    name: "memory.versions", permission: "memory.read",
    description: "The recorded versions of what the assistant remembers, newest first: when, what changed, and how many notes.",
    parameters: z.object({ limit: z.number().int().min(1).max(100).default(30) }).strict(),
    execute: async (args, context) => { refuseForAgent(accessAgent(context)); /* Q123 */ refuseWhenOff(); return { versions: await history.versions(args.limit), ...history.status(owner) }; },
  });
  registry.register({
    name: "memory.version_note", permission: "memory.read",
    description: "What one note of remembered facts said at a recorded version.",
    parameters: z.object({ version: z.string().regex(/^[0-9a-f]{7,40}$/), kind: z.enum(factKinds) }).strict(),
    execute: async (args, context) => { refuseForAgent(accessAgent(context)); /* Q123 */ refuseWhenOff(); return { version: args.version, kind: args.kind, text: await history.noteAt(args.version, args.kind) }; },
  });
  registry.onRunFinished(async (context) => {
    if (history.settings(context.owner).mode !== "off") await history.record(context.owner);
  });
}

/** The saved text of a note, for tests and the screen. */
export const readNote = (history: MemoryHistory, kind: FactKind): Promise<string> =>
  readFile(join(history.folder, `${kind}.md`), "utf8").catch(() => "");
