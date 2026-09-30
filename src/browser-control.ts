import { randomUUID } from "node:crypto";

/** Authorization and network policy remain at the caller; this owns the shared page's single writer. */
export interface BrowserBinding { owner: string; conversation: string; profile: string | null }
export interface BrowserWriter { kind: "owner" | "agent"; id: string }
export type BrowserControlState = "owner" | "agent" | "transferring" | "stopped";
export interface BrowserControlView {
  id: string; binding: BrowserBinding; state: BrowserControlState; epoch: number; sequence: number;
  writer: BrowserWriter | null; tabs: string[]; runs: string[];
  /** The task the owner took the browser over from; it waits for Hand back rather than failing. */
  paused: string | null;
  /** A task whose next step is waiting for the owner to hand the browser back (or to stop driving it). */
  waiting: string | null;
}
export interface BrowserCommand { epoch: number; sequence: number; writer: BrowserWriter; tabId: string }
export interface BrowserWrite {
  signal: AbortSignal;
  /** Recheck after awaits, immediately before page effects. Never replay an interrupted effect. */
  check(): void;
  /** Bookkeeping for a page effect already dispatched; limited to this draining operation. */
  addTab(): string;
  closeTab(id: string): void;
}
export class BrowserControlError extends Error {}
const sameWriter = (a: BrowserWriter | null, b: BrowserWriter): boolean => a?.kind === b.kind && a.id === b.id;
const bindingKey = (binding: BrowserBinding): string => JSON.stringify([binding.owner, binding.conversation, binding.profile]);
function checkedBinding(binding: BrowserBinding): BrowserBinding {
  if (!binding.owner || !binding.conversation || (binding.profile !== null && !binding.profile))
    throw new BrowserControlError("The browser needs an owner, conversation and explicit profile.");
  return Object.freeze({ ...binding });
}

export class BrowserControl {
  readonly id = randomUUID();
  readonly binding: BrowserBinding;
  private state: BrowserControlState = "owner";
  private epoch = 1;
  private writer: BrowserWriter | null;
  private destination: BrowserWriter | null = null;
  private transferOwner: string | null = null;
  private sequence = 0;
  private tabs = new Set<string>([randomUUID()]);
  private runs = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private active: AbortController | null = null;
  private paused: string | null = null;
  private offered = false;
  /** Tasks that work in this browser on their own (a Trunk's task in this conversation), not only when handed it. */
  private readonly tasks = new Set<string>();
  private waiters = new Set<() => void>();
  private readonly waitingRuns = new Set<string>();

  constructor(binding: BrowserBinding, clientId: string, agent?: { runId: string; tabs: number }) {
    this.binding = checkedBinding(binding);
    if (!clientId && !agent) throw new BrowserControlError("The owner window needs an identity.");
    this.writer = agent ? { kind: 'agent', id: agent.runId } : { kind: 'owner', id: clientId };
    if (agent) {
      // A task's own window, taken over by the owner: the task holds it until the takeover drains its current step.
      this.state = "agent";
      this.runs.add(agent.runId);
      this.tasks.add(agent.runId);
      this.tabs = new Set(Array.from({ length: Math.max(1, agent.tabs) }, () => randomUUID()));
    }
  }
  view(): BrowserControlView {
    return { id: this.id, binding: { ...this.binding }, state: this.state, epoch: this.epoch, sequence: this.sequence,
      writer: this.writer ? { ...this.writer } : null, tabs: [...this.tabs], runs: [...this.runs], paused: this.paused,
      waiting: [...this.waitingRuns][0] ?? null };
  }
  bindRun(runId: string, task = false): void {
    this.open();
    if (!runId) throw new BrowserControlError("The task needs an identity.");
    this.runs.add(runId);
    if (task) this.tasks.add(runId);
  }
  unbindRun(runId: string): void {
    this.runs.delete(runId);
    this.tasks.delete(runId);
    this.waitingRuns.delete(runId);
    if (this.paused === runId) this.paused = null;
    if ((this.writer?.kind === "agent" && this.writer.id === runId)
      || (this.destination?.kind === "agent" && this.destination.id === runId)) this.revoke();
    this.notify();
  }
  private notify(): void { const waiting = this.waiters; this.waiters = new Set(); for (const wake of waiting) wake(); }
  /** Resolves on the next change of control, or rejects when the task is cancelled or has waited long enough. */
  private changed(signal: AbortSignal, until: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", aborted); this.waiters.delete(done); resolve(); };
      const aborted = (): void => { clearTimeout(timer); this.waiters.delete(done); reject(signal.reason); };
      const timer = setTimeout(() => {
        this.waiters.delete(done); signal.removeEventListener("abort", aborted);
        reject(new BrowserControlError("You have Branch's browser and haven't handed it back, so this step stopped waiting."));
      }, Math.max(0, until - Date.now()));
      timer.unref?.();
      if (signal.aborted) { aborted(); return; }
      signal.addEventListener("abort", aborted, { once: true });
      this.waiters.add(done);
    });
  }
  /**
   * Before a task's step: a task that works here takes the browser only when nobody is driving it. While the owner's
   * window holds it, or the owner took it over from a task, the step waits (it never fails and is never replayed)
   * until Hand back, or until the owner's window lets go. A run bound only to carry one owner command never gets a
   * turn of its own.
   */
  async agentTurn(runId: string, signal: AbortSignal, waitMs = 10 * 60_000): Promise<void> {
    const until = Date.now() + waitMs;
    try {
      for (;;) {
        this.open();
        signal.throwIfAborted();
        if (this.state === "agent" && this.writer?.kind === "agent" && this.writer.id === runId) return;
        if (!this.runs.has(runId) || (!this.tasks.has(runId) && this.paused !== runId)) return; // write() refuses it
        if (this.state === "agent") throw new BrowserControlError("Another task is using this browser.");
        if (this.state === "transferring" || this.paused || this.writer || this.offered) {
          this.waitingRuns.add(runId);
          await this.changed(signal, until);
          continue;
        }
        this.waitingRuns.delete(runId);
        await this.transfer(this.epoch, { kind: "agent", id: runId }, `task:${runId}`);
      }
    } finally { this.waitingRuns.delete(runId); }
  }
  /** Blocks new writers immediately, waits for the current effect, then grants the owner. */
  takeOver(epoch: number, clientId: string): Promise<BrowserControlView> {
    if (!clientId) throw new BrowserControlError("The owner window needs an identity.");
    return this.transfer(epoch, { kind: "owner", id: clientId }, clientId);
  }
  handBack(epoch: number, clientId: string, runId: string): Promise<BrowserControlView> {
    // The owner's window hands back while it holds the browser, or after its hold lapsed with nobody else driving.
    if (!(this.state === "owner" && this.writer === null && this.epoch === epoch)) this.current(epoch, { kind: "owner", id: clientId });
    if (!this.runs.has(runId)) throw new BrowserControlError("That task is not bound to this browser.");
    this.tasks.add(runId);
    return this.transfer(epoch, { kind: "agent", id: runId }, clientId);
  }
  /** An agent offers its page; only a real owner takeover may subsequently issue an owner capability. */
  async offerToOwner(epoch: number, runId: string, authorize: () => void): Promise<BrowserControlView> {
    this.current(epoch, { kind: 'agent', id: runId }); authorize();
    this.offered = true; this.paused = runId; this.state = 'transferring'; this.writer = null;
    const granted = ++this.epoch; this.notify();
    try {
      await this.tail;
      if (this.epoch !== granted || this.state !== 'transferring') throw new BrowserControlError('Browser control changed.');
      authorize();
      this.state = 'owner'; this.sequence = 0; this.notify();
      return this.view();
    } catch (error) { if (this.epoch === granted && this.state === 'transferring') this.revoke(); throw error; }
  }
  private async transfer(epoch: number, destination: BrowserWriter, clientId: string): Promise<BrowserControlView> {
    this.open();
    if (epoch !== this.epoch) throw new BrowserControlError("Browser control changed; refresh before continuing.");
    if (this.state === "transferring") throw new BrowserControlError("Browser control is still transferring.");
    const from = this.writer;
    this.state = "transferring";
    this.writer = null;
    this.destination = destination;
    this.transferOwner = clientId;
    const grantedEpoch = ++this.epoch;
    this.notify();
    await this.tail;
    if (this.epoch !== grantedEpoch || this.state !== "transferring")
      throw new BrowserControlError("The browser transfer was revoked.");
    this.writer = destination;
    this.destination = null;
    this.transferOwner = null;
    this.state = destination.kind;
    this.sequence = 0;
    // Taking over from a task pauses that task until Hand back; handing to a task ends any pause.
    if (destination.kind === "agent") { this.paused = null; this.offered = false; }
    else if (from?.kind === "agent" && this.runs.has(from.id)) this.paused = from.id;
    this.notify();
    return this.view();
  }
  /** Losing the owner window keeps the agent blocked until an explicit new transfer. */
  disconnect(clientId: string): BrowserControlView {
    if ((this.writer?.kind === "owner" && this.writer.id === clientId)
      || (this.state === "transferring" && this.transferOwner === clientId)) this.revoke();
    return this.view();
  }
  stop(): BrowserControlView {
    if (this.state !== "stopped") { this.revoke(); this.state = "stopped"; this.runs.clear(); this.tasks.clear(); this.paused = null; this.offered = false; }
    this.notify();
    return this.view();
  }
  /** A lock or key rotation revokes grants while keeping the owned page for explicit later takeover. */
  revokeAccess(): BrowserControlView { if (this.state !== 'stopped') this.revoke(); return this.view(); }
  private revoke(): void {
    this.epoch++;
    this.writer = this.destination = null;
    this.transferOwner = null;
    this.sequence = 0;
    if (this.state !== "stopped") this.state = "owner";
    this.active?.abort(new BrowserControlError("Browser control was revoked."));
    this.notify();
  }
  private open(): void {
    if (this.state === "stopped") throw new BrowserControlError("This browser was stopped.");
  }
  private current(epoch: number, writer: BrowserWriter): void {
    this.open();
    if (this.epoch !== epoch || !sameWriter(this.writer, writer) || this.state !== writer.kind)
      throw new BrowserControlError("This writer no longer controls the browser.");
    if (writer.kind === "agent" && !this.runs.has(writer.id))
      throw new BrowserControlError("That task is not bound to this browser.");
  }
  write<T>(command: BrowserCommand, operation: (write: BrowserWrite) => Promise<T>): Promise<T> {
    const picked = { ...command, writer: { ...command.writer } };
    this.current(picked.epoch, picked.writer);
    if (!Number.isSafeInteger(picked.sequence) || picked.sequence !== this.sequence + 1)
      throw new BrowserControlError("Browser input was duplicated or arrived out of order.");
    if (!this.tabs.has(picked.tabId)) throw new BrowserControlError("That browser tab is no longer open.");
    if (this.queued >= 32) throw new BrowserControlError("Too much browser input is waiting.");
    this.sequence = picked.sequence;
    this.queued++;
    const result = this.tail.then(() => this.perform(picked, operation));
    this.tail = result.then(() => undefined, () => undefined);
    return result.finally(() => { this.queued--; });
  }
  private async perform<T>(command: BrowserCommand, operation: (write: BrowserWrite) => Promise<T>): Promise<T> {
    const stop = new AbortController();
    const check = (): void => {
      stop.signal.throwIfAborted();
      this.current(command.epoch, command.writer);
      if (!this.tabs.has(command.tabId)) throw new BrowserControlError("That browser tab is no longer open.");
    };
    check();
    this.active = stop;
    const bookkeeping = (): void => {
      this.open();
      if (this.active !== stop) throw new BrowserControlError("This browser operation already finished.");
    };
    try {
      const result = await operation({ signal: stop.signal, check,
        addTab: () => { bookkeeping(); const id = randomUUID(); this.tabs.add(id); return id; },
        closeTab: (id) => {
          bookkeeping();
          if (!this.tabs.has(id)) throw new BrowserControlError("That browser tab is no longer open.");
          if (this.tabs.size === 1) throw new BrowserControlError("Stop the browser to close its last tab.");
          this.tabs.delete(id);
        } });
      stop.signal.throwIfAborted();
      this.current(command.epoch, command.writer);
      return result;
    } catch (error) {
      stop.signal.throwIfAborted();
      this.current(command.epoch, command.writer);
      throw error;
    } finally { if (this.active === stop) this.active = null; }
  }
  async idle(): Promise<void> { await this.tail; }
}

/** Stable browser identity survives task completion; a stopped session starts again with a new identity. */
export class BrowserControls {
  private sessions = new Map<string, BrowserControl>();
  private runs = new Map<string, BrowserControl>();
  ensure(binding: BrowserBinding, clientId: string): BrowserControl {
    const key = bindingKey(checkedBinding(binding)), had = this.sessions.get(key);
    if (had && had.view().state !== "stopped") return had;
    for (const [oldKey, control] of this.sessions) if (control.view().state === "stopped") this.sessions.delete(oldKey);
    if (!had && this.sessions.size >= 8) throw new BrowserControlError("Too many browser sessions are open.");
    const made = new BrowserControl(binding, clientId);
    this.sessions.set(key, made);
    return made;
  }
  /** A task's own window, taken over by the owner, becomes this conversation's kept browser. */
  adopt(binding: BrowserBinding, clientId: string, runId: string, tabs: number): BrowserControl {
    const key = bindingKey(checkedBinding(binding)), had = this.sessions.get(key);
    if (had && had.view().state !== "stopped") throw new BrowserControlError("This conversation already has a Branch browser open.");
    this.dropStopped();
    if (this.sessions.size >= 8) throw new BrowserControlError("Too many browser sessions are open.");
    const made = new BrowserControl(binding, clientId, { runId, tabs });
    this.sessions.set(key, made);
    this.runs.set(JSON.stringify([binding.owner, runId]), made);
    return made;
  }
  private dropStopped(): void { for (const [key, control] of this.sessions) if (control.view().state === "stopped") this.sessions.delete(key); }
  /** The open browser of one conversation, whichever profile it was opened with. */
  forConversation(owner: string, conversation: string): BrowserControl | null {
    for (const control of this.sessions.values())
      if (control.binding.owner === owner && control.binding.conversation === conversation && control.view().state !== "stopped") return control;
    return null;
  }
  get(binding: BrowserBinding, id: string): BrowserControl {
    const found = this.sessions.get(bindingKey(binding));
    if (!found || found.id !== id) throw new BrowserControlError("Browser session not found.");
    return found;
  }
  bindRun(binding: BrowserBinding, id: string, runId: string, task = false): BrowserControl {
    const control = this.get(binding, id), key = JSON.stringify([binding.owner, runId]);
    const had = this.runs.get(key);
    if (had && had !== control && had.view().state !== "stopped")
      throw new BrowserControlError("That task already uses another browser session.");
    control.bindRun(runId, task);
    this.runs.set(key, control);
    return control;
  }
  forRun(owner: string, runId: string): BrowserControl | null {
    const found = this.runs.get(JSON.stringify([owner, runId]));
    return found?.view().runs.includes(runId) ? found : null;
  }
  finishRun(owner: string, runId: string): void {
    const key = JSON.stringify([owner, runId]), found = this.runs.get(key);
    found?.unbindRun(runId);
    this.runs.delete(key);
  }
  stop(binding: BrowserBinding, id: string): BrowserControlView {
    const control = this.get(binding, id), view = control.stop();
    for (const [key, found] of this.runs) if (found === control) this.runs.delete(key);
    return view;
  }
  stopAll(): void { for (const control of this.sessions.values()) control.stop(); this.runs.clear(); }
  revokeAll(): void { for (const control of this.sessions.values()) control.revokeAccess(); }
}
