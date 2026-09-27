import type { ToolContext, ToolTarget } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { evaluatePolicy, type Policy, type PolicyDecision, type PolicyRule } from "./policy.js";
import { globMatches, tidyPath, type PolicyResource } from "./policy-resources.js";

/**
 * mac7/multi-target: a call that touches several things — a patch across files, two documents
 * compared, a knowledge base made from a list of folders, a repository folder — is judged on every
 * one of them. Each is weighed by the owner's rules as if the call touched only it, and the call goes
 * ahead only when every one is allowed: the strictest answer wins, and a refusal names the thing that
 * was refused. The call as a whole is still judged as it always was; this only ever adds to that.
 */

/** What the rules see of one target: the path as written, or a web address's host. */
export function targetText(target: ToolTarget): string {
  if (target.path !== undefined) return target.path;
  if (target.url === undefined) return "";
  try { return new URL(target.url).host; } catch { return target.url.slice(0, 300); }
}

const strictness: Record<PolicyDecision, number> = { allow: 0, ask: 1, deny: 2 };
/** Whether `a` is a stricter answer than `b`. */
export const stricterThan = (a: PolicyDecision, b: PolicyDecision): boolean => strictness[a] > strictness[b];

export interface TargetsVerdict {
  decision: PolicyDecision;
  /** The rule that gave the strictest answer, when a rule did. */
  rule: PolicyRule | null;
  /** The first target that got the strictest answer; null when every one was allowed. */
  target: ToolTarget | null;
}

export interface TargetsCall {
  tool: string; permission: string; callTarget: string; args: unknown;
  /**
   * Integration: what the rules see of one target's text — `ToolRegistry.resourceOf`, which also gives a
   * path as written from the workspace while a project's folder is active, so a folder rule holds for
   * every file in the call exactly as it does for a call with one.
   */
  resourceOf: (text: string) => PolicyResource | null;
  /** Redesign: the Trunk doing the work, so a rule for one Trunk is weighed only for that Trunk's calls. */
  trunk?: string | undefined;
}

/** Every target weighed by the rules; the strictest answer, and which target gave it. */
export function judgeTargets(policy: Policy, call: TargetsCall, targets: readonly ToolTarget[]): TargetsVerdict {
  let worst: TargetsVerdict = { decision: "allow", rule: null, target: null };
  for (const target of targets) {
    const text = targetText(target);
    const resource = call.resourceOf(text);
    const outcome = evaluatePolicy(policy, {
      tool: call.tool, target: text, readOnly: target.kind === "read", resource, callTarget: call.callTarget, trunk: call.trunk,
    });
    if (stricterThan(outcome.decision, worst.decision)) worst = { decision: outcome.decision, rule: outcome.rule, target };
    const inner = innerFolderRule(policy, call, target, resource?.inWorkspace);
    if (inner && stricterThan(inner.decision, worst.decision))
      worst = { decision: inner.decision, rule: inner, target: { kind: target.kind, path: inner.resource!.pattern } };
    if (worst.decision === "deny") break;
  }
  return worst;
}

/**
 * Integration (multi-target): a target that is a whole folder also reaches every folder inside it, so
 * a rule that asks about or refuses one of those counts: "never anything under finance" refuses a
 * repository diff of the workspace that holds finance, which would show finance's lines. Only rules
 * that ask or refuse are read this way; an allow for a folder inside never lets the whole one through.
 */
function innerFolderRule(policy: Policy, call: TargetsCall, target: ToolTarget, inWorkspace: string | undefined): PolicyRule | null {
  if (!target.folder || target.path === undefined) return null;
  // Inside a project's folder, "." is that folder: the rules are written about the workspace.
  const folder = tidyPath(inWorkspace ?? target.path).toLowerCase();
  return policy.rules.find((rule) => rule.resource?.kind === "path" && rule.decision !== "allow"
    && !(rule.applies === "changes" && target.kind === "read") && !(rule.applies === "reads" && target.kind !== "read")
    && globMatches(rule.tool, call.tool) && globMatches(rule.match, target.path!)
    && couldBeInside(tidyPath(rule.resource.pattern).toLowerCase(), folder)) ?? null;
}

/** Whether a folder pattern ("finance", "*.csv", "fin*") can name something inside `folder` ("" is the workspace). */
function couldBeInside(pattern: string, folder: string): boolean {
  if (folder === "" || folder === ".") return true;
  const within = `${folder}/`, star = pattern.indexOf("*");
  // A plain folder name is a whole name: "fin" is not inside "finance".
  if (star < 0) return `${pattern}/`.startsWith(within) || within.startsWith(`${pattern}/`);
  const fixed = pattern.slice(0, star);
  return within.startsWith(fixed) || fixed.startsWith(within);
}

const verbs: Record<ToolTarget["kind"], string> = { read: "read", write: "change", delete: "delete" };
/** What doing it to one target means, in plain words: "change finance/q1.csv". */
export const targetAction = (target: ToolTarget): string => `${verbs[target.kind]} ${targetText(target)}`;

/** The refusal when one of several targets is not allowed, naming it. */
export const targetRefusal = (label: string, target: ToolTarget): string =>
  `Your settings do not allow this: ${label}, because it would ${targetAction(target)}. Nothing was done. Tell the person what you wanted to do, and why.`;

/** The refusal when what a call would touch cannot be worked out. */
export const unknownTargetsRefusal = (problem: string): string =>
  `Branch could not tell every file this would touch, so it was not done: ${problem}`;

/**
 * Stands for whatever a call sends later (a schedule's result, a watch's news, the morning brief). It does
 * not exist yet; no rule reads the text, and the broadcast's own schema needs one.
 */
const laterMessage = "The schedule's result";

/** The chat a call names for what it sends later, as the tool itself names it; undefined when none. */
function chatSentToLater(tool: string, args: Record<string, unknown>): unknown {
  if (tool === "schedules.create" || tool === "brief.configure") return args.deliverTo;
  // A watch's news stays in the app's activity list unless the watch names a chat.
  if (tool === "monitor.create" || tool === "monitors.screen.create") return args.notifyVia === "activity" ? undefined : args.notifyVia;
  return undefined;
}

/**
 * Q138: what else a call does that another tool does, so the rules weigh it as that tool as well. A call
 * that names a chat to send to later sends a message there when the time comes, so it is also judged as
 * sending one to that chat now (`channels.broadcast`): "Message people" counts for it as well as "Change
 * settings". Those calls are a schedule that sends its result to a chat, a page or screen watch that
 * sends its news to one, and the morning brief given the chat it goes to. Every other call, and one of
 * these that names no chat, does nothing else.
 */
export function alsoJudgedAs(tool: string, args: unknown): { tool: string; args: { text: string; to: unknown[] } } | null {
  const to = args && typeof args === "object" ? chatSentToLater(tool, args as Record<string, unknown>) : undefined;
  return to ? { tool: "channels.broadcast", args: { text: laterMessage, to: [to] } } : null;
}

/**
 * The rules' answer for what a call also does (`alsoJudgedAs`), exactly as they answer that tool: the
 * call as a whole and each chat it reaches, the strictest winning. Null when it does nothing else. It
 * only ever makes an answer stricter, so the question put to the owner stays the call's own. What it
 * would reach cannot be told only for arguments the tool itself refuses, and that is refused here too.
 */
export function alsoDecision(
  registry: Pick<ToolRegistry, "targetOf" | "targetsOf" | "resourceOf" | "permissionOf">, policy: Policy,
  tool: string, args: unknown, context: ToolContext,
): PolicyDecision | null {
  const also = alsoJudgedAs(tool, args);
  if (!also) return null;
  const target = registry.targetOf(also.tool, also.args, context);
  // Sending a message always changes something.
  const whole = evaluatePolicy(policy,
    { tool: also.tool, target, readOnly: false, resource: registry.resourceOf(also.tool, target, also.args), trunk: context.trunk }).decision;
  let targets: ToolTarget[] | null;
  try { targets = registry.targetsOf(also.tool, also.args, context); } catch { return "deny"; }
  if (!targets) return whole;
  const spread = judgeTargets(policy, { tool: also.tool, permission: registry.permissionOf(also.tool), callTarget: target,
    args: also.args, resourceOf: (text) => registry.resourceOf(also.tool, text, also.args), trunk: context.trunk }, targets).decision;
  return stricterThan(spread, whole) ? spread : whole;
}

/**
 * For the places that weigh only the rules (another AI tool's dry run, "Try a tool" without the
 * runtime's gate): the whole call's answer made stricter by every thing it touches, and by what else
 * it does (`alsoDecision`). A call whose targets cannot be told is refused, as it would be when run.
 */
export function everyTargetDecision(
  registry: Pick<ToolRegistry, "targetOf" | "targetsOf" | "resourceOf" | "permissionOf">, policy: Policy,
  call: Omit<TargetsCall, "resourceOf">, context: ToolContext, whole: PolicyDecision,
): { decision: PolicyDecision; targets: ToolTarget[] } {
  const also = alsoDecision(registry, policy, call.tool, call.args, context);
  const ruled = also && stricterThan(also, whole) ? also : whole;
  let targets: ToolTarget[] | null;
  try { targets = registry.targetsOf(call.tool, call.args, context); } catch { return { decision: "deny", targets: [] }; }
  if (!targets) return { decision: ruled, targets: [] };
  const spread = judgeTargets(policy, { ...call, resourceOf: (text) => registry.resourceOf(call.tool, text, call.args) }, targets).decision;
  return { decision: stricterThan(spread, ruled) ? spread : ruled, targets };
}
