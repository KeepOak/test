import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import type { Completion, CompletionRequest, Provider } from "../contracts.js";
import { codexTransportEnvironment } from "../providers/codex-environment.js";
import { cleanChildEnvironment } from "../child-env.js";
import { agentPromptFrom } from "../providers/cli-agent.js";
import { startCall } from "../windows-command.js";
import { assertRealAgentAllowed } from "../providers/real-agent-guard.js"; // owner-dm-signin: never the real program from a test
import { CodexConversations, codexNotificationMatches, codexNotificationScope } from "./codex-conversation.js";

/**
 * A0601: Codex's app-server as a backend. Where the owner has OpenAI's `codex` program installed and
 * signed in, Branch starts `codex app-server` and holds one turn with it over the app-server protocol
 * (the same protocol src/asks/app-server.ts speaks the other way round): initialize, a new thread
 * that may only read (`sandbox: read-only`, `approvalPolicy: never`), one turn with Branch's
 * transcript as the request, and the answer streamed back word by word.
 *
 * Codex is never allowed to change anything this way: its sandbox is read-only, and any approval it
 * asks for anyway is declined. Codex's own sign-in stays Codex's; Branch never sees it. The program
 * is started from its name with fixed arguments and no shell, with only what it needs to find itself
 * and its sign-in in its environment.
 */
export interface AppServerChild {
  send(message: Record<string, unknown>): void;
  onMessage(listener: (message: Record<string, unknown>) => void): void;
  onExit(listener: (code: number | null, missing: boolean) => void): void;
  stop(): void;
}
/** `env`: the program's whole environment (an account's own folder included); absent is codexEnvironment(). */
export type StartAppServer = (command: string, env?: NodeJS.ProcessEnv) => AppServerChild;

/** Branch's short allowlist plus Codex's configured account folder and network transport. */
export function codexEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...cleanChildEnvironment(source), ...codexTransportEnvironment(source) };
}

/**
 * QA 2026-09-28: the program the npm-installed `codex` launcher itself starts. The launcher (bin/codex.js) is a node
 * process that only starts the platform's own codex binary and waits; kept running beside a warm app-server it held
 * about 61 MB. Found as the launcher finds it: the platform package that the codex package itself resolves, else its
 * own vendor folder. Null (the launcher is used) when codex is not an npm install or anything is not where expected.
 */
const platformPackages: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin", "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc",
};
export function codexBinary(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, arch: string = process.arch): { path: string; packageRoot: string } | null {
  try {
    const triple = platformPackages[`${platform}-${arch}`];
    if (!triple) return null;
    const start = startCall(command, [], env, platform);
    let script = start.args[0] ?? "";
    if (!/codex\.js$/.test(script)) { // not through a .cmd: the command on PATH, followed to where it really is
      const found = (env.PATH ?? env.Path ?? "").split(delimiter).map((folder) => join(folder, command)).find((file) => existsSync(file));
      script = found ? realpathSync(found) : "";
    }
    if (basename(script) !== "codex.js" || basename(dirname(script)) !== "bin") return null;
    const packageRoot = realpathSync(dirname(dirname(script)));
    const exe = platform === "win32" ? "codex.exe" : "codex";
    let vendor = join(packageRoot, "vendor");
    try { vendor = join(dirname(createRequire(join(packageRoot, "bin", "codex.js")).resolve(`@openai/codex-${platform}-${arch}/package.json`)), "vendor"); } catch { /* the package's own vendor folder */ }
    const path = join(vendor, triple, "bin", exe);
    return existsSync(path) ? { path, packageRoot } : null;
  } catch { return null; }
}

export const startCodexAppServer: StartAppServer = (command, env = codexEnvironment()) => {
  assertRealAgentAllowed(command, env);
  // Started as the npm launcher would start it, with what the launcher adds to its environment, but without the launcher.
  const binary = codexBinary(command, env);
  // An npm-installed codex is a .cmd launcher on Windows, started through its script with no shell (src/windows-command.ts).
  const start = binary ? { command: binary.path, args: ["app-server"] } : startCall(command, ["app-server"], env);
  const childEnv = binary ? { ...env, CODEX_MANAGED_PACKAGE_ROOT: binary.packageRoot, CODEX_MANAGED_BY_NPM: "1" } : env;
  const child = spawn(start.command, start.args, { stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true, env: childEnv });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const listeners: ((message: Record<string, unknown>) => void)[] = [];
  lines.on("line", (line) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    if (parsed && typeof parsed === "object") for (const listener of listeners) listener(parsed as Record<string, unknown>);
  });
  child.stdin.on("error", () => undefined);
  return {
    send: (message) => { child.stdin.write(`${JSON.stringify(message)}\n`); },
    onMessage: (listener) => { listeners.push(listener); },
    onExit: (listener) => {
      child.on("error", (error: NodeJS.ErrnoException) => listener(1, error.code === "ENOENT"));
      child.on("exit", (code) => listener(code, false));
    },
    stop: () => { child.kill(); },
  };
};

type Message = Record<string, unknown> & { id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };

/** One conversation turn with a Codex app-server, from the handshake to `turn/completed`. */
class Turn {
  private nextId = 1;
  private readonly waiting = new Map<number, (message: Message) => void>();
  private text = "";
  /** True once Codex answered the handshake: a program that exits before then has no app-server to speak. */
  greeted = false;
  constructor(private readonly child: AppServerChild, private readonly request: CompletionRequest,
    private readonly done: (error: Error | null, text: string) => void, private readonly version: string,
    private readonly thread: CodexThreadOptions = {}) {
    child.onMessage((message) => this.receive(message as Message));
  }
  private ask(method: string, params: Record<string, unknown>): Promise<Message> {
    const id = this.nextId++;
    return new Promise((resolve) => { this.waiting.set(id, resolve); this.child.send({ id, method, params }); });
  }
  private receive(message: Message): void {
    if (typeof message.id === "number" && !message.method) {
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
      return;
    }
    // A question from Codex: approvals are always declined, anything else is not spoken here.
    if (message.id !== undefined && message.method) {
      const approval = /requestApproval$/.test(message.method);
      this.child.send(approval ? { id: message.id, result: { decision: "decline" } } : { id: message.id, error: { code: -32601, message: "Not supported" } });
      return;
    }
    const params = message.params ?? {};
    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.text += params.delta;
      this.request.onTextDelta?.(params.delta);
    }
    if (message.method === "item/completed") {
      const item = params.item as { type?: string; text?: string } | undefined;
      if (!this.text && item?.type === "agentMessage" && typeof item.text === "string") this.text = item.text;
    }
    if (message.method === "turn/completed") {
      const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
      if (turn?.status === "completed") this.done(null, this.text);
      else this.done(new Error(`Codex stopped without finishing: ${turn?.error?.message ?? turn?.status ?? "no reason given"}`), this.text);
    }
  }
  async start(): Promise<void> {
    const hello = await this.ask("initialize", { clientInfo: { name: "branch_agent", title: "Branch Agent", version: this.version }, capabilities: null });
    if (hello.error) throw Object.assign(new Error(`Codex refused to start: ${hello.error.message ?? "no reason given"}`), { appServerUnavailable: true });
    this.greeted = true;
    this.child.send({ method: "initialized" });
    const thread = await this.ask("thread/start", { approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
      ...(this.thread.model ? { model: this.thread.model } : {}), ...(this.thread.cwd ? { cwd: this.thread.cwd } : {}) });
    const threadId = (thread.result?.thread as { id?: string } | undefined)?.id;
    if (!threadId) throw new Error(`Codex did not open a conversation: ${thread.error?.message ?? "no reason given"}`);
    const turn = await this.ask("turn/start", { threadId, input: [{ type: "text", text: agentPromptFrom(this.request), text_elements: [] }] });
    if (turn.error) throw new Error(`Codex refused the request: ${turn.error.message ?? "no reason given"}`);
  }
}

/** QA 2026-09-28: the model and folder a Codex-as-model turn uses, so Codex's own settings never decide either. */
export interface CodexThreadOptions { model?: string; cwd?: string; env?: NodeJS.ProcessEnv; silenceMs?: number }

export class CodexAppServerProvider implements Provider {
  readonly name = "app-server:codex";
  constructor(private readonly command = "codex", private readonly start: StartAppServer = startCodexAppServer,
    private readonly version = "0", private readonly timeoutMs = 300_000, private readonly thread: CodexThreadOptions = {}) {}

  complete(request: CompletionRequest): Promise<Completion> {
    request.signal.throwIfAborted();
    const child = this.thread.env ? this.start(this.command, this.thread.env) : this.start(this.command);
    return new Promise<Completion>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, text: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(quiet);
        request.signal.removeEventListener("abort", abort);
        child.stop();
        if (error) reject(error);
        else if (!text.trim()) reject(new Error("Codex answered with nothing at all."));
        else resolve({ content: text.trim(), toolCalls: [] });
      };
      const abort = (): void => finish(new Error("The request was stopped."), "");
      const timer = setTimeout(() => finish(new Error("Codex took too long and was stopped. Ask again, or pick another model."), ""), this.timeoutMs);
      timer.unref?.();
      // QA 2026-09-28: a Codex that says nothing at all for a while is stuck; stopped with a plain reason.
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const silence = this.thread.silenceMs;
      const hush = (): void => {
        clearTimeout(quiet);
        if (silence) (quiet = setTimeout(() => finish(new Error(`Codex said nothing at all for ${Math.round(silence / 1000)} seconds, so it was stopped. Run codex in a terminal to check it starts, then retry or pick another model.`), ""), silence)).unref?.();
      };
      if (silence) { hush(); child.onMessage(hush); }
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) { abort(); return; }
      const turn = new Turn(child, request, finish, this.version, this.thread);
      child.onExit((code, missing) => finish(Object.assign(new Error(missing
        ? `"${this.command}" is not on this computer, so Branch cannot use Codex. Install it, or pick another model.`
        : `Codex stopped (${code ?? "killed"}) before it finished answering.`), turn.greeted || missing ? {} : { appServerUnavailable: true }), ""));
      turn.start().catch((error: Error) => finish(error, ""));
    });
  }
  modelsList(): null { return null; }
}

/* ---- QA 2026-09-28: a warm Codex app-server per account ----
   Starting Codex (its own tool servers and hooks) took most of the 8-16 s before the first word. One app-server per
   Codex account folder is kept running after its first turn and reused. Exact transcript growth in the same owner
   conversation reuses its ephemeral, read-only thread and sends only the new messages. Changed context and concurrent
   calls open a fresh thread with Branch's whole transcript. Opening a thread starts
   Codex's own tool servers and hooks, which took about 5 s, so the next turn's thread is opened as soon as a turn ends
   and waits, ready, for the next question on the same model and folder. It stops after ten idle minutes, is started
   again after a crash, and every copy stops when Branch closes. */
const idleMs = 10 * 60_000;
type Waiter = (message: Message) => void;
const lostMark = Symbol("lost");

class WarmCodex {
  private readonly conversations = new CodexConversations();
  private readonly child: AppServerChild;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: Waiter; reject: (error: Error) => void }>();
  private readonly threads = new Map<string, Waiter>();
  private readonly ready: Promise<void>;
  private greeted = false;
  private gone: Error | null = null;
  private active = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;
  /** The next turn's thread, opened ahead of time, and the model and folder it was opened for. */
  private spare: { key: string; id: Promise<string> } | null = null;
  constructor(command: string, env: NodeJS.ProcessEnv | undefined, start: StartAppServer, version: string, private readonly forget: () => void) {
    this.child = env ? start(command, env) : start(command);
    this.child.onMessage((message) => this.receive(message as Message));
    this.child.onExit((code, missing) => this.lost(Object.assign(new Error(missing
      ? `"${command}" is not on this computer, so Branch cannot use Codex. Install it, or pick another model.`
      : `Codex stopped (${code ?? "killed"}) before it finished answering.`), this.greeted || missing ? {} : { appServerUnavailable: true })));
    this.ready = this.ask("initialize", { clientInfo: { name: "branch_agent", title: "Branch Agent", version }, capabilities: null }).then((hello) => {
      if (hello.error) throw Object.assign(new Error(`Codex refused to start: ${hello.error.message ?? "no reason given"}`), { appServerUnavailable: true });
      this.greeted = true;
      this.child.send({ method: "initialized" });
    });
    this.ready.catch(() => this.stop());
  }
  private ask(method: string, params: Record<string, unknown>): Promise<Message> {
    if (this.gone) return Promise.reject(this.gone);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.send({ id, method, params });
    });
  }
  private receive(message: Message): void {
    if (typeof message.id === "number" && !message.method) {
      this.waiting.get(message.id)?.resolve(message);
      this.waiting.delete(message.id);
      return;
    }
    // A question from Codex: approvals are always declined, anything else is not spoken here.
    if (message.id !== undefined && message.method) {
      const approval = /requestApproval$/.test(message.method);
      this.child.send(approval ? { id: message.id, result: { decision: "decline" } } : { id: message.id, error: { code: -32601, message: "Not supported" } });
      return;
    }
    const thread = codexNotificationScope(message).threadId;
    if (thread) this.threads.get(thread)?.(message);
  }
  private lost(error: Error): void {
    if (this.gone) return;
    this.gone = error;
    this.conversations.clear();
    clearTimeout(this.idle);
    this.forget();
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
    for (const waiter of [...this.threads.values()]) waiter({ method: lostMark.description } as Message);
  }
  stop(): void { if (this.gone) return; this.lost(new Error("Codex was stopped.")); this.child.stop(); }
  private rest(): void {
    clearTimeout(this.idle);
    if (this.active === 0 && !this.gone) (this.idle = setTimeout(() => this.stop(), idleMs)).unref?.();
  }
  /** Exact transcript continuations reuse a conversation's thread; changed context and parallel calls start fresh. */
  async turn(request: CompletionRequest, thread: CodexThreadOptions, timeoutMs: number, started: number): Promise<Completion> {
    request.signal.throwIfAborted();
    const key = JSON.stringify([thread.model ?? "", thread.cwd ?? ""]);
    this.active++;
    clearTimeout(this.idle);
    const continuation = this.conversations.acquire(request, thread.model, thread.cwd);
    try {
      const setupBudget = Math.min(thread.silenceMs || timeoutMs, Math.max(1, timeoutMs - (performance.now() - started)));
      const threadId = continuation.turn?.threadId ?? await this.startThread(request, thread, setupBudget);
      request.signal.throwIfAborted();
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) { this.stop(); throw new Error("Codex took too long and was stopped. Ask again, or pick another model."); }
      const { codexTurnId, ...answered } = await this.answer(threadId, request, thread.silenceMs ?? 0, remaining, continuation.text);
      if (codexTurnId) this.conversations.finish(continuation.turn, request, threadId, answered.content);
      else this.conversations.discard(continuation.turn); // older protocols without a turn id stay one-shot
      if (!this.gone && !this.spare) this.spare = { key, id: this.open(thread) }; // the next question's thread, ready
      this.spare?.id.catch(() => { this.spare = null; });
      return answered;
    } catch (error) {
      this.conversations.discard(continuation.turn);
      throw error;
    } finally {
      this.active--;
      this.rest();
    }
  }
  /**
   * Setup has no turn id to interrupt. A server that does not answer in time is stopped with all its pending RPCs; a
   * stopped request or a refused thread only ends this turn, since other conversations may be using the same server.
   */
  private startThread(request: CompletionRequest, thread: CodexThreadOptions, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, id?: string, unresponsive = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        if (unresponsive) this.stop();
        if (error) reject(error);
        else resolve(id!);
      };
      const abort = (): void => finish(new Error("The request was stopped."));
      const slow = new Error("Codex took too long to start a conversation and was stopped. Ask again, or pick another model.");
      const timer = setTimeout(() => finish(slow, undefined, true), timeoutMs);
      timer.unref?.();
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) { abort(); return; }
      void this.ready.then(async () => {
        const key = JSON.stringify([thread.model ?? "", thread.cwd ?? ""]), spare = this.spare;
        this.spare = null;
        return spare?.key === key ? await spare.id.catch(() => this.open(thread)) : await this.open(thread);
      }).then((id) => finish(null, id), (error: Error) => finish(error));
    });
  }
  private async open(thread: CodexThreadOptions): Promise<string> {
    const opened = await this.ask("thread/start", { approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
      ...(thread.model ? { model: thread.model } : {}), ...(thread.cwd ? { cwd: thread.cwd } : {}) });
    const threadId = (opened.result?.thread as { id?: string } | undefined)?.id;
    if (!threadId) throw new Error(`Codex did not open a conversation: ${opened.error?.message ?? "no reason given"}`);
    return threadId;
  }
  private answer(threadId: string, request: CompletionRequest, silenceMs: number, timeoutMs: number, input = agentPromptFrom(request)): Promise<Completion & { codexTurnId: string | null }> {
    return new Promise((resolve, reject) => {
      let text = "", settled = false, quiet: ReturnType<typeof setTimeout> | undefined;
      let turnId: string | null = null;
      let accepted = false;
      const pending: Message[] = [];
      const finish = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(quiet);
        request.signal.removeEventListener("abort", abort);
        this.threads.delete(threadId);
        if (error) reject(error);
        else if (!text.trim()) reject(new Error("Codex answered with nothing at all."));
        else resolve({ content: text.trim(), toolCalls: [], codexTurnId: turnId });
      };
      const hush = (): void => {
        clearTimeout(quiet);
        if (silenceMs) (quiet = setTimeout(() => finish(new Error(`Codex said nothing at all for ${Math.round(silenceMs / 1000)} seconds, so it was stopped. Run codex in a terminal to check it starts, then retry or pick another model.`)), silenceMs)).unref?.();
      };
      const interrupt = (): void => { void this.ask("turn/interrupt", { threadId }).catch(() => undefined); };
      const abort = (): void => { interrupt(); finish(new Error("The request was stopped.")); };
      const timer = setTimeout(() => { interrupt(); finish(new Error("Codex took too long and was stopped. Ask again, or pick another model.")); }, timeoutMs);
      timer.unref?.();
      request.signal.addEventListener("abort", abort, { once: true });
      hush();
      const receive = (message: Message): void => {
        if (settled) return;
        if (message.method === lostMark.description) { finish(this.gone ?? new Error("Codex stopped before it finished answering.")); return; }
        // Bind early notifications to the accepted turn id before processing any words.
        if (!accepted) {
          if (pending.length >= 64) { interrupt(); finish(new Error("Codex sent too many events before accepting its turn.")); }
          else pending.push(message);
          return;
        }
        if (!codexNotificationMatches(message, threadId, turnId)) return;
        hush();
        const params = message.params ?? {};
        if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") { text += params.delta; request.onTextDelta?.(params.delta); }
        if (message.method === "item/completed") {
          const item = params.item as { type?: string; text?: string } | undefined;
          if (!text && item?.type === "agentMessage" && typeof item.text === "string") text = item.text;
        }
        if (message.method === "turn/completed") {
          const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
          finish(turn?.status === "completed" ? null : new Error(`Codex stopped without finishing: ${turn?.error?.message ?? turn?.status ?? "no reason given"}`));
        }
      };
      this.threads.set(threadId, receive);
      if (request.signal.aborted) { abort(); return; }
      this.ask("turn/start", { threadId, input: [{ type: "text", text: input, text_elements: [] }] })
        .then((started) => {
          const turn = started.result?.turn as { id?: unknown } | undefined;
          turnId = typeof turn?.id === "string" ? turn.id : null;
          if (started.error) finish(new Error(`Codex refused the request: ${started.error.message ?? "no reason given"}`));
          accepted = true;
          for (const message of pending.splice(0)) receive(message);
        })
        .catch((error: Error) => finish(error));
    });
  }
}

const warmCodex = new Map<StartAppServer, Map<string, WarmCodex>>();
/** A turn on the warm app-server for this Codex and account folder, started on first use (or again after a crash). */
export function warmCodexTurn(command: string, start: StartAppServer, request: CompletionRequest,
  thread: CodexThreadOptions & { home?: string }, timeoutMs: number, version = "0"): Promise<Completion> {
  request.signal.throwIfAborted();
  const started = performance.now();
  let byKey = warmCodex.get(start);
  if (!byKey) warmCodex.set(start, byKey = new Map());
  const env = thread.env ?? codexEnvironment();
  const key = JSON.stringify([command, env.CODEX_HOME ?? "", thread.home ?? ""]), keys = byKey;
  let warm = keys.get(key);
  if (!warm) {
    const made: WarmCodex = new WarmCodex(command, env, start, version, () => { if (keys.get(key) === made) keys.delete(key); });
    keys.set(key, warm = made);
  }
  return warm.turn(request, thread, timeoutMs, started);
}
/** How many warm Codex app-servers are running (tests, the memory check). */
export const warmCodexCount = (): number => [...warmCodex.values()].reduce((sum, byKey) => sum + byKey.size, 0);
/** Stops every warm Codex (Branch closing). */
export function closeWarmCodex(): void {
  for (const byKey of warmCodex.values()) for (const warm of [...byKey.values()]) warm.stop();
  warmCodex.clear();
}
