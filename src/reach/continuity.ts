import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Runtime } from "../runtime.js";
import type { Run } from "../contracts.js";
import { shortLivedKeyMark, underShortLivedKey } from "../key-context.js";
import { machineCall, type MachineDirectory, type MachineLink } from "./machines.js";
import { inboxKeys } from "./remote-trunks.js";
import { requireReach } from "./settings.js";
import { continuityRecords, continuityRunChain, saveContinuity, withContinuityExecution, type ContinuityRecord } from "./continuity-store.js";
import { continuityContext, continuityPrompt } from "./continuity-context.js";

const Token = z.object({ id: z.string().uuid(), generation: z.number().int().positive() }).strict();
const Transfer = Token.extend({ prompt: z.string().trim().min(1).max(33000) });
const Start = z.object({ machine: z.string().trim().min(1).max(40), sessionId: z.string().uuid(), prompt: z.string().trim().min(1).max(16000) }).strict();
const Prepare = Start.extend({ includeContext: z.boolean().default(false) });
const Dispatch = Token.extend({ contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const Receipt = Token.extend({ state: z.enum(["active", "interrupted", "stopping", "released"]), runId: z.string().uuid().nullable(), output: z.string().max(16000), error: z.string().max(300).nullable() });
export type ContinuityReceipt = z.infer<typeof Receipt>;
const conflict = (text: string) => Object.assign(new Error(text), { status: 409 });
const receipt = (row: ContinuityRecord): ContinuityReceipt => Receipt.parse({ id: row.id, generation: row.generation, state: row.state,
  runId: row.runId, output: row.output, error: row.error });

/** A durable ownership transfer, not a timer lease: expiry never authorizes a second engine. */
export class Continuity {
  constructor(private readonly runtime: Runtime, private readonly directory: MachineDirectory, private readonly link: MachineLink,
    private readonly assertQuiescent: (sessionId: string) => void) {
    for (const row of this.records()) if (row.direction === "incoming" && row.state === "active")
      this.save({ ...row, state: "interrupted", error: "The destination restarted. Review the task before starting further work; it was not replayed." });
  }
  private get store() { return this.runtime.store; }
  private get owner() { return this.runtime.owner; }
  private records() { return continuityRecords(this.store, this.owner); }
  private save(row: ContinuityRecord) { saveContinuity(this.store, this.owner, row); return row; }
  list() { return this.records().map((record) => {
    const { prompt: _prompt, keyId: _keyId, ...row } = this.latest(record);
    return row;
  }); }
  private latest(row: ContinuityRecord): ContinuityRecord {
    const run = row.direction === "incoming" && row.runId ? this.store.run(row.runId) : null;
    return run ? { ...row, output: run.output.slice(0, 16000) } : row;
  }
  private get(input: unknown, direction: ContinuityRecord["direction"]): ContinuityRecord {
    const token = Token.parse(input), row = this.records().find((entry) => entry.id === token.id && entry.direction === direction);
    if (!row || row.generation !== token.generation) throw conflict("This continuity receipt is missing or superseded.");
    return row;
  }
  private bound(input: unknown, keyId?: string): ContinuityRecord {
    if (shortLivedKeyMark().sessionId) throw Object.assign(new Error("A conversation-bound key cannot transfer execution ownership."), { status: 403 });
    const row = this.get(input, "incoming");
    const pairing = keyId && inboxKeys(this.store, this.owner).find((entry) => entry.keyId === keyId);
    if (!pairing || pairing.machine !== row.peer || !this.directory.list().some((entry) => entry.id === row.peer))
      throw Object.assign(new Error("Only the currently paired key for this transfer's source computer can control it."), { status: 403 });
    return row;
  }
  private active(sessionId: string): string[] {
    return this.runtime.workingRuns().filter((id) => continuityRunChain(this.store, id)
      .some((ancestor) => this.store.run(ancestor)?.sessionId === sessionId));
  }
  private async quiesce(sessionId: string): Promise<void> {
    for (const id of this.active(sessionId)) this.runtime.cancel(id);
    const until = Date.now() + 30000;
    while (this.active(sessionId).length && Date.now() < until) await new Promise((done) => setTimeout(done, 25));
    if (this.active(sessionId).length) throw conflict("A task is still stopping. Ownership remains held; try again after it stops.");
    this.assertQuiescent(sessionId);
  }
  private async call(row: ContinuityRecord, action: "receive" | "status" | "release"): Promise<ContinuityReceipt> {
    const entry = this.directory.list().find((machine) => machine.id === row.peer);
    if (!entry) throw conflict("The paired destination is unavailable. Ownership remains held.");
    const payload = { id: row.id, generation: row.generation, ...(action === "receive" ? { prompt: continuityPrompt(row.prompt, row.contextText) } : {}) };
    const response = await machineCall(this.link, entry, `/api/reach/continuity/${action}`, { method: "POST", body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw conflict(`The destination could not confirm ${action} (${response.status}). Ownership remains held.`);
    const answer = Receipt.parse(response.data);
    if (answer.id !== row.id || answer.generation !== row.generation) throw conflict("The destination returned a different ownership receipt.");
    return answer;
  }
  async start(input: unknown) {
    const prepared = await this.prepare({ ...Start.parse(input), includeContext: false });
    return this.dispatch({ id: prepared.id, generation: prepared.generation });
  }
  async prepare(input: unknown) {
    requireReach(this.store, this.owner, "machines");
    const data = Prepare.parse(input);
    if (!this.store.ownsSession(this.owner, data.sessionId) || this.store.sessionTemporary(data.sessionId)) throw conflict("Choose one of your saved conversations.");
    if (!this.directory.list().some((entry) => entry.id === data.machine)) throw conflict("Pair this destination first.");
    const earlier = this.records().filter((row) => row.sessionId === data.sessionId);
    if (earlier.some((row) => row.direction === "incoming" || row.state !== "released")) throw conflict("This conversation already has an ownership transfer.");
    const row = this.save({ id: randomUUID(), sessionId: data.sessionId, generation: Math.max(0, ...earlier.map((entry) => entry.generation)) + 1,
      peer: data.machine, keyId: "", direction: "outgoing", state: "held", prompt: data.prompt, runId: null, output: "", error: null,
      dispatched: false, contextRequested: data.includeContext, prepared: false });
    return this.preview({ id: row.id, generation: row.generation });
  }
  async preview(input: unknown) {
    let row = this.get(input, "outgoing");
    if (!row.prepared) {
      await this.quiesce(row.sessionId);
      row = this.get(input, "outgoing");
      if (row.state !== "held" || row.dispatched) throw conflict("This transfer changed while its preview was being prepared.");
      const context = row.contextRequested ? continuityContext(this.runtime, row.sessionId) : null;
      row = this.save({ ...row, prepared: true, ...(context ? { contextText: context.text, contextFingerprint: context.fingerprint, contextApproved: false } : {}) });
    }
    return { id: row.id, generation: row.generation, prompt: row.prompt, contextText: row.contextText ?? "", contextFingerprint: row.contextFingerprint ?? null, dispatched: row.dispatched ?? true };
  }
  /** Retry uses the same receipt; even a lost successful response cannot start a duplicate. */
  async dispatch(input: unknown) {
    requireReach(this.store, this.owner, "machines");
    const approved = Dispatch.parse(input), token = { id: approved.id, generation: approved.generation };
    let row = this.get(token, "outgoing");
    if (row.state === "released") throw conflict("This transfer was already returned.");
    if (!row.prepared) throw conflict("Finish preparing and reviewing this transfer before sending it.");
    if (row.contextFingerprint && !row.contextApproved && approved.contextFingerprint !== row.contextFingerprint)
      throw conflict("Preview and approve the exact conversation context before sending it.");
    await this.quiesce(row.sessionId);
    row = this.get(token, "outgoing");
    if (row.state === "released") throw conflict("This transfer was already returned.");
    row = this.save({ ...row, dispatched: true, contextApproved: true });
    const answer = await this.call(row, "receive");
    this.save({ ...this.get(token, "outgoing"), runId: answer.runId, output: answer.output, error: answer.error });
    return answer;
  }
  async status(input: unknown) {
    const row = this.get(input, "outgoing");
    if (row.state === "released") return { ...receipt(row), state: "released" as const };
    const answer = await this.call(row, "status");
    this.save({ ...this.get(input, "outgoing"), runId: answer.runId, output: answer.output, error: answer.error });
    return answer;
  }
  /** Return only after the destination durably fences and acknowledges quiescence. */
  async reclaim(input: unknown) {
    let row = this.get(input, "outgoing");
    if (row.state === "released") return receipt(row);
    if (row.dispatched === false) {
      await this.quiesce(row.sessionId);
      row = this.get(input, "outgoing");
      if (row.dispatched === false) return receipt(this.save({ ...row, state: "released" }));
    }
    const answer = await this.call(row, "release");
    if (answer.state !== "released") throw conflict("The destination still owns this conversation.");
    const current = this.get(input, "outgoing");
    return receipt(this.save({ ...current, state: "released", runId: answer.runId, output: answer.output, error: answer.error }));
  }
  receive(input: unknown, keyId?: string): ContinuityReceipt {
    if (shortLivedKeyMark().sessionId) throw Object.assign(new Error("A conversation-bound key cannot transfer execution ownership."), { status: 403 });
    requireReach(this.store, this.owner, "machines");
    const data = Transfer.parse(input);
    const pairing = keyId && inboxKeys(this.store, this.owner).find((entry) => entry.keyId === keyId);
    if (!pairing || !this.directory.list().some((entry) => entry.id === pairing.machine)) throw Object.assign(new Error("Pair this incoming run key with its computer first."), { status: 403 });
    const existing = this.records().find((row) => row.id === data.id);
    if (existing) {
      const row = this.bound({ id: data.id, generation: data.generation }, keyId);
      if (row.prompt !== data.prompt) throw conflict("A continuity receipt cannot be reused for different work.");
      return receipt(row);
    }
    if (this.records().filter((row) => row.direction === "incoming" && row.state !== "released").length >= 10) throw conflict("Release an existing transfer before receiving another.");
    const row = this.save({ ...data, sessionId: this.store.createSession(this.owner), peer: pairing.machine, keyId: keyId!,
      direction: "incoming", state: "active", runId: null, output: "", error: null });
    this.launch(row);
    return receipt(this.get({ id: row.id, generation: row.generation }, "incoming"));
  }
  private launch(row: ContinuityRecord): void {
    const work = withContinuityExecution(row, () => underShortLivedKey(() => this.runtime.run({ sessionId: row.sessionId, prompt: row.prompt,
      source: "mcp", onTextDelta: () => undefined, timeoutMs: 24 * 60 * 60 * 1000,
      onStarted: (run) => this.save({ ...this.get({ id: row.id, generation: row.generation }, "incoming"), runId: run.id }),
    }), { keyId: row.keyId }));
    void work.then((run) => this.finish(row, run.output, null), (error: unknown) => this.finish(row, "", error instanceof Error ? error.message.slice(0, 300) : "Task failed."));
  }
  private finish(row: ContinuityRecord, output: string, error: string | null): void {
    if (!this.store.isOpen) return;
    const current = this.get({ id: row.id, generation: row.generation }, "incoming");
    this.save({ ...current, output: output.slice(0, 16000), error });
  }
  canContinueAfterApproval(runId: string): boolean {
    return this.records().some((row) => row.direction === "incoming" && row.state === "active" && row.runId === runId);
  }
  /** Called only after the owner's normal approval route validates the exact question and answers it. */
  async continueAfterApproval(runId: string, decision: "allow" | "deny", fingerprint: string): Promise<Run> {
    const row = this.records().find((entry) => entry.direction === "incoming" && entry.state === "active" && entry.runId === runId);
    if (!row) throw conflict("This transfer no longer owns execution.");
    requireReach(this.store, this.owner, "machines");
    const work = withContinuityExecution(row, () => underShortLivedKey(() => decision === "allow"
      ? this.runtime.continueAsked(runId) : this.runtime.continueRefused(runId, fingerprint), { keyId: row.keyId }));
    return work.then((run) => { this.finish(row, run.output, null); return run; });
  }
  remoteStatus(input: unknown, keyId?: string) { return receipt(this.latest(this.bound(input, keyId))); }
  async release(input: unknown, keyId?: string): Promise<ContinuityReceipt> {
    const row = this.bound(input, keyId);
    if (row.state === "released") return receipt(row);
    this.save({ ...row, state: "stopping" });
    await this.quiesce(row.sessionId);
    return receipt(this.save({ ...this.latest(this.bound(input, keyId)), state: "released" }));
  }
}
