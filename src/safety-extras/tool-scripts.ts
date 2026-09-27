import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { pluginWall } from "../add-ons/walled-plugin.js";
import { ApprovalRequiredError } from "../approvals.js";
import type { ToolCall, ToolContext } from "../contracts.js";
import type { JournalHook } from "../never-break/journal.js";
import type { ToolRegistry } from "../registry.js";
import { argumentFingerprint } from "../question-fingerprint.js";
import { openWall, type SandboxStart, type WallDeps } from "../sandbox-backends.js";
import type { WallContext } from "../sandbox.js";
import { gateToolUse, type ToolGateHost } from "../tool-gate.js";
import { requireSafety } from "./settings.js";
import { scriptAnswerMarker, scriptHostSource } from "./script-host.js";

/**
 * mac7/r17-g (R17-061): the model writes one JavaScript module that calls several Branch tools,
 * instead of one round with the model per call. The idea follows Hermes Agent's
 * `tools/code_execution_tool.py` and `code_execution_rpc.py` (MIT); the code is written here.
 *
 *  - The script runs as its own program behind the wall (src/sandbox-backends.ts): no network at
 *    all, no keys, no environment of Branch's, Branch's data unreadable, writes only in its scratch
 *    folder. Anything it needs from outside it asks for through a tool.
 *  - Every `branch.call` goes through the one gate (src/tool-gate.ts) with the calling task's own
 *    context: its permissions, where it came from, its yeses. A call the rules would ask about is
 *    not asked mid-script; the script is told to leave that step to the task.
 *  - Only the tools the script named up front may be called, never a script from a script, and at
 *    most `maxCalls` calls; the whole run has a time limit.
 *  - Integration review: each call also passes the task's loop guard, is written to the task journal
 *    before it runs (under a `branch-script:` id no model call can have, so a restart finds it and
 *    the outer `tools.script` step is put to the owner rather than run again), and what it hands back
 *    has keys hidden before the script can reshape them.
 * On Windows there is no file and network wall, so scripts are refused there.
 */
export const maxCalls = 50;
export const ScriptInputSchema = z.object({
  source: z.string().min(1).max(32_768),
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/)).min(1).max(16),
  timeoutMs: z.number().int().min(1000).max(120_000).default(60_000),
}).strict();
export type ScriptInput = z.infer<typeof ScriptInputSchema>;

/** The runtime, as a script's calls need it: the gate, the loop guard, the journal and the key hider. */
export interface ScriptHost extends ToolGateHost {
  journal: JournalHook;
  hideSecrets: <T>(value: T) => T;
}
export interface ToolScriptDeps {
  host: ScriptHost;
  registry: Pick<ToolRegistry, "execute" | "permissionOf">;
  /** Places the script may never read: the owner's wall list and Branch's own data. */
  unreadable: () => readonly string[];
  wallDeps?: WallDeps;
  /** Starts the program; replaced in tests. */
  start?: (start: SandboxStart) => ChildProcess;
}
export interface ScriptResult { ok: boolean; result: unknown; calls: { tool: string; outcome: string }[]; output: string; error?: string }

export const windowsScriptRefusal = "On Windows Branch cannot wall a script off from your files and the internet, so tool scripts do not run here.";
export const askedInScript = "Your approval settings ask first about this, and a script cannot stop to ask. Call this tool on its own, outside the script.";

export class ToolScripts {
  constructor(private readonly deps: ToolScriptDeps) {}

  async run(input: ScriptInput, context: ToolContext): Promise<ScriptResult> {
    requireSafety(this.deps.host.store, this.deps.host.owner, "tool-scripts");
    if ((this.deps.wallDeps?.platform ?? process.platform) === "win32") throw new Error(windowsScriptRefusal);
    const staging = await mkdtemp(join(tmpdir(), "branch-script-"));
    try {
      await writeFile(join(staging, "script.mjs"), input.source, { mode: 0o600 });
      await writeFile(join(staging, "host.mjs"), scriptHostSource, { mode: 0o600 });
      const wall = scriptWall(context.osSandbox, this.deps.unreadable());
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: staging, TMPDIR: staging,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
      const plain = { executable: process.execPath, args: ["--no-warnings", "--max-old-space-size=256", join(staging, "host.mjs")], cwd: staging, env };
      const opened = await openWall(wall, plain, { workspace: staging }, this.deps.wallDeps ?? {});
      try { return await this.drive(opened.start, input, context, `branch-script:${randomUUID()}:`); }
      finally { await opened.close(); }
    } finally { await rm(staging, { recursive: true, force: true }).catch(() => undefined); }
  }

  private drive(start: SandboxStart, input: ScriptInput, context: ToolContext, idPrefix: string): Promise<ScriptResult> {
    const child = (this.deps.start ?? startScript)(start);
    child.stdin?.on("error", () => undefined); // a pipe that closes first must not throw on its own
    const calls: ScriptResult["calls"] = [];
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { if (output.length < 64_000) output += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { if (output.length < 64_000) output += chunk.toString("utf8"); });
    let queue = Promise.resolve();
    const requests = child.stdio[3];
    if (requests && "on" in requests) createInterface({ input: requests as NodeJS.ReadableStream }).on("line", (line) => {
      // mac7/linux-fixes: the script may be gone by the time its call is answered — stopped, timed
      // out or killed — and then this is a pipe with nobody reading it. Writing to one throws
      // EPIPE where nothing could catch it, which took the whole run down. The answer is simply
      // dropped instead: there is no longer anyone to give it to.
      queue = queue.then(() => this.answer(line, input, context, calls, idPrefix))
        .then((reply) => { if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(reply)}\n`, () => undefined); })
        .catch(() => undefined);
    });
    return new Promise<ScriptResult>((resolve) => {
      const timer = setTimeout(() => stopChild(child), input.timeoutMs);
      const abort = () => stopChild(child);
      context.signal.addEventListener("abort", abort, { once: true });
      child.on("error", (error) => { output += `\n${error.message}`; });
      child.on("close", () => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
        resolve(readScriptAnswer(output, calls));
      });
    });
  }

  /** One `branch.call`: named up front, within the count, and let through by the gate. */
  private async answer(line: string, input: ScriptInput, context: ToolContext, calls: ScriptResult["calls"], idPrefix: string): Promise<Record<string, unknown>> {
    let request: { id?: unknown; tool?: unknown; args?: unknown };
    try { request = JSON.parse(line) as typeof request; } catch { return { id: null, ok: false, error: "unreadable request" }; }
    const id = request.id, tool = String(request.tool ?? "");
    const refuse = (error: string, outcome = "refused") => { calls.push({ tool, outcome }); return { id, ok: false, error }; };
    if (calls.length >= maxCalls) return refuse(`A script may make at most ${maxCalls} tool calls.`);
    if (tool === "tools.script" || !input.tools.includes(tool)) return refuse(`${tool} was not named in the script's list of tools.`);
    const note = (outcome: string) => { if (context.runId) this.deps.host.store.event(context.runId, "script.called", { name: tool, outcome }); };
    try {
      const reply = await this.perform(tool, request.args ?? {}, context, `${idPrefix}${calls.length}`);
      if (!reply.ok) { note("stopped"); return refuse(reply.error ?? "The loop guard stopped this call.", "stopped"); }
      calls.push({ tool, outcome: "done" });
      note("done");
      return { id, ok: true, result: reply.result ?? null };
    } catch (error) {
      const asked = error instanceof ApprovalRequiredError;
      note(asked ? "asked" : "failed");
      return refuse(asked ? askedInScript : error instanceof Error ? error.message : String(error), asked ? "needs a yes" : "failed");
    }
  }

  /** Gate, then journal and loop guard around the call itself, as a task's own call has them. */
  private async perform(tool: string, args: unknown, context: ToolContext, callId: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const { host, registry } = this.deps;
    const scope = gateToolUse(host, tool, args, context, argumentFingerprint(tool, JSON.stringify(args ?? {})), "policy");
    // As in Runtime.callTool: the wall comes only from the gate, never from the context handed in.
    const { osSandbox: _outer, ...unwalled } = context;
    const execute = async () => ({ ok: true, result: host.hideSecrets(await registry.execute(tool, args, { ...unwalled, ...scope })) });
    const runId = context.runId;
    if (!runId) return execute();
    const call: ToolCall = { id: callId, name: tool, arguments: JSON.stringify(args) };
    const sessionId = host.store.run(runId)?.sessionId ?? runId;
    return await host.journal.around({ runId, sessionId, call, permission: registry.permissionOf(tool), workspace: context.workspace, signal: context.signal },
      () => host.guards.call(runId, call, execute)) as { ok: boolean; result?: unknown; error?: string };
  }
}

/**
 * The wall a script runs behind. A task's own wall may carry key sites and a wider reach for its
 * commands; a script gets none of that: no network at all, no keys, and Branch's data unreadable
 * whatever the task's wall said. Writes the owner already allowed stay allowed.
 */
export function scriptWall(outer: WallContext | undefined, unreadable: readonly string[]): WallContext {
  if (!outer) return pluginWall([], unreadable);
  return { ...outer, network: "none", keySites: {}, siteCheck: undefined,
    unreadable: [...new Set([...outer.unreadable, ...unreadable])],
    answer: (kind, target) => (kind === "network.site" ? "deny" : outer.answer(kind, target)) };
}

function startScript(start: SandboxStart): ChildProcess {
  return spawn(start.executable, start.args, { cwd: start.cwd, env: start.env, shell: false, windowsHide: true,
    detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"] });
}
function stopChild(child: ChildProcess): void {
  try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

const AnswerShape = z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.string().max(1000).optional() }).strip();
export function readScriptAnswer(stdout: string, calls: ScriptResult["calls"]): ScriptResult {
  const at = stdout.lastIndexOf(scriptAnswerMarker);
  const output = (at < 0 ? stdout : stdout.slice(0, at)).slice(-8000);
  if (at < 0) return { ok: false, result: null, calls, output, error: "The script stopped without answering (it may have run out of time)." };
  const parsed = AnswerShape.safeParse((() => { try { return JSON.parse(stdout.slice(at + scriptAnswerMarker.length).split("\n")[0] ?? ""); } catch { return null; } })());
  if (!parsed.success) return { ok: false, result: null, calls, output, error: "The script's answer could not be read." };
  return { ok: parsed.data.ok, result: parsed.data.result ?? null, calls, output, ...(parsed.data.error ? { error: parsed.data.error } : {}) };
}

export function registerToolScripts(registry: ToolRegistry, scripts: ToolScripts): void {
  registry.register({
    name: "tools.script", permission: "code.execute", group: "code",
    description: "Run one JavaScript module that calls several tools in a row. Name every tool it will use in `tools`. Inside, `await branch.call(\"files.read\", { path })` runs a tool under the same approval rules as a direct call; `export default` a value or an async function taking `branch` to answer. The script has no internet and no keys; a call the rules would ask about is refused inside a script.",
    parameters: ScriptInputSchema,
    target: (args) => `a script calling ${args.tools.join(", ")}`,
    execute: (args, context) => scripts.run(args, context),
  });
}
