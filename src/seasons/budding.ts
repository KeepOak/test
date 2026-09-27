import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Run, ToolContext } from "../contracts.js";
import type { Runtime } from "../runtime.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolScripts } from "../safety-extras/tool-scripts.js";
import { windowsScriptRefusal } from "../safety-extras/tool-scripts.js";
import { mcpCatalogue } from "../mcp-catalogue.js";
import type { Store } from "../store.js";
import type { Gardener } from "./gardener.js";
import { typedBy } from "./evidence.js";
import type { OwnMcpServers } from "../mcp-own-servers.js";
import type { SourceChangeRequests } from "../self-development-requests.js";
import { lockdownActive } from "../lockdown.js";

export const gapMarker = "BUDDING_GAP:";
const prefix = "plugin.bud-";
export const BuildBudSchema = z.object({
  id: z.string().uuid(), name: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/),
  description: z.string().trim().min(1).max(200),
  /** Defines async function build(input, branch). All code executes only behind the held wall. */
  source: z.string().min(1).max(16000),
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/)).min(1).max(16),
  tests: z.array(z.object({ input: z.record(z.string(), z.unknown()), expected: z.unknown() }).strict()).min(1).max(10),
}).strict();
type Built = z.infer<typeof BuildBudSchema>;
export interface Bud {
  id: string; runId: string; task: string; gap: string;
  stage: "composing" | "connector-review" | "sandbox-ready" | "tested" | "completed" | "branch-review" | "failed";
  connectors: { id: string; name: string; description: string; needs: string }[];
  tool: string | null; output: string | null; error: string | null;
  createdAt: string; updatedAt: string; built?: Built;
  serverId?: string; approvedConnectorId?: string; requestId?: string;
  permissions?: string[]; sessionId?: string; trunkId?: string; resuming?: boolean; resumeRunId?: string;
  requestedVersion?: string; branchConfirmed?: boolean;
}
interface BudDeps {
  store: Store; runtime: Runtime; registry: ToolRegistry; gardener: Gardener;
  scripts: Pick<ToolScripts, "run">;
  servers: Pick<OwnMcpServers, "add" | "start">;
  sourceRequests: Pick<SourceChangeRequests, "file" | "list">;
  version?: string;
  platform?: string;
}

/** Budding preserves the original request and climbs only after a cheaper rung failed. */
export class Budding {
  private inFlight: Promise<void> | null = null;
  private readonly stopping = new AbortController();
  constructor(private readonly deps: BudDeps) {
    deps.store.sqlite.exec("CREATE TABLE IF NOT EXISTS seasons_buds(id TEXT PRIMARY KEY,owner TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL)");
    if ((deps.platform ?? process.platform) !== "win32") for (const bud of this.list()) {
      if (bud.built && bud.tool && ["tested", "completed"].includes(bud.stage) && !deps.registry.names().includes(bud.tool))
        this.register(BuildBudSchema.parse(bud.built), bud.tool);
    }
  }
  list(): Bud[] {
    return this.deps.store.sqlite.prepare("SELECT data FROM seasons_buds WHERE owner=? ORDER BY updated_at DESC LIMIT 200").all(this.deps.runtime.owner)
      .map((row) => JSON.parse(String(row.data)) as Bud);
  }
  get(id: string): Bud {
    const row = this.deps.store.sqlite.prepare("SELECT data FROM seasons_buds WHERE owner=? AND id=?").get(this.deps.runtime.owner, id);
    if (!row) throw new Error("There is no such capability request");
    return JSON.parse(String(row.data)) as Bud;
  }
  private save(bud: Bud): Bud {
    const saved = { ...bud, updatedAt: new Date().toISOString() };
    this.deps.store.sqlite.prepare("INSERT INTO seasons_buds VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at")
      .run(bud.id, this.deps.runtime.owner, JSON.stringify(saved), saved.updatedAt);
    return saved;
  }
  private ownTask(context: ToolContext): void {
    this.ownerOnly();
    const { store, runtime } = this.deps;
    const run = store.run(context.runId);
    if (store.profiles.scope() !== runtime.owner || !run || !typedBy(store, run, null))
      throw new Error("Building a capability starts from the owner's own task in Branch");
  }
  private ownerOnly(): void {
    if (this.deps.store.profiles.scope() !== this.deps.runtime.owner) throw new Error("Capability decisions belong to the owner");
    if (lockdownActive(this.deps.store, this.deps.runtime.owner)) throw new Error("Budding waits while Lockdown is on");
  }
  async start(task: string, gap: string, context: ToolContext): Promise<Bud> {
    this.ownTask(context);
    const pending = this.deps.store.sqlite.prepare("SELECT COUNT(*) AS n FROM seasons_buds WHERE owner=? AND json_extract(data,'$.stage') NOT IN ('completed','failed')").get(this.deps.runtime.owner);
    if (Number(pending?.n) >= 20) throw new Error("Finish a waiting capability request first");
    const now = new Date().toISOString();
    const bud = this.save({ id: randomUUID(), task, gap, runId: context.runId, stage: "composing", connectors: [], tool: null, output: null, error: null,
      createdAt: now, updatedAt: now, permissions: [...context.permissions].filter((p) => p !== "learning.bud"),
      sessionId: this.deps.store.run(context.runId)!.sessionId, ...(context.trunk ? { trunkId: context.trunk } : {}) });
    const composed = await this.compose(bud, context);
    if (composed.stage === "completed") return composed;
    const tokens = new Set(gap.toLowerCase().match(/[a-z]{3,}/g) ?? []);
    const connectors = mcpCatalogue().connectors.filter((c) => [...tokens].some((word) => `${c.name} ${c.description}`.toLowerCase().includes(word)))
      .slice(0, 5).map(({ id, name, description, needs }) => ({ id, name, description, needs }));
    return this.save({ ...composed, connectors, stage: connectors.length ? "connector-review" : "sandbox-ready" });
  }
  private async compose(bud: Bud, context: ToolContext): Promise<Bud> {
    const permissions = [...context.permissions].filter((p) => p !== "learning.bud");
    let run: Run;
    try { run = await this.deps.runtime.delegate(bud.task, context, permissions,
      `Finish the original task using the tools already available. Do not install or build anything. If the current tools cannot do it, begin your answer with ${gapMarker} and explain the missing capability.`, { timeoutMs: 120000 }); }
    catch (error) { return this.save({ ...bud, error: error instanceof Error ? error.message : String(error) }); }
    if (run.status !== "completed" || run.output.includes(gapMarker)) return this.save({ ...bud, output: run.output, error: run.status === "completed" ? null : run.output || run.status });
    this.deps.gardener.plantBud({ evidence: `Composed existing tools to finish: ${bud.task}\n${run.output}`, tasks: [{ prompt: bud.task, runId: run.id }], sourceRunIds: [bud.runId, run.id] });
    return this.save({ ...bud, stage: "completed", output: run.output, error: null });
  }
  /** An owner's refusal or unsuitable connector lets the ladder continue; no installation occurs here. */
  declineConnector(id: string): Bud {
    this.ownerOnly();
    const bud = this.get(id);
    if (bud.stage !== "connector-review") throw new Error("No connector is waiting for your decision");
    return this.save({ ...bud, stage: "sandbox-ready" });
  }
  /** The item is approved by the owner; command servers still use the ordinary exact launch approval. */
  async approveConnector(id: string, connectorId: string): Promise<Bud> {
    this.ownerOnly();
    const bud = this.get(id);
    if (bud.stage !== "connector-review" || !bud.connectors.some((c) => c.id === connectorId)) throw new Error("That connector is not waiting for approval");
    if (bud.serverId) {
      if (bud.approvedConnectorId !== connectorId) throw new Error("This request already has a different approved connector");
      await this.deps.servers.start(bud.serverId);
      return bud;
    }
    const connector = mcpCatalogue().connectors.find((c) => c.id === connectorId)!;
    if (!connector.address && !connector.command) throw new Error("This connector needs its address or command supplied in Customize → Tool servers");
    const server = connector.address ? { transport: "http", url: connector.address }
      : { transport: "stdio", command: connector.command![0], args: connector.command!.slice(1) };
    const added = await this.deps.servers.add({ name: connector.name, server, catalogue: connector.id });
    const serverId = added.server.id;
    const saved = this.save({ ...bud, serverId, approvedConnectorId: connectorId, error: null });
    await this.deps.servers.start(serverId);
    return saved;
  }
  /** Re-use the original request after an approved connector arrives, under the current task's normal permissions. */
  async retry(id: string, context: ToolContext): Promise<Bud> {
    this.ownTask(context);
    const bud = this.get(id);
    if (!["connector-review", "tested", "branch-review"].includes(bud.stage)) throw new Error("No reviewed capability is waiting to finish this task");
    if (bud.stage === "connector-review" && (!bud.serverId || !this.deps.registry.names().some((name) => this.deps.registry.sourceOf(name) === `mcp:${bud.serverId}`)))
      throw new Error("The approved connector has not connected yet");
    if (bud.stage === "branch-review" && !this.branchArrived(bud)) throw new Error("The reviewed Branch change has not arrived in this version");
    return this.compose(bud, context);
  }
  private branchArrived(bud: Bud): boolean {
    return Boolean(this.deps.version && bud.requestedVersion && this.deps.version !== bud.requestedVersion
      && bud.branchConfirmed);
  }
  /** A version change alone cannot prove that this request's reviewed PR was installed. */
  confirmBranch(id: string): Bud {
    this.ownerOnly();
    const bud = this.get(id);
    if (bud.stage !== "branch-review" || !this.deps.version || this.deps.version === bud.requestedVersion
      || !this.deps.sourceRequests.list().some((request) => request.id === bud.requestId && request.status === "approved"))
      throw new Error("Approve and install the reviewed Branch change before confirming it here");
    return this.save({ ...bud, branchConfirmed: true });
  }
  /** A newly connected, owner-approved MCP server automatically takes up the preserved task once. */
  tick(): Promise<void> {
    if (this.stopping.signal.aborted) return Promise.resolve();
    return this.inFlight ??= this.step().finally(() => { this.inFlight = null; });
  }
  async close(): Promise<void> {
    this.stopping.abort(new Error("Branch is closing"));
    await this.inFlight;
  }
  private async step(): Promise<void> {
    try { this.ownerOnly(); } catch { return; }
    const waiting = this.deps.store.sqlite.prepare("SELECT data FROM seasons_buds WHERE owner=? AND json_extract(data,'$.stage') IN ('connector-review','branch-review') ORDER BY updated_at LIMIT 20")
      .all(this.deps.runtime.owner).map((row) => JSON.parse(String(row.data)) as Bud);
    for (const previous of waiting.filter((b) => b.resuming)) {
      const run = previous.resumeRunId ? this.deps.store.run(previous.resumeRunId) : null;
      if (run && ["running", "needs_input"].includes(run.status)) continue;
      if (run?.status === "completed") this.finish(previous, run);
      else this.save({ ...previous, stage: "failed", resuming: false, error: run?.status === "interrupted"
        ? "Branch restarted during this task. Continue its interrupted conversation to pick up the saved work."
        : "The previous task did not finish. Its saved conversation remains available; no work was replayed." });
    }
    const bud = waiting.find((b) => !b.resuming && (
      b.stage === "connector-review" && b.serverId && this.deps.registry.names().some((name) => this.deps.registry.sourceOf(name) === `mcp:${b.serverId}`)
      || b.stage === "branch-review" && this.branchArrived(b)));
    if (!bud) return;
    this.save({ ...bud, resuming: true });
    try {
      // Only the exact connector the owner approved contributes new permissions after hot reload.
      const added = bud.serverId ? this.deps.registry.inventory().filter((tool) => this.deps.registry.sourceOf(tool.name) === `mcp:${bud.serverId}`).map((tool) => tool.permission) : [];
      const run = await this.deps.runtime.run({ prompt: `${bud.task}\nContinue the original task. Do not repeat work already completed. Prior attempt:\n${bud.output ?? ""}`,
        permissions: [...new Set([...(bud.permissions ?? []), ...added])], ...(bud.sessionId ? { sessionId: bud.sessionId } : {}), originFrom: bud.runId,
        signal: this.stopping.signal, onStarted: (started) => { this.save({ ...bud, resuming: true, resumeRunId: started.id }); },
        ...(bud.trunkId ? { trunkId: bud.trunkId } : {}) });
      this.finish(bud, run);
    } catch (error) { this.save({ ...bud, stage: "failed", resuming: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  private finish(bud: Bud, run: Run): void {
    const completed = run.status === "completed" && !run.output.includes(gapMarker);
    if (completed) this.deps.gardener.plantBud({ evidence: `Reviewed capability finished: ${bud.task}\n${run.output}`,
      tasks: [{ prompt: bud.task, runId: run.id }], sourceRunIds: [bud.runId, run.id] });
    this.save({ ...bud, resumeRunId: run.id, stage: completed ? "completed" : "sandbox-ready", output: run.output,
      error: completed ? null : run.output || run.status, resuming: false });
  }
  requestBranch(id: string): Bud {
    this.ownerOnly();
    const bud = this.get(id);
    if (bud.stage !== "sandbox-ready" || !bud.error) throw new Error("Try the held tool before requesting a change to Branch");
    const request = this.deps.sourceRequests.file({ text: `Build the missing capability: ${bud.gap}\nOriginal task: ${bud.task}\nHeld-tool result: ${bud.error}`.slice(0, 4000),
      from: { channel: "seasons", chatId: "budding", senderId: "branch", senderName: "Budding", messageId: bud.id } });
    return this.save({ ...bud, stage: "branch-review", requestId: request.id, requestedVersion: this.deps.version ?? "unknown" });
  }
  async build(input: Built, context: ToolContext): Promise<Bud> {
    this.ownTask(context);
    const args = BuildBudSchema.parse(input), bud = this.get(args.id);
    if (bud.stage !== "sandbox-ready") throw new Error("Complete the cheaper rungs before building this tool");
    if ((this.deps.platform ?? process.platform) === "win32") return this.save({ ...bud, error: windowsScriptRefusal });
    if (!context.permissions.has("code.execute")) throw new Error("This task has not been allowed to run held code");
    if (args.tools.some((tool) => tool === "tools.script" || this.deps.registry.sourceOf(tool)?.startsWith("plugin:bud-")))
      throw new Error("A held capability cannot start another script or held capability");
    if (args.tools.some((tool) => !context.permissions.has(this.deps.registry.permissionOf(tool))))
      throw new Error("A held capability cannot gain tools the original task was not allowed");
    const name = `${prefix}${args.name}.run`;
    if (this.deps.registry.names().includes(name)) throw new Error("That capability name already exists");
    const testSource = `${args.source}\nexport default async function(branch) { for (const test of ${JSON.stringify(args.tests)}) { const actual = await build(test.input, branch); if (JSON.stringify(actual) !== JSON.stringify(test.expected)) throw new Error("Capability test failed"); } return { passed: ${args.tests.length} }; }`;
    const tested = await this.deps.scripts.run({ source: testSource, tools: args.tools, timeoutMs: 60000 }, context);
    if (!tested.ok || (tested.result as { passed?: number } | null)?.passed !== args.tests.length) return this.save({ ...bud, error: tested.error || "Capability tests did not pass" });
    this.register(args, name);
    const saved = this.save({ ...bud, stage: "tested", tool: name, built: args, error: null });
    return this.compose(saved, context);
  }
  private register(args: Built, name: string): void {
    this.deps.registry.register({ name, description: args.description, source: `plugin:bud-${args.name}`, external: true,
      permission: "code.execute", group: "code", parameters: z.record(z.string(), z.unknown()),
      target: () => `a held capability calling ${args.tools.join(", ")}`,
      execute: async (input, context) => this.runBuilt(args, input, context) });
  }
  private async runBuilt(args: Built, input: Record<string, unknown>, context: ToolContext): Promise<unknown> {
    this.ownerOnly();
    if (!context.permissions.has("code.execute")) throw new Error("This task has not been allowed to run held code");
    const source = `${args.source}\nexport default async function(branch) { return build(${JSON.stringify(input)}, branch); }`;
    const answer = await this.deps.scripts.run({ source, tools: args.tools, timeoutMs: 60000 }, context);
    if (!answer.ok) throw new Error(answer.error || "The held capability failed");
    return answer.result;
  }
}

export function registerBudding(registry: ToolRegistry, budding: Budding): void {
  registry.register({ name: "seasons.bud", permission: "learning.bud", group: "learning",
    description: "When a requested capability is missing, preserve the original task and try composing existing tools first. Connector installation and Branch changes wait for the owner's per-item review. Never say the original task is done unless stage is completed.",
    parameters: z.object({ task: z.string().trim().min(1).max(4000), gap: z.string().trim().min(1).max(500) }).strict(),
    target: () => "a capability request", execute: (args, context) => budding.start(args.task, args.gap, context) });
  registry.register({ name: "seasons.build_tool", permission: "learning.bud", group: "learning",
    description: "After cheaper rungs failed, define async function build(input, branch), name every tool it calls, and supply input/expected fixtures. Code is tested behind the held wall before registration, then the original task continues. Network and credentials stay behind ordinary tool approvals; unavailable walls are refused.",
    parameters: BuildBudSchema, target: () => "a held capability", execute: (args, context) => budding.build(args, context) });
  registry.register({ name: "seasons.finish_bud", permission: "learning.bud", group: "learning",
    description: "After a reviewed connector or Branch capability arrives, finish a waiting original task under normal current permissions.",
    parameters: z.object({ id: z.string().uuid() }).strict(), target: () => "a preserved task", execute: (args, context) => budding.retry(args.id, context) });
}
