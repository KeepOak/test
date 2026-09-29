import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { z } from "zod";
import type { ModelRouter } from "../models.js";
import { cliAgentCatalog, registerCliAgent } from "../providers/cli-agent.js";
import { claudeSubscriptionModels } from "../providers/claude-models.js";
import type { Store } from "../store.js";
import { CodexAppServerProvider, startCodexAppServer, type StartAppServer } from "./codex-app-server.js";
import { askMode, partSettings, requireAsk } from "./settings.js";

/**
 * A2258: more than one agent runtime. Branch's own loop is always there; beside it the owner can add
 * a coding agent already installed on this computer as the thing that answers a conversation:
 *
 *   cli          Claude Code, Codex, Copilot or Gemini CLI, asked one question at a time
 *                (src/providers/cli-agent.ts)
 *   app-server   Codex held over its app-server protocol, answering word by word
 *                (src/asks/codex-app-server.ts)
 *
 * An added runtime is a connection like any other: a conversation picks it with /model, and nothing
 * else changes. What was added is written down and comes back after a restart while the switch is on.
 */
export interface RuntimeRow { id: string; name: string; kind: "builtin" | "cli" | "app-server"; command: string | null; note: string }

export const runtimeRows: readonly RuntimeRow[] = [
  { id: "branch", name: "Branch's own loop", kind: "builtin", command: null, note: "Always there: the connection you chose answers and Branch runs the tools." },
  ...cliAgentCatalog.map((row) => ({ id: row.id, name: row.name, kind: "cli" as const, command: row.command, note: row.note })),
  { id: "codex-app-server", name: "Codex over its app-server protocol", kind: "app-server", command: "codex",
    note: "Runs OpenAI's own codex app-server with your own sign-in, read-only, and streams its answer. Branch never sees that sign-in." },
];

const AddedSchema = z.object({ added: z.array(z.string().max(64)).max(20).default([]) }).strict();
const addedKey = "asks-runtimes-added";

/** A removed connection must not return from the runtime's saved registration after a restart. */
export function forgetRuntimeChoice(store: Store, owner: string, id: string): void {
  const { added } = partSettings(store, owner, addedKey, AddedSchema);
  if (added.includes(id)) store.save("settings", owner, addedKey, { added: added.filter((entry) => entry !== id) });
}

/** Whether a program of that name is on this computer's path. Nothing is run to find out. */
export async function onPath(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<boolean> {
  const endings = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const folder of (env.PATH ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean))
    for (const ending of endings) {
      const found = await access(join(folder, command + ending), platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false);
      if (found) return true;
    }
  return false;
}

export class AgentRuntimes {
  constructor(private readonly store: Store, private readonly owner: string, private readonly models: ModelRouter,
    private readonly version: string, private readonly startAppServer: StartAppServer = startCodexAppServer) {
    if (askMode(store, owner, "runtimes") !== "off") for (const id of this.added()) this.register(id);
  }
  private added(): string[] { return partSettings(this.store, this.owner, addedKey, AddedSchema).added; }

  async list(): Promise<(RuntimeRow & { installed: boolean | null; added: boolean; connection: string | null })[]> {
    const added = new Set(this.added());
    return Promise.all(runtimeRows.map(async (row) => ({
      ...row, installed: row.command ? await onPath(row.command) : null, added: row.kind === "builtin" || added.has(row.id),
      connection: row.kind === "builtin" ? null : added.has(row.id) ? connectionId(row) : null,
    })));
  }

  private register(id: string): string {
    const row = runtimeRows.find((r) => r.id === id);
    if (!row || row.kind === "builtin") throw new Error("That runtime was not found");
    if (row.kind === "cli") return registerCliAgent(this.models, { id }).id;
    this.models.register({ id: connectionId(row), name: row.name, model: "codex app-server",
      provider: new CodexAppServerProvider(row.command!, this.startAppServer, this.version) });
    return connectionId(row);
  }

  add(id: string): { id: string; connection: string } {
    requireAsk(this.store, this.owner, "runtimes");
    const connection = this.register(id);
    this.store.save("settings", this.owner, addedKey, { added: [...new Set([...this.added(), id])] });
    return { id, connection };
  }

  /** Switched off, the added runtimes leave the model list (and are remembered); switched on, they return. */
  follow(on: boolean): void {
    for (const id of this.added()) {
      const row = runtimeRows.find((r) => r.id === id);
      if (!row) continue;
      if (on) this.register(id); else this.removeConnection(row);
    }
  }

  remove(id: string): { removed: boolean } {
    const row = runtimeRows.find((r) => r.id === id);
    if (!row || row.kind === "builtin") throw new Error("That runtime was not found");
    const had = this.added().includes(id);
    forgetRuntimeChoice(this.store, this.owner, id);
    this.removeConnection(row);
    return { removed: had };
  }

  private removeConnection(row: RuntimeRow): void {
    const ids = row.id === "claude-code" ? claudeSubscriptionModels.map((entry) => entry.presetId) : [connectionId(row)];
    for (const id of ids) this.models.remove(id);
  }
}

const connectionId = (row: RuntimeRow): string => (row.kind === "cli" ? `cli-${row.id}` : `runtime-${row.id}`);
