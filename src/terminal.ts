import type { ReasoningEffort } from "./models.js";
import { createInterface, type Interface } from "node:readline";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { Event, Run } from "./contracts.js";
import type { Runtime } from "./runtime.js";
import { executeCommand } from "./commands/execute.js";
import { savedLine } from "./commands/saved.js";
import { commandHost } from "./commands/host.js";
import { commandMode } from "./commands/settings.js";

export interface TerminalOptions {
  input?: Readable;
  output?: Writable;
  signals?: EventEmitter;
  terminal?: boolean;
  pollIntervalMs?: number;
}
type ActiveRun = { controller: AbortController; run?: Run; eventId: number };
const visibleText = (text: string): string =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** Interactive conversation; input during work cancels and redirects that session. */
export function startTerminal(runtime: Runtime, options: TerminalOptions = {}): Promise<void> {
  return new TerminalConversation(runtime, options).start();
}

class TerminalConversation {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly signals: EventEmitter;
  private readonly lines: Interface;
  private readonly terminal: boolean;
  private readonly pollIntervalMs: number;
  private queue: string[] = [];
  private sessionId: string | undefined;
  private model: string | undefined;
  private reasoning: ReasoningEffort | null | undefined;
  private active: ActiveRun | undefined;
  private draining = false;
  private closing = false;
  private partial = false;
  private resolveDone: (() => void) | undefined;
  constructor(private readonly runtime: Runtime, options: TerminalOptions) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.signals = options.signals ?? process;
    this.terminal = options.terminal ?? (this.input === process.stdin && !!process.stdin.isTTY && !!process.stdout.isTTY);
    this.pollIntervalMs = options.pollIntervalMs ?? 75;
    this.lines = createInterface({ input: this.input, output: this.output, terminal: this.terminal });
    this.lines.setPrompt("You> ");
  }
  start(): Promise<void> {
    const done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
    this.write("Branch Agent terminal conversation\nLive model text when supported; tool/model/run progress for all providers. Partial text is uncommitted.\nCtrl+C or /cancel interrupts. Type a revision to redirect; /new starts a session; /exit quits.\n/models, /model <id>, /think <level>, /skills and /memory [search] are available; /help repeats this.\n");
    this.lines.on("line", this.receive);
    this.lines.on("SIGINT", this.interrupt);
    this.signals.on("SIGINT", this.interrupt);
    this.lines.once("close", this.endInput);
    this.prompt();
    return done;
  }
  private receive = (input: string): void => {
    if (this.closing) return;
    const text = input.trim();
    if (!text) { this.prompt(); return; }
    if (text === "/exit") {
      this.queue = [];
      this.cancel();
      this.lines.close();
      return;
    }
    if (text === "/cancel") { this.interrupt(); return; }
    // ---- bucket 12: one of the owner's saved commands becomes the message it stands for ----
    const saved = text.startsWith("/") ? savedLine(this.runtime.store, this.runtime.owner, text) : null;
    if (saved && !("text" in saved)) { this.write(`${"problem" in saved ? saved.problem : saved.reply}\n`); this.prompt(); return; }
    if (saved) { this.receive(saved.text); return; }
    // ---- end of the bucket 12 hook ----
    if (text.startsWith("/") && text !== "/new") {
      this.command(text);
      this.prompt();
      return;
    }
    if (this.active) this.cancel();
    this.queue = text === "/new" ? [text] : [...this.queue.filter((item) => item === "/new"), text];
    void this.drain();
  };
  /** Slash commands that never start a task. */
  private command(text: string): void {
    const [name, ...rest] = text.split(/\s+/), argument = rest.join(" ");
    const owner = this.runtime.owner, models = this.runtime.models;
    if (name === "/help") { this.write("Commands: /models, /model <id>, /think <low|medium|high|default>, /skills, /memory [search], /cancel, /new, /exit.\n"); return; }
    if (name === "/skills") {
      const skills = this.runtime.store.skills.list(owner);
      if (!skills.length) { this.write("No skills installed. Add SKILL.md documents in the app's Skills view.\n"); return; }
      for (const skill of skills) this.write(`${skill.activeVersion ? "*" : " "} ${skill.name} — ${skill.description}${skill.activeVersion ? ` (v${skill.activeVersion})` : " (disabled)"}\n`);
      return;
    }
    if (name === "/memory") {
      const facts = argument ? this.runtime.store.searchMemory(owner, argument) : this.runtime.store.list("memory", owner).slice(0, 20);
      if (!facts.length) { this.write(argument ? "No saved facts match that.\n" : "Nothing saved to memory yet.\n"); return; }
      for (const fact of facts) this.write(`- ${String(fact.data.text)} (${String(fact.data.source)})\n`);
      return;
    }
    if (name === "/models") {
      const summary = models.summary(owner), active = this.model ?? summary.activePreset ?? summary.defaultPreset;
      for (const preset of summary.presets)
        this.write(`${preset.id === active ? "*" : " "} ${preset.id} — ${preset.name} · ${preset.model}${preset.coolingDownUntil ? " (resting)" : ""}\n`);
      return;
    }
    if (name === "/model") {
      if (!argument) { this.write(`Model for this conversation: ${this.model ?? "workspace default"}. Use /models to list ids.\n`); return; }
      if (!models.presets.has(argument)) { this.write(`No model called ${argument}. Use /models to list ids.\n`); return; }
      this.model = argument;
      if (this.sessionId) models.configureSession(owner, this.sessionId, { preset: argument });
      this.write(`[model set to ${models.presets.get(argument)!.name} for this conversation]\n`);
      return;
    }
    if (name === "/think") {
      const choice = argument === "default" ? null : argument;
      if (choice !== null && !["low", "medium", "high"].includes(choice)) { this.write("Use /think low, medium, high or default.\n"); return; }
      this.reasoning = choice as ReasoningEffort | null;
      if (this.sessionId) models.configureSession(owner, this.sessionId, { reasoning: this.reasoning });
      this.write(`[thinking set to ${choice ?? "the model's default"} for this conversation]\n`);
      return;
    }
    void this.shared(text);
  }
  /**
   * Wave mac3 (commands): anything else the shared table offers the terminal, once the owner has
   * switched those on; with the switch off this answers exactly as it always did.
   */
  private async shared(text: string): Promise<void> {
    const list = "Commands: /models, /model <id>, /think <level>, /skills, /memory [search], /cancel, /new, /exit.\n";
    if (commandMode(this.runtime.store, this.runtime.owner, "terminal") === "off") { this.write(list); return; }
    const outcome = await executeCommand(commandHost(this.runtime), {
      surface: "terminal", line: text, sessionId: this.sessionId, access: "full",
    }).catch((error: unknown) => ({ text: error instanceof Error ? error.message : String(error), client: undefined }));
    if (!outcome) this.write(list);
    else if (outcome.client) this.write("That one works in the full terminal view (branch) or the app window.\n");
    else this.write(`${outcome.text}\n`);
    this.prompt();
  }
  private interrupt = (): void => {
    this.queue = [];
    if (!this.cancel()) this.write("No active task. Use /exit to quit.\n");
    this.prompt();
  };
  private cancel(): boolean {
    if (!this.active) return false;
    if (!this.active.controller.signal.aborted) {
      this.active.controller.abort(new Error("Cancelled by user"));
      this.write("[cancellation requested; waiting for task cleanup]\n");
    }
    return true;
  }
  private endInput = (): void => {
    this.closing = true;
    if (!this.draining) this.finish();
  };
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const prompt = this.queue.shift()!;
        if (prompt === "/new") {
          if (this.sessionId) this.runtime.stopHelpers(this.sessionId); // helper-lifecycle
          this.sessionId = undefined;
          this.write("[new conversation; a session will be created on your next task]\n");
        } else await this.execute(prompt);
      }
    } finally {
      this.draining = false;
      if (this.closing) this.finish();
      else this.prompt();
    }
  }
  private async execute(prompt: string): Promise<void> {
    const active: ActiveRun = { controller: new AbortController(), eventId: 0 };
    this.active = active;
    const poll = setInterval(() => this.progress(active), this.pollIntervalMs);
    try {
      const run = await this.runtime.run({
        prompt, signal: active.controller.signal,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        ...(this.model ? { model: this.model } : {}),
        ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
        onStarted: (run) => {
          active.run = run;
          this.write(`[session ${run.sessionId}]\n`);
          this.progress(active);
        },
        onTextDelta: (text) => this.textDelta(active, text),
      });
      const firstRun = this.sessionId !== run.sessionId;
      this.sessionId = run.sessionId;
      if (firstRun && (this.model || this.reasoning !== undefined))
        this.runtime.models.configureSession(this.runtime.owner, run.sessionId, {
          ...(this.model ? { preset: this.model } : {}), ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
        });
      this.progress(active);
      if (run.status === "completed") this.write(`[final assistant response]\n${visibleText(run.output)}\n`);
      else this.write(`[task ${run.status}; partial text is not a final answer]\n`);
    } catch {
      this.write("[task could not start or finish; inspect local run history for details]\n");
    } finally {
      clearInterval(poll);
      this.active = undefined;
    }
  }
  private textDelta(active: ActiveRun, text: string): void {
    this.progress(active);
    if (!this.partial) { this.write("[partial assistant text]\n"); this.partial = true; }
    this.output.write(visibleText(text));
  }
  private progress(active: ActiveRun): void {
    if (!active.run) return;
    for (const event of this.runtime.store.events(active.run.id)) {
      if (event.id <= active.eventId) continue;
      active.eventId = event.id;
      const line = progressLine(event);
      if (line) this.write(line + "\n");
    }
  }
  private write(text: string): void {
    if (this.partial) { this.output.write("\n"); this.partial = false; }
    if (this.terminal) {
      this.output.write("\r\x1b[2K");
      this.output.write(text);
    } else this.output.write(text);
  }
  private prompt(): void {
    if (this.terminal && !this.closing) this.lines.prompt(true);
  }
  private finish(): void {
    this.signals.removeListener("SIGINT", this.interrupt);
    this.lines.removeListener("SIGINT", this.interrupt);
    this.lines.removeListener("line", this.receive);
    this.resolveDone?.();
    this.resolveDone = undefined;
  }
}

/** One plain line describing a stored event, or nothing for events not worth showing a person. */
export function progressLine(event: Event): string | undefined {
  if (event.kind === "model.retry_scheduled") {
    const { attempt, maxRetries, delayMs } = event.data;
    if ([attempt, maxRetries, delayMs].every((value) => Number.isSafeInteger(value) && Number(value) >= 0))
      return `[provider temporarily unavailable; retry ${attempt}/${maxRetries} in ${delayMs} ms]`;
    return "[provider retry scheduled]";
  }
  const supported = /^(run\.(started|finished|cleanup_failed)|model\.(started|completed|cancelled|failed)|tool\.(started|completed|failed))$/;
  if (event.kind === "session.reconciled")
    return "[interrupted tool outcome unknown; check actual state before retrying]";
  if (!supported.test(event.kind)) return undefined;
  const name = event.kind.startsWith("tool.") && typeof event.data.name === "string"
    ? " " + event.data.name.replace(/[^a-zA-Z0-9_.:-]/g, "?").slice(0, 100) : "";
  const status = event.kind === "run.finished" && typeof event.data.status === "string"
    ? " " + event.data.status.replace(/[^a-z_]/g, "").slice(0, 30) : "";
  return `[${event.kind}${name}${status}]`;
}
