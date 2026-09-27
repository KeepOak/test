import { randomUUID } from "node:crypto";

/** Authorization and network policy remain at the caller; this owns the shared page's single writer. */
export interface BrowserBinding { owner: string; conversation: string; profile: string | null }
export interface BrowserWriter { kind: "owner" | "agent"; id: string }
export type BrowserControlState = "owner" | "agent" | "transferring" | "stopped";
export interface BrowserControlView {
  id: string; binding: BrowserBinding; state: BrowserControlState; epoch: number;
  writer: BrowserWriter | null; tabs: string[]; runs: string[];
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

  constructor(binding: BrowserBinding, clientId: string) {
    this.binding = checkedBinding(binding);
    if (!clientId) throw new BrowserControlError("The owner window needs an identity.");
    this.writer = { kind: "owner", id: clientId };
  }
  view(): BrowserControlView {
    return { id: this.id, binding: { ...this.binding }, state: this.state, epoch: this.epoch,
      writer: this.writer ? { ...this.writer } : null, tabs: [...this.tabs], runs: [...this.runs] };
  }
  bindRun(runId: string): void {
    this.open();
    if (!runId) throw new BrowserControlError("The task needs an identity.");
    this.runs.add(runId);
  }
  unbindRun(runId: string): void {
    this.runs.delete(runId);
    if ((this.writer?.kind === "agent" && this.writer.id === runId)
      || (this.destination?.kind === "agent" && this.destination.id === runId)) this.revoke();
  }
  /** Blocks new writers immediately, waits for the current effect, then grants the owner. */
  takeOver(epoch: number, clientId: string): Promise<BrowserControlView> {
    if (!clientId) throw new BrowserControlError("The owner window needs an identity.");
    return this.transfer(epoch, { kind: "owner", id: clientId }, clientId);
  }
  handBack(epoch: number, clientId: string, runId: string): Promise<BrowserControlView> {
    this.current(epoch, { kind: "owner", id: clientId });
    if (!this.runs.has(runId)) throw new BrowserControlError("That task is not bound to this browser.");
    return this.transfer(epoch, { kind: "agent", id: runId }, clientId);
  }
  private async transfer(epoch: number, destination: BrowserWriter, clientId: string): Promise<BrowserControlView> {
    this.open();
    if (epoch !== this.epoch) throw new BrowserControlError("Browser control changed; refresh before continuing.");
    if (this.state === "transferring") throw new BrowserControlError("Browser control is still transferring.");
    this.state = "transferring";
    this.writer = null;
    this.destination = destination;
    this.transferOwner = clientId;
    const grantedEpoch = ++this.epoch;
    await this.tail;
    if (this.epoch !== grantedEpoch || this.state !== "transferring")
      throw new BrowserControlError("The browser transfer was revoked.");
    this.writer = destination;
    this.destination = null;
    this.transferOwner = null;
    this.state = destination.kind;
    this.sequence = 0;
    return this.view();
  }
  /** Losing the owner window keeps the agent blocked until an explicit new transfer. */
  disconnect(clientId: string): BrowserControlView {
    if ((this.writer?.kind === "owner" && this.writer.id === clientId)
      || (this.state === "transferring" && this.transferOwner === clientId)) this.revoke();
    return this.view();
  }
  stop(): BrowserControlView {
    if (this.state !== "stopped") { this.revoke(); this.state = "stopped"; this.runs.clear(); }
    return this.view();
  }
  private revoke(): void {
    this.epoch++;
    this.writer = this.destination = null;
    this.transferOwner = null;
    this.sequence = 0;
    if (this.state !== "stopped") this.state = "owner";
    this.active?.abort(new BrowserControlError("Browser control was revoked."));
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
  get(binding: BrowserBinding, id: string): BrowserControl {
    const found = this.sessions.get(bindingKey(binding));
    if (!found || found.id !== id) throw new BrowserControlError("Browser session not found.");
    return found;
  }
  bindRun(binding: BrowserBinding, id: string, runId: string): BrowserControl {
    const control = this.get(binding, id), key = JSON.stringify([binding.owner, runId]);
    const had = this.runs.get(key);
    if (had && had !== control && had.view().state !== "stopped")
      throw new BrowserControlError("That task already uses another browser session.");
    control.bindRun(runId);
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
}
