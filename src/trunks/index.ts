import type { Knowledge } from "../knowledge.js";
import type { ToolRegistry } from "../registry.js";
import type { RunOptions, Runtime } from "../runtime.js";
import type { Scheduler } from "../scheduler.js";
import { noAccounts, keyPlan, type TrunkAccountsPort } from "./accounts.js";
import { pictureAddress } from "./avatar.js";
import { TrunkMessages, registerTrunkMessage } from "./messages.js";
import { registerTrunkPropose, trunkProposeTool } from "./propose.js";
import { setSharedFacts, trunkAgent } from "./memory-scope.js";
import { TrunkCreateSchema, TrunkEditSchema, TrunkRecords, TrunkSchema, type Trunk } from "./record.js";
import { StartsInSchema, cannotStartThere, checkStartsIn, requireStartsHere, startTarget, type Computer, type ComputersPort, type StartElsewhere } from "./starts-in.js"; // Q44
import { TrunkRooms } from "./rooms.js";
import { TrunkConversations } from "./conversations.js"; // phase2/rooms
import { TrunkPause } from "./pause.js"; // eng-trunk-controls
import { TrunkComputers, thisComputer } from "./computers.js"; // P17-D §9

/** Which Trunk a conversation belongs to, and how (phase2/rooms: `room` and `chosen`). */
export interface Owned { trunkId: string; canonical: boolean; room?: boolean; chosen?: boolean }
import { TrunkRoutines } from "./routines.js";
import { allTrunkModes, requireTrunkPart, saveTrunkMode, trunkMode, trunkParts, trunkTools, type TrunkMode, type TrunkPart } from "./settings.js";
import { shapeFor, type TrunkRunShape } from "./shape.js";
import { exportTrunk, importedFields } from "./share.js";
import { TrunkTeaching, type TeachDeps } from "./teach.js";
import { z } from "zod";
import { audit } from "../audit.js";

/**
 * Bucket R17-A (wave mac7): Trunks, Branch's answer to Hermes Bots and Grok Bot. `createBranch` makes
 * one of these; the server hands it /api/trunks. Every part ships off. See docs/configuration.md,
 * "Trunks", and docs/places.md for where each part shows.
 */
export interface TrunksDeps {
  runtime: Runtime;
  registry: ToolRegistry;
  knowledge: Knowledge;
  scheduler: Scheduler;
  workflows: TeachDeps["workflows"];
  /** R17-005: the accounts work (src/accounts/); without it Trunks use the owner's keys. */
  accounts?: TrunkAccountsPort;
  /** Makes a picture from a few words with the connected picture model. */
  picture?: (prompt: string) => Promise<{ bytes: Buffer; mediaType: string }>;
  /** Q44: the owner's paired computers, the only places besides this one a Trunk may start in. */
  computers?: ComputersPort;
}

/** The Trunks of each running Branch, so a command that only has the runtime can reach them. */
const byRuntime = new WeakMap<Runtime, Trunks>();
export const trunksFor = (runtime: Runtime): Trunks | undefined => byRuntime.get(runtime);

const introPrompt = "Introduce yourself to the owner in two or three short sentences: your name, your role, and what you can help with. This is the first message of your own conversation.";
/** Q44: the three-field create, and where it starts, so even its introduction starts in the right place. */
const CreateInput = TrunkCreateSchema.extend({ startsIn: StartsInSchema.optional() }).strict();
const AvatarInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("face"), locked: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal("image"), dataUrl: z.string().max(400_000, "That picture is too large for a Trunk; use one under about 290 KB") }).strict(),
  z.object({ kind: z.literal("generate"), prompt: z.string().trim().min(1).max(500) }).strict(),
]);

export class Trunks {
  readonly records: TrunkRecords;
  readonly rooms: TrunkRooms;
  readonly messages: TrunkMessages;
  readonly routines: TrunkRoutines;
  readonly teaching: TrunkTeaching;
  readonly accounts: TrunkAccountsPort;
  /** phase2/rooms: who answers in each conversation the owner chose a Trunk for (src/trunks/conversations.ts). */
  readonly conversations: TrunkConversations;
  /** eng-trunk-controls: pausing one Trunk or all of them (src/trunks/pause.ts). */
  readonly pause: TrunkPause;
  /** P17-D §9: the computers each Trunk may use and how many tasks it may run at once (src/trunks/computers.ts). */
  readonly computerRule: TrunkComputers;
  /** `room`: a Trunk's side of a room; `chosen`: an ordinary conversation the owner chose it for (phase2/rooms). */
  private owned = new Map<string, Owned>();
  /** phase2/rooms: a room member's conversation → the room's own conversation (whose mode it follows). */
  private followsRoom = new Map<string, string>();
  private readonly introductions = new Set<Promise<unknown>>();
  /** Q44: how a turn would be handed to another computer. Nothing in this build sets it; tests do. */
  startElsewhere: StartElsewhere | null = null;

  constructor(private readonly deps: TrunksDeps) {
    const { runtime, scheduler } = deps;
    const store = runtime.store, owner = runtime.owner;
    this.accounts = deps.accounts ?? noAccounts;
    this.records = new TrunkRecords(store, owner);
    this.rooms = new TrunkRooms({ store, owner, records: this.records, runtime, changed: () => this.refresh(),
      notify: (room, why) => {
        runtime.notifyEvent("approval.needed", { roomId: room.id, sessionId: room.sessionId, question: why });
      } });
    this.conversations = new TrunkConversations({ store, owner, records: this.records, rooms: this.rooms, changed: () => this.refresh(),
      owns: (sessionId) => store.ownsSession(store.profiles.scope(), sessionId) }); // phase2/rooms
    this.messages = new TrunkMessages(store, owner, this.records, runtime);
    this.routines = new TrunkRoutines(store, owner, this.records, scheduler, runtime);
    this.teaching = new TrunkTeaching({ store, owner, records: this.records, routines: this.routines, workflows: deps.workflows,
      scrub: (value) => runtime.hideSecrets(value) });
    this.pause = new TrunkPause({ store, owner, records: this.records, runsOf: (id) => runtime.runsOfTrunk(id),
      cancel: (runId) => runtime.cancel(runId) });
    this.computerRule = new TrunkComputers({ store, owner, records: this.records, computers: () => this.computers(),
      runsOf: (id) => runtime.runsOfTrunk(id) }); // P17-D §9
    this.refresh();
    runtime.trunkShape = (options) => this.shapeOf(options);
    runtime.trunkPaused = (id) => this.pause.refusal(id); // eng-trunk-controls
    runtime.trunkAtOnce = (id) => this.computerRule.atOnceRefusal(id); // P17-D §9
    runtime.trunkKeysFor = (id) => this.records.find(id)?.keys ?? null; // Q114
    runtime.trunkPermissionsFor = (id) => this.shapeOf({ prompt: "", trunkId: id })?.permissions ?? null; // Q119
    runtime.trunkStartsElsewhere = (id) => { // Q144
      const trunk = this.records.find(id);
      try { if (trunk) requireStartsHere(trunk, this.computers()); return null; } catch (error) { return error as Error; }
    };
    runtime.queueGuard = (sessionId) => this.requireQueueable(sessionId); // Q44: every queued message, whoever queues it
    runtime.followUpNotSent = (sessionId, prompt, reason) => this.messages.notSent(sessionId, prompt, reason); // Q44
    runtime.modeFollows = (sessionId) => this.followsRoom.get(sessionId) ?? null; // phase2/rooms
    runtime.roomPattern = (sessionId) => this.rooms.list().find((room) => room.sessionId === sessionId)?.pattern ?? null; // eng-trunk-controls
    byRuntime.set(runtime, this);
    scheduler.routeRun = (id) => this.routines.route(id, this.mode("routines") !== "off",
      (trunk) => this.pause.refusal(trunk.id, "this routine did not run")); // eng-trunk-controls
    scheduler.trunkHeld = (trunkId) => (this.mode("trunks") === "off" ? "Trunks are switched off, so this schedule a Trunk made did not run."
      : this.pause.refusal(trunkId, "this schedule it made did not run")); // eng-trunk-controls
    this.syncTools();
    if (this.mode("rooms") !== "off") this.rooms.resumeAll();
  }

  private get store() { return this.deps.runtime.store; }
  /** Q44: the owner's paired computers, read fresh so a computer removed a moment ago is gone. */
  computers(): Computer[] { return this.deps.computers?.() ?? []; }
  private get owner() { return this.deps.runtime.owner; }
  mode(part: TrunkPart): TrunkMode { return trunkMode(this.store, this.owner, part); }
  modes(): Record<TrunkPart, TrunkMode> { return allTrunkModes(this.store, this.owner); }
  /** Throws the plain refusal of a part that is switched off. */
  require(part: TrunkPart): void { requireTrunkPart(this.store, this.owner, part); }

  /** Saves a switch and puts the part's tools in or takes them out at once. */
  setMode(part: TrunkPart, input: unknown): Record<TrunkPart, TrunkMode> {
    saveTrunkMode(this.store, this.owner, part, input);
    this.syncTools();
    if (this.mode("rooms") !== "off") this.rooms.resumeAll();
    return this.modes();
  }
  private syncTools(): void {
    for (const part of trunkParts) for (const name of trunkTools[part]) this.deps.registry.unregister(name);
    if (this.mode("messages") !== "off") registerTrunkMessage(this.deps.registry, this.messages);
    // "Have Branch make a Trunk": the assistant may propose one while Trunks are on; the owner makes it.
    this.deps.registry.unregister(trunkProposeTool);
    if (this.mode("trunks") !== "off") registerTrunkPropose(this.deps.registry, () => this.require("trunks"));
  }

  /** Which conversations belong to a Trunk; asked on every task, so it is kept in memory. */
  private refresh(): void {
    const owned = new Map<string, Owned>();
    // phase2/rooms: a conversation the owner chose a Trunk for runs as that Trunk; its own chat and its room seats win.
    for (const [session, trunkId] of this.conversations.chosen()) owned.set(session, { trunkId, canonical: false, chosen: true });
    for (const trunk of this.records.list()) {
      owned.set(trunk.chatSessionId, { trunkId: trunk.id, canonical: true });
      setSharedFacts(trunkAgent(trunk.id), trunk.sharedFacts);
    }
    for (const [session, trunkId] of this.rooms.memberConversations()) owned.set(session, { trunkId, canonical: false, room: true });
    this.owned = owned;
    this.followsRoom = this.rooms.memberRooms(); // phase2/rooms
  }
  /** True for a conversation that must never be swept away by the history rule. */
  keeps(sessionId: string): boolean {
    return (this.owned.has(sessionId) && !this.owned.get(sessionId)!.chosen) || this.rooms.list().some((room) => room.sessionId === sessionId);
  }
  trunkForConversation(sessionId: string): Owned | undefined {
    return this.owned.get(sessionId);
  }
  /**
   * Q44: the messages already waiting in this Trunk's conversations when it starts on another computer.
   * They were queued before the move; each is marked not sent when its turn comes (src/runtime.ts).
   */
  waitingElsewhere(trunk: Trunk): { count: number; computer: string | null } | null {
    if (!trunk.startsIn) return null;
    const count = [...this.owned].filter(([, owned]) => owned.trunkId === trunk.id)
      .reduce((sum, [sessionId]) => sum + this.deps.runtime.queued(sessionId).length, 0);
    return count ? { count, computer: this.computers().find((each) => each.id === trunk.startsIn)?.name ?? null } : null;
  }
  /** Q44: a message queued in a Trunk's conversation (its own or a room member's) must be able to start here. */
  requireQueueable(sessionId: string): void {
    const trunk = this.records.find(this.owned.get(sessionId)?.trunkId ?? "");
    if (trunk) requireStartsHere(trunk, this.computers());
    const paused = trunk ? this.pause.refusal(trunk.id, "this message was not sent") : null; // eng-trunk-controls
    if (paused) throw new Error(paused);
  }
  /**
   * eng-trunk-controls: why nothing may start in this conversation now because the Trunk it belongs to is
   * paused, in words, or null. Triggers, standing orders and chat apps ask it before they start anything.
   */
  pausedForConversation(sessionId: string, what: string): string | null {
    const owned = this.owned.get(sessionId);
    return owned ? this.pause.refusal(owned.trunkId, what) : null;
  }

  /** The runtime's hook: a task in a Trunk's conversation, or a routine it owns, runs as that Trunk. */
  shapeOf(options: RunOptions): TrunkRunShape | null {
    // Integrator (R17-A): no switch check here. A Trunk's shape only ever narrows, so a message queued
    // for it before Trunks were switched off never runs with the owner's whole set afterwards.
    const owned = options.sessionId ? this.owned.get(options.sessionId) : undefined;
    const trunkId = options.trunkId ?? owned?.trunkId;
    const trunk = trunkId ? this.records.find(trunkId) : undefined;
    if (!trunk) return null;
    requireStartsHere(trunk, this.computers()); // Q44: a Trunk that starts on another computer is never quietly run here.
    const { runtime, registry } = this.deps;
    const sessionModel = options.sessionId ? !!runtime.models.session(this.owner, options.sessionId).preset : false;
    const shape = shapeFor(trunk, this.records.list(), { available: registry.permissions(), caller: options.permissions,
      messaging: owned?.canonical === true && this.mode("messages") !== "off", sessionModel, agent: trunkAgent(trunk.id),
      roomTurn: owned?.room === true });
    // P17-D §9: a Trunk the owner has not let use this computer never gets its screen, mouse or clipboard.
    if (this.computerRule.allows(trunk.id, thisComputer)) return shape;
    return { ...shape, permissions: shape.permissions.filter((permission) => !permission.startsWith("desktop.")) };
  }

  /** R17-007: the roster the rail shows — each Trunk with its latest message, when, and how many are unread. */
  roster() {
    requireTrunkPart(this.store, this.owner, "trunks");
    const seen = this.seenCounts();
    const trunks = this.records.list().map((trunk) => {
      const messages = this.store.messages(trunk.chatSessionId).filter((m) => m.role === "assistant" || m.role === "user");
      const last = messages.at(-1);
      const replies = this.replies(trunk.chatSessionId);
      const lastRun = this.store.runs(this.owner).find((run) => run.sessionId === trunk.chatSessionId);
      return { ...trunk, latest: last ? { role: last.role, text: last.content.slice(0, 160) } : null,
        at: lastRun?.updatedAt ?? trunk.updatedAt, unread: Math.max(0, replies - (seen[trunk.id] ?? 0)),
        working: lastRun?.status === "running",
        running: this.deps.runtime.runsOfTrunk(trunk.id).length }; // eng-trunk-controls: every task running as it, for "pause now"
    });
    return { trunks, rooms: this.rooms.list().map((room) => ({ id: room.id, name: room.name, members: room.members, people: room.people, needsYou: room.needsYou,
      pinned: room.pinned, section: room.section, order: room.order, picture: room.picture, sessionId: room.sessionId,
      rule: room.rule, pattern: room.pattern, // eng-trunk-controls
      latest: room.events.filter((e) => e.kind === "user" || e.kind === "member").at(-1)?.text.slice(0, 160) ?? null, at: room.updatedAt })) };
  }
  /** What the Trunk said in words, not the steps in between. */
  private replies(sessionId: string): number {
    return this.store.messages(sessionId).filter((m) => m.role === "assistant" && m.content.trim() && !m.toolCalls?.length).length;
  }
  private seenCounts(): Record<string, number> {
    return ((this.store.get("settings", this.owner, "trunk-seen")?.data ?? {}) as { counts?: Record<string, number> }).counts ?? {};
  }
  /** Opening a Trunk's conversation marks what it said as read. */
  markSeen(id: string): { unread: 0 } {
    const trunk = this.records.get(id);
    this.store.save("settings", this.owner, "trunk-seen", { counts: { ...this.seenCounts(), [id]: this.replies(trunk.chatSessionId) } });
    return { unread: 0 };
  }

  private conversation(title: string): string {
    const run = this.store.createRun(this.owner, title);
    this.store.finish(run.id, "completed", "Opened");
    return run.sessionId;
  }
  /** phase2/rooms: a new conversation that a chosen Trunk answers in. */
  startConversation(input: unknown): { sessionId: string } {
    return this.conversations.start(input, (title) => this.conversation(title));
  }
  /** R17-002: the three-field create. The Trunk then introduces itself in its own conversation. */
  create(input: unknown, extra: Partial<Trunk> = {}): Trunk {
    requireTrunkPart(this.store, this.owner, "trunks");
    const { startsIn, ...basic } = CreateInput.parse(input);
    checkStartsIn(startsIn, this.computers()); // Q44: refused before anything is made
    const fields = TrunkSchema.parse({ ...basic, ...(startsIn ? { startsIn } : {}) });
    return this.adopt(fields, extra);
  }
  private adopt(fields: z.infer<typeof TrunkSchema>, extra: Partial<Trunk>, speaks = true): Trunk {
    if (this.records.list().length >= 50) throw new Error("You can have at most 50 Trunks");
    const trunk = this.records.put(this.records.build(fields, this.conversation(`Trunk: ${fields.name}`), extra));
    this.refresh();
    if (speaks) this.introduce(trunk);
    return trunk;
  }
  private introduce(trunk: Trunk): void {
    const work = this.deps.runtime.run({ prompt: introPrompt, system: "trunk-intro", sessionId: trunk.chatSessionId, onTextDelta: () => undefined })
      .then((run) => {
        if (run.status !== "completed")
          this.store.message(trunk.chatSessionId, { role: "assistant", content: `Hello, I am ${trunk.name}${trunk.title ? `, ${trunk.title}` : ""}.` });
      }).catch(() => undefined).finally(() => this.introductions.delete(work));
    this.introductions.add(work);
  }
  /** Waits for the introductions still being written (tests and shutdown). */
  async introduced(): Promise<void> {
    await Promise.all([...this.introductions]);
  }
  /** "Edit Trunk": every field. */
  edit(id: string, input: unknown): Trunk {
    requireTrunkPart(this.store, this.owner, "trunks");
    checkStartsIn(TrunkEditSchema.parse(input).startsIn, this.computers()); // Q44: refused before anything is saved
    const trunk = this.records.edit(id, input);
    this.pushAccounts(trunk);
    this.refresh();
    return trunk;
  }
  /** Removes the Trunk, its routines and its seats in rooms. Its conversations stay in history. */
  remove(id: string): { removed: boolean } {
    this.records.get(id);
    this.routines.removeFor(id);
    for (const room of this.rooms.list().filter((r) => r.members.includes(id))) {
      const members = room.members.filter((m) => m !== id);
      if (members.length >= 2) this.rooms.edit(room.id, { members });
      else this.rooms.remove(room.id);
    }
    this.conversations.forget(id); // phase2/rooms: the conversations it answered in go back to your assistant
    const removed = this.records.remove(id);
    this.refresh();
    return { removed };
  }
  /** R17-001: a specialist brought across, with its evaluated instructions, style and permissions. */
  fromSpecialist(specialistId: string): Trunk {
    requireTrunkPart(this.store, this.owner, "trunks");
    const state = this.store.get("specialists", this.owner, specialistId)?.data as { definition?: { name?: string } } | undefined;
    if (!state?.definition?.name) throw Object.assign(new Error("There is no specialist with that id"), { status: 404 });
    const active = this.deps.knowledge.activeSpecialist(this.owner, specialistId);
    const fields = TrunkSchema.parse({ name: state.definition.name.slice(0, 40), title: "Brought across from Specialists",
      instructions: active.instructions.slice(0, 8000), style: active.style ?? "default", permissions: active.permissions });
    return this.adopt(fields, { fromSpecialist: specialistId });
  }

  /** R17-003: retiring the permanent chat keeps it in history and starts a new one. */
  retireChat(id: string): Trunk {
    const trunk = this.records.get(id);
    const next = this.records.put({ ...trunk, chatSessionId: this.conversation(`Trunk: ${trunk.name}`),
      retiredChats: [trunk.chatSessionId, ...trunk.retiredChats].slice(0, 20), updatedAt: new Date().toISOString() });
    this.markSeen(id);
    this.refresh();
    this.pushAccounts(next);
    return next;
  }
  /** Talks to a Trunk in its own conversation; a busy one gets the message as soon as it is free. */
  async say(id: string, text: string): Promise<{ runId?: string; output?: string; status?: string; queued?: number }> {
    requireTrunkPart(this.store, this.owner, "trunks");
    const trunk = this.records.get(id);
    // Q44: the start path picks where the turn starts; another computer needs a way to start it there.
    const target = startTarget(trunk, this.computers());
    if (target.where === "computer") {
      if (!this.startElsewhere) throw cannotStartThere(target.name);
      return this.startElsewhere({ id: target.id, name: target.name }, trunk, text);
    }
    try {
      const run = await this.deps.runtime.run({ prompt: text, sessionId: trunk.chatSessionId, onTextDelta: () => undefined });
      return { runId: run.id, output: run.output, status: run.status };
    } catch (error) {
      if (!(error instanceof Error) || !/active run/.test(error.message)) throw error;
      return { queued: this.deps.runtime.followUp(trunk.chatSessionId, text).position };
    }
  }

  /** R17-006: a drawn face (lockable), an uploaded picture, or one the picture model makes. */
  async setAvatar(id: string, input: unknown): Promise<Trunk> {
    const trunk = this.records.get(id);
    const value = AvatarInput.parse(input);
    if (value.kind === "face") return this.edit(id, { avatar: { kind: "face", seed: trunk.name, locked: value.locked } });
    if (value.kind === "image") return this.edit(id, { avatar: { kind: "image", dataUrl: value.dataUrl } });
    if (!this.deps.picture) throw new Error("No picture model is connected. Connect one under Settings → Models → Pictures & sound.");
    const made = await this.deps.picture(`A friendly, simple avatar portrait for an assistant called ${trunk.name}. ${value.prompt}`);
    return this.edit(id, { avatar: { kind: "generated", dataUrl: pictureAddress(made.bytes, made.mediaType), prompt: value.prompt } });
  }

  /** R17-013: the one-file export, and bringing one in (reach off, the owner's keys). */
  // Integrator (R17-A): the owner's own words can hold a key; the file goes through the same scrubber as logs.
  exportFile(id: string) { return this.deps.runtime.hideSecrets(exportTrunk(this.records.get(id))); }
  importFile(input: unknown): Trunk {
    requireTrunkPart(this.store, this.owner, "trunks");
    // Integrator (R17-A): like a market import, it arrives switched off and is written down. Nothing runs
    // on the file's instructions until the owner talks to it.
    const trunk = this.adopt(importedFields(input, this.deps.registry.permissions()), {}, false);
    this.store.message(trunk.chatSessionId, { role: "assistant",
      content: `Hello, I am ${trunk.name}. I was brought in from a file, so I only look, use no tool servers and answer on no chat app until you change that in Edit Trunk.` });
    audit(this.store, this.owner, { action: "data.imported", actor: this.owner, subject: `Trunk "${trunk.name}" from a file`,
      reason: "A Trunk brought in from a file only looks, uses no tool server and reaches no chat app", outcome: "saved" });
    return trunk;
  }

  /** R17-005: what the Trunk's key settings come to, and the choices pushed to its conversation. */
  keys(id: string) {
    const trunk = this.records.get(id);
    const pools = this.accounts.pools();
    return { connected: this.accounts.connected, keys: trunk.keys, pools, plan: keyPlan(trunk.keys, pools),
      note: this.accounts.connected ? null : "Several accounts per connection are switched off, so this Trunk uses your own keys." };
  }
  private pushAccounts(trunk: Trunk): void {
    if (!this.accounts.connected) return;
    const plan = keyPlan(trunk.keys, this.accounts.pools());
    for (const [pool, account] of Object.entries(plan.choices)) this.accounts.choose(trunk.chatSessionId, pool, account);
  }

  async close(): Promise<void> {
    this.messages.close();
    this.routines.close();
    // A turn still being written gets a moment; the runtime stops whatever is left right after.
    await Promise.race([Promise.all([this.rooms.close(), this.introduced()]), new Promise((resolve) => setTimeout(resolve, 5000).unref())]);
  }
}
