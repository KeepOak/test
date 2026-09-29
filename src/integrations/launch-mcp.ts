import { unwatchFile, watchFile, type Stats } from "node:fs";
import { McpConfigSchema } from "./mcp-config.js";

type Start = (server: unknown) => Promise<(() => Promise<void>) | null>;

/**
 * The MCP servers listed in the launch file (BRANCH_INTEGRATIONS), kept in step with that file while Branch runs: a
 * server added to it starts and its tools are in the very next turn, one taken out stops and its tools go, one whose
 * settings changed is stopped and started again with the new ones. Nothing else restarts: not the engine, not the
 * gateway, not the other servers. The servers added in the app (src/mcp-own-servers.ts) were always live; this makes
 * the file's the same.
 */
export class LaunchMcp {
  private readonly running = new Map<string, { key: string; stop: () => Promise<void> }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly start: Start, private readonly log: (line: string) => void = (line) => console.error(line)) {}

  /** The file's servers now. `strict`: the first load, where one that will not start stops the launch, as always. */
  apply(servers: readonly unknown[], strict = false): Promise<{ started: string[]; stopped: string[] }> {
    const next = this.queue.then(() => this.applyNow(servers, strict));
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async applyNow(servers: readonly unknown[], strict: boolean): Promise<{ started: string[]; stopped: string[] }> {
    const wanted = new Map(servers.map((server) => [McpConfigSchema.parse(server).id, server] as const));
    if (wanted.size !== servers.length) throw new Error("MCP server IDs must be unique");
    const started: string[] = [], stopped: string[] = [];
    for (const [id, entry] of [...this.running]) {
      const server = wanted.get(id);
      if (server !== undefined && JSON.stringify(server) === entry.key) continue;
      await entry.stop().catch((error: Error) => this.log(`The MCP server ${id} did not stop cleanly: ${error.message}`));
      this.running.delete(id);
      stopped.push(id);
    }
    for (const [id, server] of wanted) {
      if (this.running.has(id)) continue;
      try {
        const stop = await this.start(server);
        this.running.set(id, { key: JSON.stringify(server), stop: stop ?? (async () => undefined) });
        started.push(id);
      } catch (error) {
        if (strict) throw error;
        this.log(`The MCP server ${id} from the launch file did not start: ${(error as Error).message}`);
      }
    }
    return { started, stopped };
  }
  async close(): Promise<void> {
    await this.queue;
    for (const [id, entry] of [...this.running]) {
      this.running.delete(id);
      await entry.stop().catch(() => undefined);
    }
  }
}

/**
 * Looks at the launch file every second or so and hands its MCP section to `launch` when it changed. A file that does
 * not read (half-written, a mistake) changes nothing and is said once; the next good save applies.
 */
export function followLaunchFile(path: string, read: () => Promise<readonly unknown[]>, launch: LaunchMcp,
  log: (line: string) => void = (line) => console.error(line), intervalMs = 1000): () => void {
  let told = "";
  const changed = (now: Stats, before: Stats) => {
    if (now.mtimeMs === before.mtimeMs && now.size === before.size) return;
    void read().then((servers) => launch.apply(servers)).then((done) => {
      told = "";
      if (done.started.length || done.stopped.length)
        log(`Launch file MCP servers: ${[...done.started.map((id) => `started ${id}`), ...done.stopped.map((id) => `stopped ${id}`)].join(", ")}.`);
    }, (error: Error) => {
      if (error.message !== told) log(`The launch file was not applied: ${error.message}`);
      told = error.message;
    });
  };
  watchFile(path, { interval: intervalMs, persistent: false }, changed);
  return () => unwatchFile(path, changed);
}

