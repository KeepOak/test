/**
 * When Branch talks to somebody else's MCP server, that connection is opened the first time a task
 * actually needs it and closed again when the task ends — so a server the owner configured but
 * never uses is never started at all. A connection can be kept warm for a few minutes in case the
 * next task wants it, there is a cap on how many servers may be open at once, and a server that
 * will not answer is retried a few times with a growing wait before it is given up on.
 */
import { z } from "zod";
import { diagnose } from "./diagnostic-log.js"; // mac7/diagnostics
import type { Store } from "./store.js";

export const McpLifecycleSchema = z
  .object({
    /** How long an unused connection is kept open in case the next task wants it. 0 closes it at once. */
    keepWarmMinutes: z.number().int().min(0).max(120).default(5),
    /** How many outside servers may be connected at the same time. */
    maxConcurrentServers: z.number().int().min(1).max(20).default(4),
    /** How many times a server that will not answer is tried again before Branch gives up. */
    reconnectAttempts: z.number().int().min(0).max(10).default(3),
    /**
     * When a server Branch is set up to use is actually started. "startup" opens every one of them
     * as Branch starts, which is what has always happened. "on-demand" lists their tools from what
     * they said last time and starts one only when a task really calls it, so a server the owner
     * set up and rarely uses is never started at all.
     */
    connect: z.enum(["startup", "on-demand"]).default("startup"),
  })
  .strict();
export type McpLifecycleSettings = z.infer<typeof McpLifecycleSchema>;

const settingsKey = "mcp-connections";

/** The settings for whoever is using the app — each household profile keeps its own. */
export function readLifecycleSettings(store: Store, scope: string): McpLifecycleSettings {
  const saved = McpLifecycleSchema.safeParse(store.get("settings", scope, settingsKey)?.data ?? {});
  return saved.success ? saved.data : McpLifecycleSchema.parse({});
}
export function saveLifecycleSettings(store: Store, scope: string, input: unknown): McpLifecycleSettings {
  const value = McpLifecycleSchema.parse({ ...readLifecycleSettings(store, scope), ...(input as object ?? {}) });
  store.save("settings", scope, settingsKey, value);
  return value;
}

export interface McpConnection { close(): Promise<void> }
export type ConnectionState = "connecting" | "ready" | "warm" | "failed" | "idle";
export interface ServerHealth {
  id: string;
  state: ConnectionState;
  /** Tasks using this connection right now. */
  runs: number;
  attempts: number;
  since: string;
  lastError: string | null;
  /** Plain words for the Connections screen. */
  summary: string;
}

interface Entry {
  id: string;
  state: ConnectionState;
  connection: McpConnection | null;
  opening: Promise<McpConnection> | null;
  runs: Set<string>;
  attempts: number;
  since: number;
  lastError: string | null;
  warmTimer: NodeJS.Timeout | null;
  /** Set once it is shut: an open still under way then closes what it opens instead of keeping it. */
  closed: boolean;
}

const summarise = (entry: Entry): string => {
  if (entry.state === "ready") return `Connected and in use by ${entry.runs.size} task${entry.runs.size === 1 ? "" : "s"}.`;
  if (entry.state === "connecting") return "Connecting.";
  if (entry.state === "warm") return "Connected but not in use; it closes itself shortly.";
  if (entry.state === "idle") return "Set up, not connected yet. It starts the first time a task needs it.";
  return entry.lastError ? `Not answering: ${entry.lastError}` : "Not answering.";
};

/** Opens outside MCP servers only when a task needs one, and closes them when the task is done. */
export class McpConnections {
  private readonly entries = new Map<string, Entry>();
  /** Overridden in tests so the growing wait between tries can be stepped over. */
  backoffMs = (attempt: number): number => Math.min(200 * 2 ** attempt, 5000);
  /** Overridden in tests so keeping warm can be checked without waiting minutes. */
  warmMs = (settings: McpLifecycleSettings): number => settings.keepWarmMinutes * 60_000;

  /** How to open each server by name, for servers that were configured ahead of time. */
  private readonly openers = new Map<string, () => Promise<McpConnection>>();
  /** When this manager was made, which is as long as an unopened server has been waiting. */
  private readonly started = Date.now();

  constructor(
    private readonly store: Store,
    private readonly scope: () => string,
  ) {}

  /** Teaches this manager how to open one named server. Nothing is opened yet. */
  register(id: string, opener: () => Promise<McpConnection>): void {
    this.openers.set(id, opener);
  }
  /**
   * Forgets one server: its connection is closed and it is no longer known, so it leaves the health list too. A
   * connection still opening is closed as soon as it arrives, and this waits for that.
   */
  async forget(id: string): Promise<void> {
    this.openers.delete(id);
    const entry = this.entries.get(id);
    if (entry) await this.shut(entry);
  }
  /** Every server this manager knows how to open. */
  known(): string[] {
    return [...this.openers.keys()];
  }
  private async open(id: string): Promise<McpConnection> {
    const opener = this.openers.get(id);
    if (!opener) throw new Error(`No server called "${id}" is set up.`);
    return opener();
  }

  private settings(): McpLifecycleSettings {
    return readLifecycleSettings(this.store, this.scope());
  }

  private entry(id: string): Entry {
    const found = this.entries.get(id);
    if (found) return found;
    const created: Entry = {
      id, state: "connecting", connection: null, opening: null, runs: new Set(),
      attempts: 0, since: Date.now(), lastError: null, warmTimer: null, closed: false,
    };
    this.entries.set(id, created);
    return created;
  }

  /** The connection a task needs, opened now if it is not already there. */
  async acquire(runId: string, id: string, opener?: () => Promise<McpConnection>): Promise<McpConnection> {
    if (opener && !this.openers.has(id)) this.openers.set(id, opener);
    const entry = this.entry(id);
    if (entry.warmTimer) { clearTimeout(entry.warmTimer); entry.warmTimer = null; }
    entry.runs.add(runId);
    if (entry.connection) { entry.state = "ready"; return entry.connection; }
    if (!entry.opening) entry.opening = this.openWithRetry(entry);
    try {
      const connection = await entry.opening;
      entry.opening = null;
      return connection;
    } catch (error) {
      entry.opening = null;
      entry.runs.delete(runId);
      throw error;
    }
  }

  private async openWithRetry(entry: Entry): Promise<McpConnection> {
    await this.makeRoomFor(entry.id);
    entry.state = "connecting";
    const tries = this.settings().reconnectAttempts + 1;
    for (let attempt = 0; attempt < tries && !entry.closed; attempt++) {
      try {
        const connection = await this.open(entry.id);
        // Switched off or forgotten while this was opening: what it opened is closed, never kept or handed over.
        if (entry.closed) { await connection.close().catch(() => undefined); break; }
        entry.connection = connection;
        entry.state = "ready";
        entry.lastError = null;
        entry.since = Date.now();
        return connection;
      } catch (error) {
        if (entry.closed) break;
        entry.attempts++;
        entry.lastError = error instanceof Error ? error.message.slice(0, 200) : "Unknown problem";
        diagnose("mcp", "warn", `Could not reach the "${entry.id}" server (try ${attempt + 1} of ${tries}): ${entry.lastError}`); // mac7/diagnostics
        if (attempt + 1 < tries) await sleep(this.backoffMs(attempt));
      }
    }
    if (entry.closed) throw new Error(`The "${entry.id}" server was switched off before it finished connecting.`);
    entry.state = "failed";
    throw new Error(`Branch could not reach the "${entry.id}" server. ${entry.lastError ?? ""}`.trim());
  }

  /**
   * Keeps to the cap. A connection nobody is using is closed to make room; when every open server
   * is busy, the new one is refused rather than quietly going over the limit.
   */
  private async makeRoomFor(id: string): Promise<void> {
    const cap = this.settings().maxConcurrentServers;
    const open = () => [...this.entries.values()].filter((entry) => entry.id !== id && entry.connection);
    while (open().length >= cap) {
      const spare = open().filter((entry) => entry.runs.size === 0).sort((a, b) => a.since - b.since)[0];
      if (!spare)
        throw new Error(`Branch already has ${cap} outside servers connected, and all of them are busy.`);
      await this.shut(spare);
    }
  }

  /** A task has finished: everything it alone was using is closed, or kept warm for a while. */
  async releaseRun(runId: string): Promise<void> {
    const warm = this.warmMs(this.settings());
    for (const entry of [...this.entries.values()]) {
      if (!entry.runs.delete(runId) || entry.runs.size > 0 || !entry.connection) continue;
      if (warm === 0) { await this.shut(entry); continue; }
      entry.state = "warm";
      entry.warmTimer = setTimeout(() => void this.shut(entry).catch(() => undefined), warm);
      entry.warmTimer.unref?.();
    }
  }

  private async shut(entry: Entry): Promise<void> {
    entry.closed = true;
    if (entry.warmTimer) { clearTimeout(entry.warmTimer); entry.warmTimer = null; }
    const connection = entry.connection, opening = entry.opening;
    entry.connection = null;
    this.entries.delete(entry.id);
    if (connection) await connection.close().catch(() => undefined);
    // An open still under way closes what it opens once it sees `closed` (openWithRetry). Waiting for it means no
    // connection it opens outlives forgetting the server or closing Branch.
    if (opening) await opening.catch(() => undefined);
  }

  /**
   * How each configured server is doing, for Settings → Connections. A server Branch knows how to
   * open but has not opened is listed too, saying so plainly, rather than being missing from a
   * list the owner reads as "everything I set up".
   */
  health(): ServerHealth[] {
    const live = [...this.entries.values()].map((entry) => ({
      id: entry.id, state: entry.state, runs: entry.runs.size, attempts: entry.attempts,
      since: new Date(entry.since).toISOString(), lastError: entry.lastError, summary: summarise(entry),
    }));
    const seen = new Set(live.map((entry) => entry.id));
    const waiting = this.known().filter((id) => !seen.has(id)).map((id) => ({
      id, state: "idle" as const, runs: 0, attempts: 0, since: new Date(this.started).toISOString(),
      lastError: null,
      summary: "Set up, not connected yet. It starts the first time a task needs it.",
    }));
    return [...live, ...waiting].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** How many outside servers are connected right now. */
  openCount(): number {
    return [...this.entries.values()].filter((entry) => entry.connection).length;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.shut(entry)));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});
