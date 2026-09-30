import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { errorText, type ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { PolicyCheck } from "../runtime.js";
import type { Store } from "../store.js";
import { argumentFingerprint } from "../question-fingerprint.js";
import { outsideTask, scopeOf, type ToolGateHost } from "../tool-gate.js";
import { commandAnswer, type DoorAnswer } from "./hand-off-door.js";
import type { HandOffCommands } from "./hand-off.js";

/**
 * SELF-083: a command a handed-off Claude Code sends through its door (src/coding/hand-off-door.ts), weighed and run
 * exactly as the handing-off task's own `shell.execute` would be. The task's permissions come first, then the owner's
 * rules, bound to these exact arguments. The self-development contract runs in `ToolRegistry.execute`. The wall
 * comes from the rule, never from the hand-off's own context. Writes are held to the job's folder, and the owner's
 * selected Full Access reaches the command the way it reaches the task's own: the network, never wider writes.
 * A question can't be answered inside a hand-off, so "ask" is a refusal in words, and Claude Code carries on.
 */

const shellTool = "shell.execute";
/** How long a command waits between tries while another of Branch's commands is running. */
const busyWaitMs = 250;

export interface HandOffCommandHost extends Pick<ToolGateHost, "wallFor"> {
  checkPolicy(tool: string, args: unknown, context: ToolContext, fingerprint?: string): PolicyCheck;
  ownerFullAccessFor(context: ToolContext): string | null;
}

/** The workspace path of `cwd` inside the job's folder, or null when it leads out of it. */
export function folderCwd(folder: { absolute: string; fromWorkspace: string }, cwd: string): string | null {
  const inside = relative(folder.absolute, resolve(folder.absolute, cwd));
  if (inside.startsWith("..") || isAbsolute(inside)) return null;
  return posix.join(folder.fromWorkspace, inside.split(sep).join("/")) || ".";
}

export function heldHandOffCommands(deps: { registry: ToolRegistry; store: Store; runtime: HandOffCommandHost }): HandOffCommands {
  return async (command, folder, context) => {
    const cwd = folderCwd(folder, command.cwd);
    if (cwd === null) return refusal(`${command.cwd} is outside the folder you were given, so the command did not run.`);
    const args = { executable: command.program, args: command.args, cwd,
      ...(command.timeoutSeconds ? { timeoutMs: command.timeoutSeconds * 1000 } : {}) };
    const outside = outsideTask(deps.registry, shellTool, context);
    if (outside) return refusal(outside);
    const check = deps.runtime.checkPolicy(shellTool, args, context, argumentFingerprint(shellTool, JSON.stringify(args)));
    if (check.decision !== "allow") {
      deps.store.event(context.runId, check.decision === "deny" ? "policy.denied" : "policy.ask",
        { name: shellTool, label: check.label, target: check.target, source: { kind: "hand-off" } });
      return refusal(check.decision === "deny"
        ? `Branch's rules refuse this command, so it did not run${check.reason ? `: ${check.reason}` : "."}`
        : "Branch's rules ask the owner before this command, and nobody can answer inside a hand-off, so it did not run. "
          + "Finish without it and say which command you needed.");
    }
    const { osSandbox: _outerWall, ownerFullAccess: _outerAccess, ...unwalled } = context;
    const scoped: ToolContext = { ...unwalled, ...scopeOf(deps.runtime as unknown as ToolGateHost, shellTool, args, context, check),
      writesConfinedTo: folder.absolute,
      ...(deps.runtime.ownerFullAccessFor(context) !== null ? { ownerFullAccess: true } : {}) };
    return runWhenFree(() => deps.registry.execute(shellTool, args, scoped), context.signal);
  };
}

/** Runs the command, waiting its turn while another of Branch's commands is running, as the hooks do (bootstrap.ts). */
async function runWhenFree(run: () => Promise<unknown>, signal: AbortSignal): Promise<DoorAnswer> {
  for (;;) {
    try {
      return commandAnswer(await run() as Parameters<typeof commandAnswer>[0]);
    } catch (error) {
      const message = errorText(error);
      if (!/already active/.test(message) || signal.aborted) return refusal(message);
      await new Promise((done) => setTimeout(done, busyWaitMs));
    }
  }
}

const refusal = (text: string): DoorAnswer => ({ text, isError: true });
