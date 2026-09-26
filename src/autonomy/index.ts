import type { ToolContext } from "../contracts.js";
import type { HandoffParts } from "../interop/handoff.js";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import type { Scheduler } from "../scheduler.js";
import { blueprint, draftSchedule } from "./blueprints.js";
import { registerPromptSource } from "./hooks.js";
import { Instructions, spotInstruction } from "./instructions.js";
import { fingerprintOf, Ledger, type LedgerEntry } from "./ledger.js";
import { Loops } from "./loops.js";
import { Orders } from "./orders.js";
import { SelfStarting } from "./procedures.js";
import { checkReadiness, localProbe, needsFromMetadata, type Missing, type Needs } from "./readiness.js";
import { lockedDown } from "../lockdown.js";
import { ownersOwnTask } from "./origin.js";
import { narrowed, Runner } from "./runner.js";
import { autonomyMode, autonomyParts, autonomyTools, saveAutonomyMode, type AutonomyMode, type AutonomyPart } from "./settings.js";
import { suggest, type Suggestion } from "./suggestions.js";
import { registerAutonomyTools } from "./tools.js";
import { ownerTimezone } from "../person-about.js"; // your-profile

/**
 * Bucket R17-B: it suggests, and runs things on its own. `createBranch` makes one of these; the server
 * hands it /api/autonomy/, the scheduler's beat drives its clocks, and the runtime asks it for the
 * standing orders and instructions a task should know. Every part ships off. See
 * docs/configuration.md, "It suggests, and runs things on its own".
 */
export interface ChatsHost {
  chats(owner: string): { channel: string; chatId: string; title: string; updatedAt: string }[];
  link(owner: string, input: unknown): unknown;
  deliver(channel: string, chatId: string, text: string, key?: string): Promise<unknown>;
  summary(): { channels: { id: string; kind: string }[] };
}

export interface AutonomyDeps {
  runtime: Runtime; registry: ToolRegistry; scheduler: Scheduler; chats: ChatsHost;
  /** Whether a secret of this name is kept (never its value). */
  hasSecret: (name: string) => boolean;
  /** Handing a conversation to a terminal or another assistant (mac4/bucket-20), behind its own switch. */
  handoff?: HandoffParts;
  /** Ships-on sweep (2026-09-26): tools that are listed but whose service nobody set up, so no suggestion reads them as connected. */
  unsetTools?: () => readonly string[];
  now?: () => Date;
}

export interface SkillReadiness { id: string; name: string; needs: Needs | null; ready: boolean; missing: Missing[] }

const byRuntime = new WeakMap<object, Autonomy>();
/** The runner keys each part's turns count under (src/autonomy/runner.ts `TurnRequest.key`). */
const turnPrefixes: Record<AutonomyPart, readonly string[]> = {
  orders: ["order:"], procedures: ["procedure:"], loops: ["loop:", "heartbeat:"],
  suggestions: [], "session-commands": [], readiness: [], instructions: [],
};
/** The part of Branch the typed commands reach, for this runtime (src/autonomy/commands.ts). */
export const autonomyFor = (runtime: object): Autonomy | undefined => byRuntime.get(runtime);

export class Autonomy {
  readonly ledger: Ledger;
  readonly runner: Runner;
  readonly orders: Orders;
  readonly procedures: SelfStarting;
  readonly instructions: Instructions;
  readonly loops: Loops;
  private beat: Promise<void> | null = null;
  private closed = false;

  constructor(readonly deps: AutonomyDeps) {
    const { runtime } = deps, store = runtime.store, owner = runtime.owner;
    const now = deps.now ?? (() => new Date());
    const held = (): string[] => deps.registry.permissions();
    this.ledger = new Ledger(store, owner, now);
    this.runner = new Runner(store, runtime, held, now);
    this.orders = new Orders({ store, owner, runner: this.runner, ledger: this.ledger, held, now });
    this.procedures = new SelfStarting({ store, owner, runner: this.runner, ledger: this.ledger, held, now });
    this.instructions = new Instructions(store, owner, this.ledger, now);
    this.loops = new Loops({ store, owner, runner: this.runner, now, transcript: (id) => this.transcript(id) });
    for (const part of autonomyParts) this.sync(part);
    this.procedures.recover();
    deps.registry.onRunFinished((context) => this.afterTask(context));
    byRuntime.set(runtime, this);
    registerPromptSource(runtime, this);
  }

  get store() { return this.deps.runtime.store; }
  get owner() { return this.deps.runtime.owner; }
  mode(part: AutonomyPart): AutonomyMode { return autonomyMode(this.store, this.owner, part); }
  modes(): Record<AutonomyPart, AutonomyMode> {
    return Object.fromEntries(autonomyParts.map((part) => [part, this.mode(part)])) as Record<AutonomyPart, AutonomyMode>;
  }

  /** A part's tools are in the catalog exactly while its switch is not off. */
  private sync(part: AutonomyPart): void {
    for (const name of autonomyTools[part]) this.deps.registry.unregister(name);
    if (this.mode(part) !== "off") registerAutonomyTools(this.deps.registry, this, part);
  }

  setMode(part: AutonomyPart, input: unknown): AutonomyMode {
    const mode = saveAutonomyMode(this.store, this.owner, part, input);
    this.sync(part);
    // Switched off: the turns of that part that are working now are cancelled too.
    const prefixes = turnPrefixes[part];
    if (mode === "off" && prefixes.length) this.runner.cancel((key) => prefixes.some((prefix) => key.startsWith(prefix)));
    return mode;
  }

  /** The scheduler's beat. Overlapping beats are skipped; nothing here holds the beat up. */
  tick(): Promise<void> {
    // Under Lockdown nothing runs by itself, and whatever is working is cancelled at the next beat.
    if (lockedDown(this.store, this.owner)) { this.runner.cancel(); return Promise.resolve(); }
    if (this.beat || this.closed) return Promise.resolve();
    this.beat = this.work().finally(() => { this.beat = null; });
    return Promise.resolve();
  }
  /** Resolves once the beat that is running, and every procedure step it started, has settled. */
  async idle(): Promise<void> { await this.beat; await this.procedures.idle(); }
  private async work(): Promise<void> {
    if (this.mode("orders") !== "off") await this.orders.tick().catch(() => undefined);
    if (this.mode("procedures") !== "off") await this.procedures.tick().catch(() => undefined);
    if (this.mode("loops") !== "off") await this.loops.tick().catch(() => undefined);
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.race([this.idle(), new Promise((done) => setTimeout(done, 5000).unref())]);
  }

  /** After one of the owner's own tasks: triggers that wait for it, and "from now on" in what was asked. */
  private async afterTask(context: ToolContext): Promise<void> {
    const run = context.runId ? this.store.run(context.runId) : undefined;
    if (!run || this.runner.started.has(run.id) || context.depth > 0 || (context.source ?? "owner") !== "owner") return;
    // Only the owner's own words start anything: never a chat sender's, a key's or a household person's.
    if (!ownersOwnTask(this.store, run.id)) return;
    if (this.mode("orders") !== "off") await this.orders.afterTask(run.prompt);
    if (this.mode("procedures") !== "off") this.procedures.afterTask(run.prompt);
    const said = this.mode("instructions") !== "off" && !this.store.sessionTemporary(run.sessionId) ? spotInstruction(run.prompt) : null;
    if (said) {
      try { this.instructions.propose({ text: said, scope: context.agent ? `specialist:${context.agent}` : "assistant" }, "suggestion"); } catch { /* too many waiting */ }
    }
  }

  /** What a task is told about standing orders and instructions, by the runtime hook. */
  instructionsFor(context: { agent?: string | undefined; source?: string | undefined }): string {
    const parts: string[] = [];
    const orders = this.mode("orders"), rules = this.mode("instructions");
    if (rules !== "off") parts.push(this.instructions.forTask(context.agent, rules === "on"));
    if (orders !== "off" && (context.source ?? "owner") === "owner" && !context.agent) parts.push(this.orders.summary(orders === "on"));
    const text = parts.filter(Boolean).join("\n");
    return text ? `\n\n${text}\n` : "";
  }

  private transcript(sessionId: string): string {
    return this.store.messages(sessionId).filter((m) => m.role === "user" || m.role === "assistant").slice(-12)
      .map((m) => `${m.role === "user" ? "Owner" : "Assistant"}: ${this.deps.runtime.hideSecrets(String(m.content)).slice(0, 1500)}`).join("\n");
  }

  /* ---------- suggestions and the catalogue (R17-014, R17-015) ---------- */

  suggestions(starters = false): Suggestion[] {
    const facts = this.store.list("memory", this.owner).map((record) => String((record.data as { text?: unknown }).text ?? ""));
    const inUse = new Set(this.ledger.list("accepted").filter((e) => e.kind === "schedule").map((e) => String(e.payload.blueprint ?? "")));
    const unset = new Set(this.deps.unsetTools?.() ?? []);
    const tools = this.deps.registry.names().filter((name) => !unset.has(name));
    return suggest({ facts, tools, chats: this.deps.chats.chats(this.owner), inUse }, this.ledger, starters);
  }

  /** The owner's answer to a suggestion, on the spot. A yes makes the schedule; a no is kept for good. */
  answerSuggestion(fingerprint: string, yes: boolean, starters = true): { schedule?: unknown; answered: boolean } {
    const found = this.suggestions(starters).find((s) => s.fingerprint === fingerprint);
    if (!found) throw new Error("That suggestion is no longer offered.");
    const entry = { kind: "schedule" as const, from: "suggestion" as const, fingerprint, title: found.title, detail: found.why,
      payload: { blueprint: found.blueprint, values: found.values, ...(found.deliverTo ? { deliverTo: found.deliverTo } : {}) } };
    if (!yes) { this.ledger.record(entry, false); return { answered: true }; }
    const schedule = this.scheduleFrom(entry.payload);
    this.ledger.record(entry, true);
    return { answered: true, schedule };
  }

  /** The owner fills a blueprint in the window: that is their yes, and the schedule is made. */
  fromBlueprint(input: { blueprint: string; values?: Record<string, string> | undefined; timezone?: string | undefined; deliverTo?: { channel: string; chatId: string } | undefined }): unknown {
    const payload = { blueprint: input.blueprint, values: input.values ?? {}, ...(input.timezone ? { timezone: input.timezone } : {}),
      ...(input.deliverTo ? { deliverTo: input.deliverTo } : {}) };
    const schedule = this.scheduleFrom(payload);
    this.ledger.record({ kind: "schedule", from: "suggestion", fingerprint: fingerprintOf("blueprint", payload, Date.now()),
      title: blueprint(input.blueprint).title, detail: "Made from the catalogue.", payload }, true);
    return schedule;
  }

  /** The assistant's proposal of a filled blueprint: checked now, made only on the owner's yes. */
  proposeBlueprint(input: { blueprint: string; values?: Record<string, string> | undefined; timezone?: string | undefined }): { waiting: boolean; id?: string } {
    const entry = blueprint(input.blueprint);
    const payload = { blueprint: entry.id, values: input.values ?? {}, ...(input.timezone ? { timezone: input.timezone } : {}) };
    const draft = this.draft(payload);
    const asked = this.ledger.ask({ kind: "schedule", from: "assistant", fingerprint: fingerprintOf("proposal", entry.id, payload.values),
      title: `Automation: ${entry.title}`, detail: draft.prompt.slice(0, 300), payload });
    return asked ? { waiting: true, id: asked.id } : { waiting: false };
  }

  private draft(payload: Record<string, unknown>) {
    // your-profile: the time zone the owner chose in Your profile, else this computer's.
    const zone = typeof payload.timezone === "string" ? payload.timezone : ownerTimezone(this.store, this.owner);
    const deliver = payload.deliverTo as { channel: string; chatId: string } | undefined;
    const known = deliver && this.deps.chats.chats(this.owner).some((c) => c.channel === deliver.channel && c.chatId === deliver.chatId);
    if (deliver && !known) throw new Error("Results can only go to a chat that has already talked to Branch.");
    return draftSchedule(blueprint(String(payload.blueprint)), (payload.values ?? {}) as Record<string, string>, zone, (this.deps.now ?? (() => new Date()))(), known ? deliver : undefined);
  }

  private scheduleFrom(payload: Record<string, unknown>): unknown {
    const draft = this.draft(payload);
    const context = this.deps.runtime.context({ signal: AbortSignal.timeout(30000), source: "owner" });
    // Only what the owner holds, never more, and never schedules, settings or installing.
    draft.permissions = narrowed(Array.isArray(draft.permissions) ? draft.permissions as string[] : undefined, [...context.permissions]);
    return this.deps.scheduler.create(context, draft);
  }

  /* ---------- the owner's answers (Inbox › Needs you) ---------- */

  decide(id: string, yes: boolean): { entry: LedgerEntry; made?: unknown } {
    const waiting = this.ledger.get(id);
    if (!waiting || waiting.status !== "pending") throw new Error("Nothing waits under that id.");
    // Made first, so a draft that no longer fits stays waiting with the reason instead of being lost.
    const made = yes ? this.apply(waiting) : undefined;
    const entry = this.ledger.settle(id, yes);
    if (entry.kind === "start" || entry.kind === "step") this.procedures.answered(entry, yes);
    if (entry.kind === "escalation" && yes && typeof entry.payload.orderId === "string") {
      try { this.orders.setPaused(entry.payload.orderId, false); } catch { /* the order was removed */ }
    }
    return { entry, ...(made === undefined ? {} : { made }) };
  }

  private apply(entry: LedgerEntry): unknown {
    if (entry.kind === "schedule") return this.scheduleFrom(entry.payload);
    if (entry.kind === "order") return this.orders.create(entry.payload.order);
    // A change the owner proposed to a kept procedure names it; a new one does not.
    if (entry.kind === "procedure") return entry.payload.procedureId === undefined ? this.procedures.create(entry.payload.procedure) : this.procedures.applyChange(entry.payload);
    if (entry.kind === "instruction") return this.instructions.add(entry.payload);
    return undefined;
  }

  /* ---------- readiness (R17-020) ---------- */

  readiness(): SkillReadiness[] {
    const probe = localProbe(this.deps.hasSecret);
    return this.store.skills.list(this.owner).flatMap((skill): SkillReadiness[] => {
      const version = skill.activeVersion ?? skill.headVersion;
      const metadata = this.store.skills.read(this.owner, skill.id, { version }).metadata.metadata;
      try {
        const needs = needsFromMetadata(metadata);
        return needs ? [{ id: skill.id, name: skill.name, needs, ...checkReadiness(needs, probe) }] : [];
      } catch (error) {
        return [{ id: skill.id, name: skill.name, needs: null, ready: false,
          missing: [{ kind: "system" as const, name: "declaration", fix: `What it says it needs cannot be read: ${(error as Error).message.slice(0, 200)}` }] }];
      }
    });
  }
}

export { autonomyParts, autonomyLabels, autonomyTools } from "./settings.js";
