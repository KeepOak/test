import { ApprovalRequiredError } from "../approvals.js";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import { argumentFingerprint, type Runtime } from "../runtime.js";
import { gateToolUse } from "../tool-gate.js";

/**
 * R17-D: a Branch tool one of the coding parts runs on a task's behalf (an @ mention read, a check's
 * helper). It is held exactly as the task's own call would be: the task's permissions, then the one
 * tool gate (src/tool-gate.ts) in "policy" mode — refusals, never-break, Lockdown, folder trust and
 * the rules — then the sandbox the rule asks for, and secrets hidden from the answer. A call the
 * rules want to ask about is not asked here; it is skipped and said so.
 */
export interface GateHost { runtime: Pick<Runtime, "hideSecrets"> & Parameters<typeof gateToolUse>[0]; registry: ToolRegistry }

export class SkippedCall extends Error {
  override name = "SkippedCall";
}

export async function gatedCall(host: GateHost, name: string, args: unknown, context: ToolContext): Promise<unknown> {
  const permission = host.registry.permissionOf(name);
  if (!permission || !context.permissions.has(permission)) throw new SkippedCall(`this task may not use ${name}`);
  let scope;
  try {
    scope = gateToolUse(host.runtime, name, args, context, argumentFingerprint(name, JSON.stringify(args ?? {})), "policy");
  } catch (error) {
    if (error instanceof ApprovalRequiredError) throw new SkippedCall(`your approval settings ask first about ${name}`);
    throw new SkippedCall(error instanceof Error ? error.message : `${name} was refused`);
  }
  const result = await host.registry.execute(name, args, { ...context, ...scope });
  return host.runtime.hideSecrets(result);
}
