import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { killProcessGroup, killWindowsTree } from "../integrations/shell-process.js";
import { startCall } from "../windows-command.js";
import { assertRealAgentAllowed } from "./real-agent-guard.js"; // owner-dm-signin: never the real program from a test
import { boundedNativeJson, type NativeFrame } from "./claude-subscription-history.js";

export interface NativeInvocation { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }
export type NativeSpawn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export interface NativeEvent { type?: string; num_turns?: number; is_error?: boolean; subtype?: string; [key: string]: unknown }
/** Only this request's process group/tree is stopped. No command output enters error messages. */
export class NativeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<number | null>;
  private readonly events: (NativeEvent | Error | null)[] = [];
  private waiter: ((event: NativeEvent | Error | null) => void) | null = null;
  private bytes = 0;
  private ended = false;
  private stopping: Promise<void> | null = null;
  private readonly rates: string[] = [];
  constructor(invocation: NativeInvocation, start: NativeSpawn = spawn) {
    if (start === spawn) assertRealAgentAllowed(invocation.command, invocation.env);
    const call = startCall(invocation.command, invocation.args, invocation.env);
    this.child = start(call.command, call.args, { env: invocation.env, cwd: invocation.cwd, shell: false, windowsHide: true, detached: true });
    this.closed = new Promise((resolve) => {
      this.child.once("error", () => { this.put(new Error("Claude Code is not available; check its installation and saved sign-in")); resolve(null); });
      this.child.once("close", (code) => { this.ended = true; this.put(null); resolve(code); });
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.bytes += chunk.length;
      if (this.bytes > 8 * 1024 * 1024) this.put(new Error("Claude subscription native output exceeds 8 MiB"));
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.line(line));
    this.child.stderr.resume(); // Native diagnostics can contain private data; never retain or report them.
    this.child.stdin.on("error", () => this.put(new Error("Claude subscription native input closed")));
  }
  private line(line: string): void {
    let event: NativeEvent;
    try { event = JSON.parse(line); } catch { return this.put(new Error("Claude subscription returned invalid native protocol JSON")); }
    if (!event || typeof event !== "object" || typeof event.type !== "string")
      return this.put(new Error("Claude subscription returned an invalid native protocol event"));
    if (event.type === "rate_limit_event" && this.rates.length < 32) this.rates.push(line);
    this.put(event);
  }
  private put(event: NativeEvent | Error | null): void {
    if (this.waiter) { const receive = this.waiter; this.waiter = null; receive(event); }
    else if (this.events.length < 1024) this.events.push(event);
    else { this.events.length = 0; this.events.push(new Error("Claude subscription native event queue exceeds its limit")); }
  }
  async receive(signal: AbortSignal): Promise<NativeEvent | null> {
    signal.throwIfAborted();
    const next = this.events.length ? this.events.shift()! : this.ended ? null
      : await new Promise<NativeEvent | Error | null>((resolve) => {
        const abort = (): void => { this.waiter = null; resolve(signal.reason instanceof Error ? signal.reason : new Error("Claude subscription cancelled")); };
        this.waiter = (event) => { signal.removeEventListener("abort", abort); resolve(event); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    if (next instanceof Error) throw next;
    signal.throwIfAborted(); return next;
  }
  async send(frame: NativeFrame, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => this.child.stdin.write(boundedNativeJson(frame) + "\n", (error) =>
      error ? reject(new Error("Claude subscription could not replay its history")) : resolve()));
  }
  rateEvents(): string { return this.rates.join("\n"); }
  isClosed(): boolean { return this.ended; }
  beginTurn(): void {
    if (this.ended || this.waiter || this.stopping) throw new Error("Claude subscription native session is not available");
    this.bytes = 0; this.rates.length = 0;
  }
  stop(): Promise<void> { return this.stopping ??= this.stopTree(); }
  private async stopTree(): Promise<void> {
    const pid = this.child.pid;
    if (!pid || this.ended) return;
    if (process.platform === "win32") {
      if (!(await killWindowsTree(pid)) && !this.ended) throw new Error("Claude subscription process tree could not be stopped");
    } else await killProcessGroup(pid);
    await this.closed;
  }
}
