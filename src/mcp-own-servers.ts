/**
 * The owner's own MCP servers, added from the window and kept in the store, loaded the way the launch settings file's
 * servers are (`startMcp`, src/integrations/bootstrap.ts): the same allowlist of tools, the same pinned version, the
 * same on-demand manager and the same malware check.
 *
 * Security (flagged for review):
 * - A server that starts a program on this computer (a command) is saved switched OFF. Switching it on puts a question
 *   through the approval gate, bound to a fingerprint of the exact launch (command, arguments, folder and the names of
 *   the secrets it gets). Only "Yes, just now" or "for this conversation" are offered; a standing "always" is refused,
 *   because it would be a policy rule nothing here reads. The program is started only after that yes.
 * - The yes is kept with the server: while it stays on and its launch is unchanged, Branch starts it again when Branch
 *   starts. Switching it off and on again asks again. A saved launch is never edited; a changed one is a new server.
 * - Before it is added and again before each start, a command fetched from a package registry is looked up in the
 *   malware list. The tools it offers are listed once, after the yes, and pinned with the server's version; later starts
 *   refuse a server whose version changed. Each discovered tool is weighed by the owner's approval settings the way
 *   MCP preflight does (src/mcp-policy.ts): a tool the settings refuse outright is left out, and a server with nothing
 *   left is not started. Every call its tools make still goes through the approval gate like any other tool.
 * - Only the owner's yes starts it: a yes given while the window is switched to a household profile counts as a no.
 * - While Lockdown is on, a command server is not started, by a switch or as Branch starts ("leaving a program running
 *   ... refused outright", src/lockdown.ts).
 * - A server at a web address reaches outside this computer through the owner's network rules; it is saved on.
 * - The yes is bound to the launch line, not to the program's bytes, so nothing the line runs may be in the workspace,
 *   where a task can write: not the program, not the folder it starts in or is moved into, not a file it is given (also
 *   as a file: URL), not inline code or a shell command string that names a place there, not a package taken from
 *   there, including through cmd, a shell, PowerShell, wsl or `python -m` (src/mcp-workspace-guard.ts).
 *   Checked when a server is added and again before every start, including the starts as Branch starts.
 * - Who answered is read when the answer is given (ApprovalGate.onResolved), not when the answer is looked at.
 * - The waiting question's conversation and fingerprint are listed only to the owner at the window.
 * - A start the owner overtook (switched off, removed, started again) never puts its on-demand opener over a newer
 *   start's, so a newer start's tools never open an older launch (hostFor).
 */
export const lockdownStartRefusal = "Lockdown is on, so Branch does not start a program on this computer. Turn Lockdown off first.";
import { createHash } from "node:crypto";
import { z } from "zod";
import { mcpClient } from "./integrations/mcp-sdk.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { audit } from "./audit.js";
import { approvalQuestion, type ApprovalGate, type PendingApproval } from "./approvals.js";
import { askerOf, runOrigin, startedWithShortLivedKey } from "./key-context.js";
import { argumentFingerprint } from "./question-fingerprint.js";
import { evaluatePolicy, readPolicy } from "./policy.js";
import { lockdownActive } from "./lockdown.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { makeTransport, McpTransportSchema, McpCallTimeoutSchema, type McpTransportConfig } from "./integrations/mcp-config.js";
import { mcpToolName } from "./integrations/mcp.js";
import { startMcp, type McpHost } from "./integrations/bootstrap.js";
import { workspaceRefusal } from "./mcp-workspace-guard.js";
import { searchPublicRegistry } from "./mcp-public-registry.js";
import { platformFetch } from "./pinned-fetch.js";

export const AddServerSchema = z.object({
  name: z.string().trim().min(1).max(60),
  server: McpTransportSchema,
  callTimeoutSeconds: McpCallTimeoutSchema.optional(),
  /** The catalogue entry the form was filled from, if it was. */
  catalogue: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
}).strict();

export interface OwnServer {
  id: string; name: string; server: McpTransportConfig; on: boolean;
  /** The launch fingerprint the owner said yes to; null until then (a web address needs none). */
  approved: string | null;
  tools: string[]; version: string | null; hidden: string[]; addedAt: string; catalogue?: string;
  callTimeoutSeconds?: number;
}
const Saved = z.object({ servers: z.array(z.custom<OwnServer>()).max(8).default([]) }).strict();
const key = "mcp-own-servers";
const maxServers = 8;
/** The tool name the start question is asked under; the target is the server's id. */
export const startTool = "mcp.start";
const waitLimitMs = 60 * 60 * 1000;

/** The exact launch, in a fixed order, and its fingerprint: what a yes is bound to. */
export function launchBytes(server: McpTransportConfig): string {
  return server.transport === "stdio"
    ? JSON.stringify({ transport: "stdio", command: server.command, args: server.args, cwd: server.cwd ?? null, envKeys: server.envKeys })
    : JSON.stringify({ transport: "http", url: server.url, bearerEnv: server.bearerEnv ?? null });
}
export const launchFingerprint = (server: McpTransportConfig): string =>
  createHash("sha256").update(launchBytes(server), "utf8").digest("hex").slice(0, 32);
const how = (server: McpTransportConfig): string =>
  server.transport === "stdio" ? `${server.command} ${server.args.join(" ")}`.trim().slice(0, 300) : server.url;
const slug = (name: string): string => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 26);
  return base || "server";
};

export interface OwnServersDeps {
  store: Store; owner: () => string; registry: ToolRegistry; approvals: ApprovalGate; workspace: () => string;
  env?: NodeJS.ProcessEnv; policy: () => NetworkPolicy | undefined; host: () => McpHost | undefined;
  /** The malware check: throws a plain sentence for a package listed as harmful. */
  vet: (command: string, args: readonly string[]) => Promise<void>;
  /** How often a waiting question is looked at again; tests shorten it. */
  pollMs?: number;
}

/**
 * `fingerprint` is the question's own, which its answer names; `launch` is the saved launch's, which the yes is kept
 * against. `byOwner`: set when the question is answered, from that answer's own request; unset means no owner answered it.
 */
interface Waiting { runId: string; sessionId: string; fingerprint: string; launch: string; question: string; timer: NodeJS.Timeout; since: number; byOwner?: boolean }

/** What one start put in place: how to close its connection and program, and the tool names it registered. */
interface Started { close: () => Promise<void>; names: string[] }

export class OwnMcpServers {
  private readonly live = new Map<string, Started>();
  private readonly waiting = new Map<string, Waiting>();
  private readonly problems = new Map<string, string>();
  /**
   * Each server's start generation. A start takes a new one, and switching the server off, removing it or closing
   * Branch takes another, so a start still under way can tell that it was overtaken. Never cleared: a server removed
   * and added again under the same name keeps counting from where it was.
   */
  private readonly generations = new Map<string, number>();
  private launchIds: string[] = [];
  constructor(private readonly deps: OwnServersDeps) {
    deps.approvals.onResolved((taken) => this.answered(taken));
  }
  /** Read-only public discovery, using today's network policy. No package is installed or started. */
  async searchRegistry(input: unknown) {
    const policy = this.deps.policy();
    if (!policy) throw new Error("The network policy is not ready. Try again after Branch has started.");
    return searchPublicRegistry(input, policy.guard(platformFetch));
  }
  private get env(): NodeJS.ProcessEnv { return this.deps.env ?? process.env; }
  /** Refuses a launch that runs anything inside the workspace, in plain words. */
  private guard(server: McpTransportConfig): void {
    const refusal = workspaceRefusal(server, this.deps.workspace(), this.env);
    if (refusal) throw new Error(refusal);
  }
  /** A start question answered: whether the owner, at the window, gave the answer is kept with it. */
  private answered(taken: PendingApproval): void {
    if (taken.tool !== startTool) return;
    const pending = this.waiting.get(taken.target);
    if (pending && pending.sessionId === taken.sessionId && pending.fingerprint === taken.fingerprint)
      pending.byOwner = this.deps.store.profiles.isOwner() && !startedWithShortLivedKey();
  }

  saved(): OwnServer[] {
    const kept = Saved.safeParse(this.deps.store.get("settings", this.deps.owner(), key)?.data ?? {});
    return kept.success ? kept.data.servers : [];
  }
  private save(servers: OwnServer[]): void { this.deps.store.save("settings", this.deps.owner(), key, { servers }); }
  private update(id: string, patch: Partial<OwnServer>): OwnServer {
    const servers = this.saved();
    const at = servers.findIndex((entry) => entry.id === id);
    if (at < 0) throw new Error("There is no server of yours by that name.");
    servers[at] = { ...servers[at]!, ...patch };
    this.save(servers);
    return servers[at]!;
  }
  private find(id: string): OwnServer {
    const found = this.saved().find((entry) => entry.id === id);
    if (!found) throw new Error("There is no server of yours by that name.");
    return found;
  }

  /** `full`: the owner at the window, who alone is shown what answering the waiting question takes. */
  view(entry: OwnServer, full = true) {
    const pending = this.waiting.get(entry.id);
    const waiting = pending ? (full ? { sessionId: pending.sessionId, fingerprint: pending.fingerprint, question: pending.question } : { question: pending.question }) : null;
    return { id: entry.id, name: entry.name, transport: entry.server.transport, how: how(entry.server), on: entry.on,
      running: this.live.has(entry.id), waiting, callTimeoutSeconds: entry.callTimeoutSeconds ?? 30,
      tools: entry.tools.length, hidden: entry.hidden, error: this.problems.get(entry.id) ?? null, catalogue: entry.catalogue ?? null };
  }
  list(full: boolean) { return { servers: this.saved().map((entry) => this.view(entry, full)) }; }

  /** Written as a connection changing, with what happened in the subject and the outcome. */
  private record(what: string, subject: string, outcome: string): void {
    const owner = this.deps.owner();
    audit(this.deps.store, owner, { action: "connection.changed", actor: owner, subject: `${what} ${subject}`.slice(0, 300),
      reason: "Your own tool servers, from Customize", source: "owner", outcome });
  }

  /** Adds one server. A command is saved off; a web address is saved on and connected now. */
  async add(input: unknown) {
    const wanted = AddServerSchema.parse(input);
    const servers = this.saved();
    if (servers.length >= maxServers) throw new Error(`Branch keeps at most ${maxServers} servers of your own. Remove one first.`);
    if (wanted.server.transport === "stdio") { this.guard(wanted.server); await this.deps.vet(wanted.server.command, wanted.server.args); }
    const taken = new Set([...this.launchIds, ...servers.map((entry) => entry.id)]);
    let id = slug(wanted.name);
    for (let n = 2; taken.has(id); n++) id = `${slug(wanted.name)}-${n}`;
    const entry: OwnServer = { id, name: wanted.name, server: wanted.server, on: false, approved: null, tools: [], version: null,
      hidden: [], addedAt: new Date().toISOString(), ...(wanted.catalogue ? { catalogue: wanted.catalogue } : {}),
      ...(wanted.callTimeoutSeconds !== undefined ? { callTimeoutSeconds: wanted.callTimeoutSeconds } : {}) };
    this.save([...servers, entry]);
    this.record("Tool server added:", `${entry.name}: ${how(entry.server)}`, entry.server.transport === "stdio" ? "saved off" : "saved on");
    if (entry.server.transport === "stdio") return { server: this.view(entry), said: `${entry.name} is added. It is off until you switch it on and say yes.` };
    await this.open(entry, true).catch(() => undefined);
    return { server: this.view(this.find(id)), said: this.problems.get(id) ?? `${entry.name} is added.` };
  }

  /** Switching a server on. A command asks first, through the approval gate; a web address connects now. */
  async start(id: string) {
    const entry = this.find(id);
    if (this.live.has(id)) return { server: this.view(entry), said: `${entry.name} is on.` };
    if (entry.server.transport === "http") {
      await this.open(entry, entry.tools.length === 0);
      return { server: this.view(this.find(id)), said: `${entry.name} is on.` };
    }
    if (lockdownActive(this.deps.store, this.deps.owner())) throw new Error(lockdownStartRefusal);
    this.guard(entry.server);
    await this.deps.vet(entry.server.command, entry.server.args);
    const pending = this.waiting.get(id) ?? this.ask(entry);
    return { server: this.view(entry), said: pending.question };
  }

  /** Change while off so cached openers and in-flight calls retain their original deadline. */
  setCallTimeout(id: string, seconds: unknown) {
    this.deps.store.profiles.requireOwner("Changing a tool server timeout");
    if (startedWithShortLivedKey()) throw new Error("Change the timeout from the owner window.");
    const callTimeoutSeconds = McpCallTimeoutSchema.parse(seconds);
    const entry = this.find(id);
    if (entry.on || this.live.has(id) || this.waiting.has(id))
      throw new Error("Switch this server off before changing its timeout.");
    this.nextGeneration(id); // A start still connecting may not install an opener with the old timeout.
    const updated = this.update(id, { callTimeoutSeconds });
    this.record("Tool server timeout changed:", `${entry.name}: ${callTimeoutSeconds} seconds without progress`, "saved");
    return { server: this.view(updated), said: "The new timeout applies when you switch this server on." };
  }

  private ask(entry: OwnServer): Waiting {
    const store = this.deps.store, owner = this.deps.owner();
    const bytes = launchBytes(entry.server), launch = launchFingerprint(entry.server);
    const fingerprint = argumentFingerprint(startTool, bytes);
    const label = `Start a program on this computer for your ${entry.name} server: ${how(entry.server)}`;
    const question = approvalQuestion(label, "");
    const run = store.createRun(owner, `Switch on the ${entry.name} server`);
    this.deps.approvals.ask({ runId: run.id, sessionId: run.sessionId, tool: startTool, target: entry.id, label, question,
      source: "owner", remember: "never", askedAt: new Date().toISOString(), bytes, fingerprint, noStanding: true, noAlways: true });
    store.event(run.id, "policy.ask", { name: startTool, label, target: entry.id, remember: "never", question, bytes, fingerprint });
    store.finish(run.id, "needs_input", question);
    // The question is written into the switch's own conversation, so "Open" shows it with its card. Written after the
    // stop, it also means a window's "carry on" after the yes never starts a model turn here (src/server.ts settleAsked
    // carries on only when nothing was written since the task stopped); starting the program is this class's job.
    store.message(run.sessionId, { role: "assistant", content: question });
    const waiting: Waiting = { runId: run.id, sessionId: run.sessionId, fingerprint, launch, question, since: Date.now(),
      timer: setInterval(() => void this.check(entry.id), this.deps.pollMs ?? 250) };
    waiting.timer.unref?.();
    this.waiting.set(entry.id, waiting);
    return waiting;
  }

  /** Looks at a waiting question: still waiting, answered yes (the program starts), or anything else (it stays off). */
  private async check(id: string): Promise<void> {
    const pending = this.waiting.get(id);
    if (!pending) return;
    const gate = this.deps.approvals, store = this.deps.store;
    const open = gate.questionFor(pending.sessionId, pending.fingerprint);
    if (open && Date.now() - pending.since < waitLimitMs) return;
    this.stopWaiting(id);
    if (open) { gate.resolve(pending.sessionId, pending.fingerprint); store.finish(pending.runId, "cancelled", "Nobody answered."); return; }
    const asker = askerOf(runOrigin(store, pending.runId));
    const said = gate.answer(pending.sessionId, startTool, id, pending.fingerprint, true) === "allow"
      || gate.takeJustNow(pending.sessionId, startTool, pending.fingerprint, asker);
    // A yes from a household profile at the window is not the owner's: the program stays off. Who answered was read
    // when the answer was given, so switching back to the owner before this look changes nothing.
    const yes = said && pending.byOwner === true && !lockdownActive(store, this.deps.owner());
    store.finish(pending.runId, "completed", yes ? "You said yes." : "You said no.");
    if (!yes) return;
    const entry = this.saved().find((item) => item.id === id);
    if (entry && launchFingerprint(entry.server) === pending.launch) await this.open(entry, true, pending.launch).catch(() => undefined);
  }
  private stopWaiting(id: string): void {
    const pending = this.waiting.get(id);
    if (pending) clearInterval(pending.timer);
    this.waiting.delete(id);
  }

  /** Lists what a server offers now (after the yes), keeping only what the owner's settings do not refuse outright. */
  private async listTools(entry: OwnServer): Promise<{ tools: string[]; hidden: string[]; version: string }> {
    const { transport } = await makeTransport(entry.server, this.env, this.deps.policy());
    const client = new (await mcpClient())({ name: "branch", version: "0.1.0" });
    try {
      await client.connect(transport as Transport, { timeout: 20000 });
      const listed = await client.listTools({}, { timeout: 20000 });
      const names = listed.tools.slice(0, 64).map((tool) => tool.name);
      const policy = readPolicy(this.deps.store, this.deps.owner());
      const refused = (name: string) => evaluatePolicy(policy, { tool: mcpToolName(entry.id, name), target: "", readOnly: false }).decision === "deny";
      return { tools: names.filter((name) => !refused(name)), hidden: names.filter(refused), version: client.getServerVersion()?.version ?? "" };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private nextGeneration(id: string): number {
    const next = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, next);
    return next;
  }
  /** A start is still wanted while it is its server's latest and the server is still saved with the same launch. */
  private stillWanted(entry: OwnServer, generation: number): boolean {
    if (this.generations.get(entry.id) !== generation) return false;
    const launch = launchFingerprint(entry.server);
    return this.saved().some((item) => item.id === entry.id && launchFingerprint(item.server) === launch);
  }

  /**
   * Starts a server the way the launch file's are started, and marks it on. A failure is kept as its problem.
   * After every wait it checks the start is still wanted: one the owner overtook (switched off, removed or started
   * again) lets go of whatever it started and records nothing, since the owner's newer action says what the server is.
   */
  private async open(entry: OwnServer, list: boolean, approved: string | null = entry.approved): Promise<void> {
    const generation = this.nextGeneration(entry.id);
    const overtaken = `${entry.name} did not finish starting: it was switched off, removed or started again first.`;
    let started: Started | undefined;
    try {
      if (entry.server.transport === "stdio") { this.guard(entry.server); await this.deps.vet(entry.server.command, entry.server.args); }
      if (!this.stillWanted(entry, generation)) throw new Error(overtaken);
      const found = list ? await this.listTools(entry) : { tools: entry.tools, hidden: entry.hidden, version: entry.version ?? "" };
      if (!this.stillWanted(entry, generation)) throw new Error(overtaken);
      if (!found.tools.length) throw new Error("Your approval settings refuse every tool this server offers, so it was not started.");
      if (!found.version) throw new Error("That server did not say which version it is.");
      const config = { id: entry.id, tools: found.tools, expectedVersion: found.version, ...entry.server,
        ...(entry.callTimeoutSeconds !== undefined ? { callTimeoutSeconds: entry.callTimeoutSeconds } : {}) };
      const stop = await startMcp(this.deps.registry, config, this.env, this.deps.policy(), this.hostFor(entry, generation, overtaken));
      started = { close: stop ?? (async () => undefined), names: found.tools.map((tool) => mcpToolName(entry.id, tool)) };
      if (!this.stillWanted(entry, generation)) throw new Error(overtaken);
      this.live.set(entry.id, started);
      this.problems.delete(entry.id);
      this.update(entry.id, { on: true, approved, tools: found.tools, hidden: found.hidden, version: found.version });
      this.record("Tool server started:", `${entry.name}: ${found.tools.length} tools`, "started");
    } catch (error) {
      if (!this.stillWanted(entry, generation)) { await this.letGo(entry.id, started); throw new Error(overtaken); }
      const reason = (error instanceof Error ? error.message : "It did not answer").slice(0, 300);
      this.problems.set(entry.id, reason);
      if (this.saved().some((item) => item.id === entry.id)) this.update(entry.id, { on: false });
      this.record("Tool server started:", `${entry.name}: ${reason}`, "failed");
      throw new Error(reason);
    }
  }

  /**
   * The host one start hands to startMcp. On demand, startMcp puts the server's opener in place after a wait (the
   * malware check). A start overtaken during that wait must not put its opener over a newer start's: the newer start's
   * tools would then open the older launch, which the owner may have removed or never said yes to again. So the opener
   * goes in only while this start is still wanted, checked in the same step as putting it in.
   */
  private hostFor(entry: OwnServer, generation: number, overtaken: string): McpHost | undefined {
    const host = this.deps.host();
    if (!host) return undefined;
    const connections = host.connections;
    return { ...host,
      // Before its program is started again (after a crash, or on demand), the checks switching it on made (the malware check runs
      // again on its own): nothing it runs is in the workspace, Lockdown is off, and the owner still wants it.
      beforeRestart: () => {
        this.guard(entry.server);
        if (!this.stillWanted(entry, generation)) throw new Error(overtaken);
        if (entry.server.transport === "stdio" && lockdownActive(this.deps.store, this.deps.owner())) throw new Error(lockdownStartRefusal);
      },
      connections: {
      register: (id, opener) => {
        if (!this.stillWanted(entry, generation)) throw new Error(overtaken);
        connections.register(id, opener);
      },
      acquire: (runId, id) => connections.acquire(runId, id),
      forget: async (id) => { await connections.forget?.(id); },
    } };
  }

  /**
   * Lets go of what an overtaken start had started: its tools first, in the same step as the check that found it
   * overtaken, so a newer start's tools of the same names are never touched; then its on-demand entry, then its
   * connection, which ends its program.
   */
  private async letGo(id: string, started: Started | undefined): Promise<void> {
    if (!started) return;
    for (const name of started.names) this.deps.registry.unregister(name);
    await this.deps.host()?.connections.forget?.(id);
    await started.close().catch(() => undefined);
  }

  private async shut(id: string): Promise<void> {
    this.nextGeneration(id); // a start still under way is overtaken, and lets go of what it started (open)
    this.stopWaiting(id);
    const running = this.live.get(id);
    this.live.delete(id);
    await this.deps.host()?.connections.forget?.(id);
    if (running) {
      await running.close().catch(() => undefined);
      for (const name of running.names) this.deps.registry.unregister(name);
    }
  }

  async stop(id: string) {
    const entry = this.find(id);
    await this.shut(id);
    const saved = this.update(id, { on: false });
    this.record("Tool server switched off:", entry.name, "stopped");
    return { server: this.view(saved), said: `${entry.name} is off.` };
  }

  async remove(id: string) {
    const entry = this.find(id);
    await this.shut(id);
    this.problems.delete(id);
    this.save(this.saved().filter((item) => item.id !== id));
    this.record("Tool server removed:", `${entry.name}: ${how(entry.server)}`, "removed");
    return { removed: id, said: `${entry.name} is removed.` };
  }

  /**
   * As Branch starts: every server left on starts again, a command only when its launch is the one the owner said yes
   * to. The launch file's server ids are noted so a new server of the owner's never takes one of them.
   */
  async startSaved(launchIds: readonly string[]): Promise<void> {
    this.launchIds = [...launchIds];
    for (const entry of this.saved()) {
      if (!entry.on || this.launchIds.includes(entry.id)) continue;
      if (entry.server.transport === "stdio" && (entry.approved !== launchFingerprint(entry.server) || lockdownActive(this.deps.store, this.deps.owner()))) { this.update(entry.id, { on: false }); continue; }
      await this.open(entry, entry.tools.length === 0).catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    // A start still under way is overtaken too: it lets go of what it started once its current step returns.
    for (const id of [...this.generations.keys()]) this.nextGeneration(id);
    for (const id of [...this.waiting.keys()]) this.stopWaiting(id);
    for (const id of [...this.live.keys()]) await this.shut(id);
  }
}
