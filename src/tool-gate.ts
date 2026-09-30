import { ApprovalRequiredError, PolicyRefusedError } from "./approvals.js";
import type { ToolContext } from "./contracts.js";
import { folderTrustMode } from "./folder-trust.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { credentialInUrl } from "./leak-guard.js";
import { lockedDown, lowersRiskOnly } from "./lockdown.js";
import type { RunSource } from "./policy.js";
import type { RunGuards } from "./run-guards.js";
import type { PolicyCheck } from "./runtime.js";
import type { Store } from "./store.js";

/**
 * mac5/manual-actions: the one gate a tool run outside a conversation goes through
 * (`Runtime.executeTool`). A conversation's own calls keep their gate in the runtime; this is for
 * the rest — a tool pressed by hand in the app window, the code editor's save, a saved workflow's
 * step, a flow box, a live voice call, the pull-request hook.
 *
 * - "owner": the owner pressed it in the app window, so the owner is the one asking and an
 *   "ask first" rule they wrote does not stop it. Everything else still does: a refusing rule,
 *   Branch's own files (never-break), Lockdown and an untrusted folder for anything that changes
 *   something, and the sandbox a rule asks for.
 * - "policy" (the default, so a caller that forgets is held, not let through): work that runs by
 *   itself is held exactly as a task is — "ask" comes back as `ApprovalRequiredError`, bound to the
 *   exact bytes, for the caller to put to the owner.
 *
 * A short-lived key is not the owner at the window: in "owner" mode it is held to the full rules, so
 * only "allow" runs and every refusal names the key (mac5/key-sweep, one gate for both).
 *
 * The leak guard is not the owner's rule to skip either: an address carrying a key or password stays
 * a question ("Try a tool" puts it) and, where nothing can put it, a refusal.
 */
export type ToolGateMode = "owner" | "policy";

export interface ToolGateOptions {
  /** Internal MCP Apps host marker; never read from a remote tool's arguments. */
  appCaller?: boolean;
  mode?: ToolGateMode;
  /** Who set the work going; decides how far the approval rules are capped. Owner by default. */
  source?: RunSource;
  /** Where yeses already given are remembered (a workflow's or conversation's key). */
  approvalKey?: string;
  /** r17-h integration review: the caller's own stop (a time limit, a cancelled task) reaches the tool too. */
  signal?: AbortSignal;
  /**
   * mac7/lockdown-fix: set when a task (not the owner) started this work, such as a workflow a task
   * ran: the task's own permissions. Only tools they cover run; the call's context is narrowed to them.
   */
  within?: readonly string[];
  /** FQ-routing.isolated-agents: the agent executing this tool, for scope-aware memory and fact writes. */
  agent?: string;
}

export interface ToolGateHost {
  readonly store: Store;
  readonly owner: string;
  readonly guards: RunGuards;
  checkPolicy(tool: string, args: unknown, context: ToolContext, fingerprint?: string): PolicyCheck;
  /** The kind of permission a tool needs; empty for a tool that is not there. */
  permissionOf(tool: string): string;
  /** The OS sandbox wall, decided exactly as for a task's call: the owner's switch, tightened by rules. */
  wallFor(tool: string, args: unknown, context: ToolContext, choice: PolicyCheck["sandbox"]): Pick<ToolContext, "osSandbox">;
}

export const lockdownManualRefusal =
  "Lockdown is on, so nothing that changes anything is done by hand either. Turn Lockdown off in Settings to allow this again.";
export const shortLivedKeyRefusal =
  "Your approval settings ask first about this, and a short-lived key cannot say yes. Do it in the app window.";
export const leakManualRefusal =
  "This address carries a key or password, so it is not opened by hand without a question. Use \"Try a tool\" to be asked, or take the key out of the address.";
/** mac7/r17-g integration review: a tool whose yes needs an authenticator code is never run by hand without one. */
export const codeManualRefusal =
  "A yes to this needs the six-digit code from your authenticator app, and a tool pressed by hand cannot ask for it. Use \"Try a tool\" or ask Branch in a conversation, where the question card takes the code.";
export const untrustedManualRefusal =
  "This folder is not trusted, so nothing that changes anything in it is done by hand. Trust the folder in Settings first.";

function refused(tool: string, label: string, reason?: string): PolicyRefusedError {
  const error = new PolicyRefusedError(tool, label);
  if (reason) error.message = reason;
  return error;
}

/** Lockdown and an untrusted folder speak as "ask"; for a hand-pressed change they are a refusal. */
function ownerHold(host: ToolGateHost, tool: string, check: PolicyCheck): string | null {
  if (check.readOnly) return null;
  if (lockedDown(host.store, host.owner) && !lowersRiskOnly(tool)) return lockdownManualRefusal;
  if (folderTrustMode(host.store, host.owner) !== "off" && host.guards.trust() === "untrusted") return untrustedManualRefusal;
  return null;
}

export type SandboxScope = Pick<ToolContext, "sandbox" | "sandboxBackend" | "sandboxPaths" | "osSandbox">;

/** What the owner pressing a tool by hand gets: a refusal with its reason, a question, or a go. */
export interface ManualVerdict {
  decision: "allow" | "ask" | "deny";
  label: string;
  target: string;
  reason: string | null;
  scope: SandboxScope;
  /** The call's address carries a key or password (the leak guard's case), so its "ask" is not skipped. */
  leak: boolean;
}

/** Where the call runs: the rule's own sandbox choice and the wall, never anything the caller brought. */
export function scopeOf(host: ToolGateHost, tool: string, args: unknown, context: ToolContext, check: PolicyCheck): SandboxScope {
  return {
    ...host.wallFor(tool, args, context, check.sandbox),
    ...(check.sandbox ? { sandbox: check.sandbox } : {}),
    ...(check.backend ? { sandboxBackend: check.backend } : {}),
    ...(check.paths?.length ? { sandboxPaths: check.paths } : {}),
  };
}

/**
 * The owner's own hand-pressed call. "ask" is left only when a rule the owner wrote asked; Lockdown
 * and an untrusted folder, which speak as "ask", are a refusal here for anything that changes.
 */
export function manualVerdict(host: ToolGateHost, tool: string, args: unknown, context: ToolContext, fingerprint: string): ManualVerdict {
  const check = host.checkPolicy(tool, args, context, fingerprint);
  const base = { label: check.label, target: check.target, scope: scopeOf(host, tool, args, context, check), leak: carriesCredential(args) };
  const key = startedWithShortLivedKey();
  if (check.decision === "deny") return { ...base, decision: "deny", reason: key ? forKey(tool, check.reason) : check.reason ?? null };
  const held = ownerHold(host, tool, check);
  if (held) return { ...base, decision: "deny", reason: key ? forKey(tool, held) : held };
  if (check.decision === "ask" && key) return { ...base, decision: "deny", reason: shortLivedKeyRefusal };
  if (check.decision === "ask" && check.needsCode) return { ...base, decision: "deny", reason: codeManualRefusal }; // mac7/r17-g
  return { ...base, decision: check.decision, reason: null };
}

const forKey = (tool: string, reason: string | undefined): string =>
  `A short-lived key cannot run ${tool}. ${reason ?? "Your settings do not allow it."}`;

function carriesCredential(args: unknown): boolean {
  const address = (args as { url?: unknown } | null)?.url;
  return typeof address === "string" && credentialInUrl(address) !== null;
}

/** mac7/lockdown-fix: what a step is told when the task that started its workflow may not use the tool. */
export const outsideTaskRefusal = (tool: string): string =>
  `The task that started this workflow may not use ${tool}, so this step was not run. Start the workflow yourself to use it.`;

/** The same, for a saved recipe (its steps, checks or clean-up) that a task asked for. */
export const outsideRecipeRefusal = (tool: string): string =>
  `The task that asked for this recipe may not use ${tool}, so this step was not run. Run the recipe yourself to use it.`;

/**
 * mac7/lockdown-fix: a call whose tool is outside its context's permissions is refused here, before
 * any question is put, so work a task set going can never use a tool that task could not.
 */
export function outsideTask(host: Pick<ToolGateHost, "permissionOf">, tool: string, context: Pick<ToolContext, "permissions">): string | null {
  const permission = host.permissionOf(tool);
  return permission && !context.permissions.has(permission) ? outsideTaskRefusal(tool) : null;
}

/**
 * Decides one call. Throws `PolicyRefusedError` or `ApprovalRequiredError`; otherwise answers with
 * the sandbox the matching rule wants, to be put on the context the tool runs with.
 */
export function gateToolUse(host: ToolGateHost, tool: string, args: unknown, context: ToolContext,
  fingerprint: string, mode: ToolGateMode = "policy"): SandboxScope {
  const outside = outsideTask(host, tool, context); // mac7/lockdown-fix
  if (outside) throw refused(tool, tool, outside);
  if (mode === "owner") {
    // The owner is the one asking, so an "ask first" rule of theirs does not stop it.
    const verdict = manualVerdict(host, tool, args, context, fingerprint);
    if (verdict.decision === "deny") throw refused(tool, verdict.label, verdict.reason ?? undefined);
    if (verdict.decision === "ask" && verdict.leak) throw refused(tool, verdict.label, leakManualRefusal);
    return verdict.scope;
  }
  const check = host.checkPolicy(tool, args, context, fingerprint);
  if (check.decision === "deny") throw refused(tool, check.label, check.reason);
  if (check.decision === "ask") throw new ApprovalRequiredError(tool, check.target, check.label, check.remember, fingerprint, ...(check.onceOnly ? [{ onceOnly: true }] : []));
  return scopeOf(host, tool, args, context, check);
}

export const unattendedAskRefusal =
  "Your approval settings ask first about this, and nobody is there to say yes once a task has finished, so nothing was done. Ask Branch to do it in a conversation, or allow it in Settings.";

/**
 * Integration review: the gate's answer before anything is done, for work with a side effect ahead
 * of its tool call (the pull-request hook pushes before it opens). A plain sentence, or null for go.
 */
export function gateRefusal(host: ToolGateHost, tool: string, args: unknown, context: ToolContext,
  fingerprint: string, mode: ToolGateMode = "policy"): string | null {
  try {
    gateToolUse(host, tool, args, context, fingerprint, mode);
    return null;
  } catch (error) {
    if (error instanceof ApprovalRequiredError) return unattendedAskRefusal;
    return error instanceof Error ? error.message : "The approval check could not decide, so nothing was done.";
  }
}
