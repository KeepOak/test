import type { ApprovalGate } from "./approvals.js";
import type { ToolContext, ToolTarget } from "./contracts.js";
import { judgeTargets } from "./policy-targets.js";
import { evaluatePolicy, isReadOnlyPermission, type Policy } from "./policy.js";
import { resourceOf } from "./policy-resources.js";
import { fencedFolders } from "./trunks/shell-fence.js";
import { wallApplies, wallNetworkFor, wallSettings, type SandboxChoice, type WallContext, type WallQuestion } from "./sandbox.js";

/**
 * Wave mac3 (os-sandbox): what the runtime hands a tool about the wall, worked out in one place just
 * before the tool runs. The runtime calls `wallContextFor` once and spreads the answer into the
 * call's context; nothing else in the runtime knows about the wall.
 *
 * The wall is never decided by the call itself: the switch comes from the owner's settings, "when
 * needed" follows the owner's rules, and a rule can only make it stricter.
 */

/** What only the app knows: the owner's network rules and where Branch keeps its own data. */
export interface WallEdge { siteCheck?: (target: URL) => Promise<void>; fakeIpProxy?: () => boolean; dataDir?: string }
const edges = new WeakMap<object, WallEdge>();
export function setWallEdge(store: object, edge: WallEdge): void { edges.set(store, edge); }
export function wallEdgeFor(store: object): WallEdge { return edges.get(store) ?? {}; }

export interface WallCall {
  store: { get(kind: string, owner: string, key: string): { data: unknown } | undefined; run(id: string): { sessionId: string } | undefined };
  owner: string;
  policy: Policy;
  approvals: Pick<ApprovalGate, "answer" | "grants" | "revoke">;
  context: ToolContext;
  tool: string;
  permission: string;
  target: string;
  args: unknown;
  /** mac7/multi-target: every thing the call touches, when its tool names more than one (`ToolRegistry.targetsOf`). */
  targets?: readonly ToolTarget[] | null | undefined;
  /** mac3/never-break's places: the wall makes the system itself refuse them too. */
  untouchable?: { noChange: readonly string[]; noRead: readonly string[] } | undefined;
  /** How tightly the matching rule wanted the program held, when it said. */
  choice: SandboxChoice | null;
}

/** Only rules written about this one question count; a broad "*" rule never opens a site. */
const questionRules = (policy: Policy, kind: WallQuestion): Policy =>
  ({ ...policy, rules: policy.rules.filter((rule) => rule.tool === kind && !rule.resource) });

function ruledAnswer(policy: Policy, kind: WallQuestion, target: string): "allow" | "deny" | undefined {
  const { rule } = evaluatePolicy(questionRules(policy, kind), { tool: kind, target, readOnly: false });
  return rule && rule.decision !== "ask" ? rule.decision : undefined;
}

/** A rule's standing yes to a write names one file, never a pattern. */
const fileRule = (match: string): boolean => match.startsWith("/") && !match.includes("*");

/** The tools that start a program on this computer, and so honour the wall. */
export const walledTools: readonly string[] = ["shell.execute", "code.run", "process.start"];

export function wallContextFor(call: WallCall): { osSandbox?: WallContext } {
  // Windows keeps its job object and throwaway desktop exactly as they were.
  if (process.platform === "win32" || !walledTools.includes(call.tool)) return {};
  const settings = wallSettings(call.store, call.owner);
  const resource = resourceOf(call.tool, call.permission, call.target, call.args);
  const readOnly = isReadOnlyPermission(call.permission);
  const risky = call.choice !== null
    || evaluatePolicy(call.policy, { tool: call.tool, target: call.target, readOnly, resource }).decision !== "allow"
    // mac7/multi-target: and when any one of the things it touches is not simply allowed.
    || (!!call.targets && judgeTargets(call.policy, { tool: call.tool, permission: call.permission, callTarget: call.target, args: call.args,
      resourceOf: (text) => resourceOf(call.tool, call.permission, text, call.args) }, call.targets).decision !== "allow");
  if (!wallApplies(settings.mode, risky)) return {};
  const { context, approvals, policy } = call;
  const sessionId = context.approvalKey ?? call.store.run(context.runId)?.sessionId ?? context.runId;
  const edge = wallEdgeFor(call.store);
  const answer = (kind: WallQuestion, target: string): "allow" | "deny" | undefined => {
    const ruled = ruledAnswer(policy, kind, target), given = approvals.answer(sessionId, kind, target);
    return ruled === "deny" || given === "deny" ? "deny" : ruled ?? given;
  };
  const granted = (kind: WallQuestion): string[] => {
    const given = approvals.grants(sessionId).filter((grant) => grant.tool === kind && grant.decision === "allow").map((grant) => grant.target);
    const ruled = questionRules(policy, kind).rules.filter((rule) => rule.decision === "allow" && fileRule(rule.match)).map((rule) => rule.match);
    return [...new Set([...given, ...ruled])].filter((target) => answer(kind, target) === "allow");
  };
  return { osSandbox: {
    network: wallNetworkFor(settings.network, call.choice),
    keySites: settings.keySites,
    // A Trunk's program never reads another Trunk's folder (src/trunks/shell-fence.ts).
    unreadable: [...settings.unreadable, ...(edge.dataDir ? [edge.dataDir] : []), ...(call.untouchable?.noRead ?? []), ...fencedFolders(context)],
    readOnly: [...(call.untouchable?.noChange ?? [])],
    answer, granted, spend: (kind, target) => { approvals.revoke(sessionId, kind, target); },
    ...(edge.siteCheck ? { siteCheck: edge.siteCheck } : {}),
    ...(edge.fakeIpProxy ? { fakeIpProxy: edge.fakeIpProxy } : {}),
  } };
}
