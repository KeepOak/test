import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ownersOwnTask } from "./asked-task.js";
import { estimateTokens, type Run, type ToolContext } from "./contracts.js";
import { onThisComputer } from "./embeddings.js";
import { lockdownActive } from "./lockdown.js";
import { evaluatePolicy, readPolicy } from "./policy.js";
import { assertProviderEndpoint } from "./providers.js";
import type { Store } from "./store.js";
import { HonchoSyncClient, Mem0SyncClient, type NativeMemoryClient } from "./native-memory-clients.js";

export const NativeMemorySettingsSchema = z.object({
  provider: z.enum(["off", "mem0", "honcho"]).default("off"),
  url: z.string().trim().max(500).default(""),
  secret: z.string().trim().max(200).regex(/^([A-Z][A-Z0-9_]*)?$/).default(""),
  secretProject: z.string().trim().max(100).default(""),
  /** A forwarded service remains outside this computer even when its tunnel uses loopback. */
  remoteBehindLoopback: z.boolean().default(false),
  timeoutMs: z.number().int().min(500).max(30000).default(8000),
  messageCharacters: z.number().int().min(100).max(4000).default(450),
  contextTokens: z.number().int().min(50).max(1000).default(300),
}).strict();
export type NativeMemorySettings = z.infer<typeof NativeMemorySettingsSchema>;
export const NativeMemoryDestinationSchema = z.object({ id: z.uuid(), owner: z.string().min(1).max(200),
  namespace: z.string().regex(/^branch_[a-f0-9]{16}_[a-f0-9]{16}$/), settings: NativeMemorySettingsSchema }).strict();
export type NativeMemoryDestination = z.infer<typeof NativeMemoryDestinationSchema>;
export interface NativeMemoryRecall { text: string; assertCurrent(): void; }
export interface NativeMemoryHooks {
  recall(run: Run, context: ToolContext, localOnly: boolean): Promise<NativeMemoryRecall | null>;
  sync(run: Run, context: ToolContext, localOnly: boolean): Promise<void>;
  close(): void;
}
export interface NativeMemoryDependencies {
  fetchFor(endpoint: string): typeof fetch;
  assertAllowed(endpoint: string, target: string): void;
  key(settings: NativeMemorySettings): Promise<string>;
  scrub(text: string): string;
  locked(): boolean;
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const host = (url: string): string => new URL(url).host;
const privateLinks = /(?:attachment|resource|branch-image):[^\s)]+|\/api\/(?:memory\/images|attachments)\/[^\s)]+/g;

/** Sentence-boundary truncation adapts Hermes mem0's MIT _truncate_for_sync; it never extracts facts. */
function boundedMessage(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const window = text.slice(0, maximum);
  const cut = Math.max(...["。", "！", "？", ".", "!", "?"].map((end) => window.lastIndexOf(end)));
  return window.slice(0, cut > maximum / 3 ? cut + 1 : maximum);
}
function boundedContext(text: string, tokens: number): string {
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= tokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

/** Opt-in native lifecycle context alongside accepted Branch facts. No accepted fact, revision or tombstone is replaced. */
export class NativeMemory implements NativeMemoryHooks {
  private controller = new AbortController();
  private closed = false;
  private readonly work = new Map<string, Promise<void>>();
  constructor(private readonly store: Store, private readonly owner: string, private readonly deps: NativeMemoryDependencies) {
    store.sqlite.exec(`CREATE TABLE IF NOT EXISTS native_memory_destinations(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      namespace TEXT NOT NULL, data TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0, deleting INTEGER NOT NULL DEFAULT 0)`);
  }
  settings(): NativeMemorySettings {
    const found = NativeMemorySettingsSchema.safeParse(this.store.get("settings", this.owner, "native-memory")?.data ?? {});
    return found.success ? found.data : NativeMemorySettingsSchema.parse({});
  }
  configure(input: unknown): ReturnType<NativeMemory["view"]> {
    this.store.profiles.requireOwner("Native outside memory context");
    if (this.deps.locked() || lockdownActive(this.store, this.owner)) throw new Error("Unlock Branch and turn Lockdown off before changing native memory");
    const settings = NativeMemorySettingsSchema.parse({ ...this.settings(), ...(input as object),
      secretProject: (input as { secretProject?: unknown })?.secretProject ?? this.store.projects.active(this.owner).id });
    if (settings.secret && !this.store.projects.list(this.owner).some((project) => project.id === settings.secretProject)) throw new Error("Choose one of your locker projects for this connection");
    if (settings.provider !== "off") {
      if (!settings.url) throw new Error("Name the base address of your existing native memory service");
      assertProviderEndpoint(settings.url);
      if (new URL(settings.url).search) throw new Error("A native memory address cannot contain a query string");
    }
    this.cancel();
    this.store.save("settings", this.owner, "native-memory", settings);
    return this.view();
  }
  view() {
    this.store.profiles.requireOwner("Native outside memory context");
    return { settings: this.settings(), lockerProject: this.store.projects.active(this.owner).id, destinations: this.deletionChoices(this.owner).map((entry) => ({
      provider: entry.settings.provider, host: host(entry.settings.url), settings: entry.settings, pending: this.pending(entry.owner),
    })), note: "Native recall is untrusted conversation context, alongside your accepted facts. Only your own app/CLI turns sync. Changes keep earlier destinations; Delete everything retains cleanup until each matching connection is restored. Mem0 cleanup needs an admin-capable key." };
  }
  cancel(): void {
    this.controller.abort(new Error("Native memory stopped"));
    this.controller = new AbortController();
  }
  close(): void { this.closed = true; this.cancel(); }
  private pending(owner: string): boolean {
    return !!this.store.sqlite.prepare("SELECT 1 FROM native_memory_destinations WHERE owner=? AND deleting=1 AND retired=0").get(owner);
  }
  private principal(settings: NativeMemorySettings, owner: string): void {
    if (this.closed || this.deps.locked() || lockdownActive(this.store, this.owner)) throw new Error("Native memory is stopped while Branch is closed, locked or in Lockdown");
    if (owner !== this.owner || this.store.profiles.scope() !== owner || !this.store.profiles.isOwner()) throw new Error("Native memory is bound to the owner's current profile");
    if (!same(settings, this.settings()) || settings.provider === "off") throw new Error("This native memory destination or credential reference was changed or removed");
  }
  private allowed(run: Run, context: ToolContext, settings: NativeMemorySettings, localOnly: boolean, write: boolean): void {
    this.principal(settings, run.owner);
    context.signal.throwIfAborted();
    if (context.owner !== run.owner || context.depth || context.agent || context.trunk || context.isolated || context.dryRun || !ownersOwnTask(this.store, run.id)
      || !this.store.ownsSession(run.owner, run.sessionId) || this.store.sessionTemporary(run.sessionId)) throw new Error("Only the owner's own lasting app or CLI conversation uses native memory");
    if (!context.permissions.has(write ? "memory.write" : "memory.read")) throw new Error("This task has no native memory permission");
    if (this.pending(run.owner)) throw new Error("Native memory cleanup is pending; recall and sync wait until it finishes");
    if (localOnly && (settings.remoteBehindLoopback || !onThisComputer(settings.url))) throw new Error("This task stays on this computer; no native memory request was sent outside it");
    const outcome = evaluatePolicy(readPolicy(this.store, this.owner), { tool: write ? "memory.native.sync" : "memory.native.recall", target: settings.url, readOnly: !write });
    if (outcome.decision !== "allow") throw new Error("The owner's approval rules do not allow automatic native memory for this task");
  }
  private client(settings: NativeMemorySettings, check: () => void): NativeMemoryClient {
    const transport = { url: settings.url, timeoutMs: settings.timeoutMs, fetch: this.deps.fetchFor(settings.url),
      key: async () => { check(); return this.deps.key(settings); }, header: settings.provider === "mem0" ? "X-API-Key" : "Authorization",
      check: (target: string) => { check(); this.deps.assertAllowed(settings.url, target); } };
    return settings.provider === "mem0" ? new Mem0SyncClient(transport) : new HonchoSyncClient(transport);
  }
  private destination(settings: NativeMemorySettings, create: boolean): NativeMemoryDestination | null {
    const row = this.store.sqlite.prepare("SELECT data FROM native_memory_destinations WHERE owner=? AND retired=0 AND deleting=0 ORDER BY rowid DESC")
      .all(this.owner).find((entry) => same(NativeMemoryDestinationSchema.parse(JSON.parse(String(entry.data))).settings, settings));
    if (row) {
      const found = NativeMemoryDestinationSchema.parse(JSON.parse(String(row.data)));
      if (found.owner !== this.owner || !found.namespace.startsWith(`branch_${hash(this.owner)}_`)) throw new Error("Native destination ownership does not match this person");
      return found;
    }
    if (!create) return null;
    if (this.deletionChoices(this.owner).length >= 100) throw new Error("Clean up an earlier native memory destination before adding another");
    const id = randomUUID(), namespace = `branch_${hash(this.owner)}_${hash(id)}`;
    const value = NativeMemoryDestinationSchema.parse({ id, owner: this.owner, namespace, settings });
    // Durable destination intent precedes any future upload, even one whose response is lost.
    this.store.sqlite.prepare("INSERT INTO native_memory_destinations(id,owner,namespace,data) VALUES(?,?,?,?)").run(id, this.owner, namespace, JSON.stringify(value));
    return value;
  }
  private async serial<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.work.get(owner);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    this.work.set(owner, waiting);
    try { await previous; return await operation(); }
    finally { release(); if (this.work.get(owner) === waiting) this.work.delete(owner); }
  }
  async recall(run: Run, context: ToolContext, localOnly: boolean): Promise<NativeMemoryRecall | null> {
    const settings = this.settings();
    if (settings.provider === "off") return null;
    this.allowed(run, context, settings, localOnly, false);
    const destination = this.destination(settings, false);
    if (!destination) return null;
    const question = this.deps.scrub(run.prompt).replace(privateLinks, "[local image reference]");
    const signal = AbortSignal.any([this.controller.signal, context.signal]);
    const text = await this.client(settings, () => this.allowed(run, context, settings, localOnly, false))
      .recall(destination.namespace, hash(run.sessionId), boundedMessage(question, settings.messageCharacters), signal);
    this.allowed(run, context, settings, localOnly, false);
    const cleaned = this.deps.scrub(text).replace(privateLinks, "[local image reference]");
    const bounded = boundedContext(cleaned, settings.contextTokens);
    const assertCurrent = () => { signal.throwIfAborted(); this.allowed(run, context, settings, localOnly, false); };
    return bounded.trim() ? { text: bounded, assertCurrent } : null;
  }
  async sync(run: Run, context: ToolContext, localOnly: boolean): Promise<void> {
    const settings = this.settings();
    if (settings.provider === "off") return;
    const lifetime = this.controller.signal;
    await this.serial(run.owner, async () => {
      lifetime.throwIfAborted();
      this.allowed(run, context, settings, localOnly, true);
      const destination = this.destination(settings, true)!;
      const clean = (text: string) => boundedMessage(this.deps.scrub(text).replace(privateLinks, "[local image reference]"), settings.messageCharacters);
      const signal = AbortSignal.any([lifetime, context.signal]);
      await this.client(settings, () => this.allowed(run, context, settings, localOnly, true))
        .sync(destination.namespace, hash(run.sessionId), clean(run.prompt), clean(run.output), run.id, signal);
      this.allowed(run, context, settings, localOnly, true);
      this.store.event(run.id, "memory.native.synced", { provider: settings.provider, charactersAtMost: settings.messageCharacters * 2 });
    });
  }
  /** Includes retired connections still holding data, but never exposes or resolves a credential value. */
  deletionChoices(owner: string): NativeMemoryDestination[] {
    const rows = this.store.sqlite.prepare("SELECT data FROM native_memory_destinations WHERE owner=? AND retired=0 ORDER BY rowid").all(owner);
    const entries = z.array(NativeMemoryDestinationSchema).max(100).parse(rows.map((row) => JSON.parse(String(row.data))));
    if (entries.some((entry) => entry.owner !== owner || !entry.namespace.startsWith(`branch_${hash(owner)}_`))) throw new Error("Native memory destination ownership does not match its journal");
    return entries;
  }
  /** Call within the local deletion transaction; no native context can be republished afterwards. */
  markDeleting(entries: NativeMemoryDestination[]): void {
    for (const entry of entries) {
      if (entry.owner !== this.owner || !entry.namespace.startsWith(`branch_${hash(this.owner)}_`)) throw new Error("Native cleanup belongs to a different person");
      this.store.sqlite.prepare("UPDATE native_memory_destinations SET deleting=1 WHERE id=? AND owner=?").run(entry.id, entry.owner);
    }
    if (entries.length) this.cancel();
  }
  async forget(input: NativeMemoryDestination): Promise<boolean> {
    const destination = NativeMemoryDestinationSchema.parse(input);
    if (destination.owner !== this.owner) throw new Error("This native memory journal belongs to a different owner");
    const recorded = this.store.sqlite.prepare("SELECT data,retired FROM native_memory_destinations WHERE id=? AND owner=?").get(destination.id, destination.owner);
    if (!recorded || !same(JSON.parse(String(recorded.data)), destination)) throw new Error("This native memory journal does not match its original destination");
    if (recorded.retired) return true;
    if (!same(this.settings(), destination.settings)) return false;
    const lifetime = this.controller.signal;
    return this.serial(destination.owner, async () => {
      lifetime.throwIfAborted();
      const check = () => {
        this.principal(destination.settings, destination.owner);
        const row = this.store.sqlite.prepare("SELECT data,deleting FROM native_memory_destinations WHERE id=? AND owner=? AND retired=0").get(destination.id, destination.owner);
        if (!row || !row.deleting || !same(JSON.parse(String(row.data)), destination)) throw new Error("The native memory cleanup namespace is no longer paired with its journal");
      };
      check();
      await this.client(destination.settings, check).forget(destination.namespace, lifetime);
      check();
      this.store.sqlite.prepare("UPDATE native_memory_destinations SET retired=1 WHERE id=? AND owner=?").run(destination.id, destination.owner);
      return true;
    });
  }
}
