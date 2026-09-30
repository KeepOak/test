import { z } from "zod";
import type { Store } from "./store.js";
import type { Policy, PolicyRule } from "./policy.js";
import { evaluatePolicy, nextPolicy, readPolicy, savePolicy } from "./policy.js";
import { policyChangeRefusal, tickToConfirm } from "./policy-change-guard.js";
import type { ToolLister } from "./preset-moves.js";
import { recordedWrite, byCard } from "./settings-kit/recorded-write.js";
import { busyTasks } from "./comfort/auto-update.js";
import { ordinarySettingsRule } from "./settings-kit/ordinary-approval.js";

/**
 * Settings › Branch itself: what Branch may do about itself, as the approval rules keep it (src/policy.ts). Each row is
 * the rules for its own tools, read and written here so the window shows the rule really in force:
 *
 *   ownSettings     settings.change      Ordinary changes allowed (explicit allow) | Ask me first | Never
 *   gatewayTimings  gateway.propose      Suggest (no refusal)      | Never (a refusal)
 *   restart         branch.restart_engine Allowed (an allow rule)  | Ask me first (an ask rule)
 *   selfDev         branch.prepare_source_change and its two siblings: on (no refusal) | off (refusals)
 *
 * Loosening what it may do always asks: a change that makes Branch less careful needs the owner's separate yes
 * (`confirmLoosening`, weighed by policyChangeRefusal on exactly the policy it would save) and is refused under Lockdown.
 */
export const selfRulesPath = "/api/self-rules";
const selfDevTools = ["branch.prepare_source_change", "branch.widen_source_contract", "branch.finish_source_change"] as const;
export const restartTool = "branch.restart_engine";

export const SelfRuleChangeSchema = z.discriminatedUnion("control", [
  z.object({ control: z.literal("ownSettings"), value: z.enum(["allowed", "ask", "never"]) }).strict(),
  z.object({ control: z.literal("gatewayTimings"), value: z.enum(["suggest", "never"]) }).strict(),
  z.object({ control: z.literal("restart"), value: z.enum(["allowed", "ask"]) }).strict(),
  z.object({ control: z.literal("selfDev"), value: z.enum(["on", "off"]) }).strict(),
]);
export type SelfRuleChange = z.infer<typeof SelfRuleChangeSchema>;

const refuses = (policy: Policy, tool: string): boolean => policy.rules.some((rule) => rule.decision === "deny"
  && (rule.tool === tool || rule.tool === `${tool.split(".")[0]}.*`) && rule.match === "*");
const decisionFor = (policy: Policy, tool: string) => evaluatePolicy(policy, { tool, target: "*", readOnly: false }).decision;

export interface SelfRulesView {
  ownSettings: "allowed" | "ask" | "never"; gatewayTimings: "suggest" | "never"; restart: "allowed" | "ask" | null;
  selfDev: { on: boolean; available: boolean }; loosening: "ask";
  restartOffered: boolean; working: number;
}

export function selfRulesView(store: Store, owner: string, names: readonly string[]): SelfRulesView {
  const policy = readPolicy(store, owner);
  const restart = decisionFor(policy, restartTool);
  const own = evaluatePolicy(policy, { tool: "settings.change", target: "*", readOnly: false });
  return {
    ownSettings: own.decision === "deny" ? "never" : ordinarySettingsRule(own.rule) ? "allowed" : "ask",
    gatewayTimings: refuses(policy, "gateway.propose") ? "never" : "suggest",
    restart: restart === "allow" ? "allowed" : restart === "ask" ? "ask" : null,
    // Its tools are offered only while sending Git work to a remote is on (src/self-development.ts).
    selfDev: { on: !refuses(policy, selfDevTools[0]) && names.includes(selfDevTools[0]), available: names.includes("git.push") },
    loosening: "ask", restartOffered: names.includes(restartTool), working: busyTasks(store).working,
  };
}

/** The rules after one change: every rule of this row's own tools is taken out, then the row's own rule put in front. */
export function rulesAfter(policy: Policy, change: SelfRuleChange): PolicyRule[] {
  const own: readonly string[] = change.control === "ownSettings" ? ["settings.change"] : change.control === "gatewayTimings" ? ["gateway.propose"]
    : change.control === "restart" ? [restartTool] : selfDevTools;
  const kept = policy.rules.filter((rule) => !(own.includes(rule.tool) && rule.match === "*"));
  const rule = (tool: string, decision: PolicyRule["decision"]) => ({ tool, match: "*", decision } as PolicyRule);
  const added = change.control === "restart" ? [rule(restartTool, change.value === "allowed" ? "allow" : "ask")]
    : change.control === "ownSettings" && change.value === "allowed" ? [rule("settings.change", "allow")]
    : (change.value === "never" || change.value === "off") ? own.map((tool) => rule(tool, "deny")) : [];
  return [...added, ...kept];
}

export function changeSelfRule(store: Store, owner: string, input: unknown, confirmLoosening: boolean, tools: ToolLister,
  names: readonly string[]): SelfRulesView {
  const change = SelfRuleChangeSchema.parse(input);
  const current = readPolicy(store, owner);
  const next = nextPolicy(current, { rules: rulesAfter(current, change) });
  const refusal = policyChangeRefusal(store, owner, next, confirmLoosening, tools);
  if (refusal) throw new SelfRuleRefusal(refusal);
  // A broad policy may already allow the tool while its extra runtime hold still asks.
  // Opting out of that hold therefore needs confirmation even if the policy decision stays allow.
  const was = evaluatePolicy(current, { tool: "settings.change", target: "*", readOnly: false });
  if (change.control === "ownSettings" && change.value === "allowed" && !ordinarySettingsRule(was.rule) && !confirmLoosening)
    throw new SelfRuleRefusal(`This makes Branch less careful: ordinary settings changes no longer ask first. ${tickToConfirm}`);
  recordedWrite(store, owner, byCard("policy"), ["policy"],
    () => savePolicy(store, owner, { rules: next.rules }, `Settings › Branch itself: ${change.control} set to ${change.value}`));
  return selfRulesView(store, owner, names);
}

export class SelfRuleRefusal extends Error {}
