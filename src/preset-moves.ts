import {
  cappedPolicy, evaluatePolicy, isReadOnlyPermission, policyPresets, presetMoved,
  type Policy, type PolicyDecision, type PolicyPresetName, type PolicyRequest, type PolicyRule,
} from "./policy.js";
import { globMatches, isCommandTool, resourceOf } from "./policy-resources.js";
import { policyForMode } from "./conversation-mode.js";
import { categoryLabels, categoryOf, toolCategories, type ToolCategory } from "./tool-categories.js";

/**
 * Weighing a move of the owner's approval preset. A move is never judged by where the preset sits in
 * the list: the policy's answer to each request is worked out before the move and after it, exactly as
 * the move would save it (`presetMoved`, with the owner's own rules), and the move is less careful when
 * any answer gets looser: a refusal that becomes a question or a yes, or a question that becomes a yes.
 * A move where some answers tighten and one loosens is still less careful.
 *
 * The answers are weighed three ways: as the owner's own tasks get them; as work started from outside
 * (a trigger, a schedule, a chat app, another program) gets them, since that work keeps the owner's
 * refusals and questions but none of their yeses (`cappedPolicy`; a folder the owner does not trust is
 * held the same way); and as a conversation on Full access gets them, which is held to the owner's own
 * rules alone, so a question of their own that the new preset's lines happen to repeat still counts.
 * The other conversation modes put their own questions around the same rules. The other checks a call
 * goes through (who is asking, Lockdown, Branch's own files, the questions some tools always ask) do
 * not depend on the preset, so a move leaves them as they were.
 */

/** The tools Branch has, as its registry lists them. */
export interface ToolLister { inventory(): readonly { name: string; permission: string }[] }

interface Tool { name: string; permission: string | null; readOnly: boolean }
/** Whose answers: the owner's own tasks, work started from outside, or a conversation on Full access. */
type Who = "own" | "outside" | "full";
interface Loosened { kind: ToolCategory; registered: boolean; freed: boolean; who: Who }

const strictness: Record<PolicyDecision, number> = { allow: 0, ask: 1, deny: 2 };
/** What a `*` in a rule's tool is taken to stand for, so a tool not registered right now is weighed as one that could be. */
const anyText = "some";
/** A tool whose name no rule gives, for what a tool nobody decided about gets. */
const unnamedTool = "tool-no-rule-names";
/** A command tool's call always carries a command, so it is weighed with one ("a command no rule mentions" asks). */
const someCommand = "some-program";
const holdsCommand = (tool: string): boolean => isCommandTool(tool) || tool === "remote.run";

/**
 * The tools a move is weighed on, by name: every registered tool, as reading or changing the way its
 * permission says; every tool a rule names, and one tool each rule's pattern stands for, both ways, since
 * one not registered now may be later; and a tool no rule names, both ways.
 */
function toolsFor(rules: readonly PolicyRule[], tools: ToolLister): Map<string, Tool[]> {
  const registered = new Map(tools.inventory().map((tool) => [tool.name, tool.permission]));
  const found = new Map<string, Tool[]>();
  const add = (name: string, readOnly: boolean): void => {
    const known = found.get(name) ?? [];
    if (!known.some((tool) => tool.readOnly === readOnly)) known.push({ name, permission: registered.get(name) ?? null, readOnly });
    found.set(name, known);
  };
  for (const [name, permission] of registered) add(name, isReadOnlyPermission(permission));
  for (const name of new Set([...rules.map((rule) => rule.tool.replaceAll("*", anyText)), unnamedTool])) { add(name, true); add(name, false); }
  return found;
}

/** Which kind of thing a tool does, for the words: its permission says, or for a tool not registered, whether it only looks. */
const kindOf = (tool: Tool): ToolCategory =>
  tool.permission !== null ? categoryOf(tool.name, tool.permission) : tool.readOnly ? "read" : categoryOf(tool.name, "");

/**
 * Whether a rule's tool pattern names this tool, worked out once per pattern. A pattern with no `*` is
 * matched letter for letter, so it can only name a tool whose name is exactly as long.
 */
function namerOf(tool: string): (rule: PolicyRule) => boolean {
  const known = new Map<string, boolean>();
  return (rule) => {
    let names = known.get(rule.tool);
    if (names === undefined)
      known.set(rule.tool, names = (rule.tool.includes("*") || rule.tool.length === tool.length) && globMatches(rule.tool, tool));
    return names;
  };
}

/**
 * The requests one tool is weighed with: about nothing in particular (a command for a command tool),
 * and about exactly what each rule for that tool names, as a request that rule covers. A request one of
 * the owner's kept refusals covers is left out: the kept refusals lead the list the move saves, and each
 * says no, so after the move it is refused whatever else changed, and cannot be looser.
 */
function requestsFor(tool: Tool, rules: readonly PolicyRule[], after: Policy): PolicyRequest[] {
  const permission = tool.permission ?? "";
  const plain = holdsCommand(tool.name) ? someCommand : "";
  const found: PolicyRequest[] = [{ tool: tool.name, target: plain, readOnly: tool.readOnly, resource: resourceOf(tool.name, permission, plain, {}) }];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.match === "*" && !rule.resource) continue;
    const target = rule.match !== "*" ? rule.match : rule.resource!.pattern;
    const resource = rule.resource ? { kind: rule.resource.kind, value: rule.resource.pattern } : resourceOf(tool.name, permission, target, {});
    const request: PolicyRequest = { tool: tool.name, target, readOnly: tool.readOnly, resource };
    const key = JSON.stringify([target, resource]);
    if (seen.has(key)) continue;
    seen.add(key);
    const keptRefusal = rule.decision === "deny" && after.rules.includes(rule) && evaluatePolicy({ ...after, rules: [rule] }, request).rule === rule;
    if (!keptRefusal) found.push(request);
  }
  return found;
}

/**
 * Every request whose answer is looser after the move, as the owner's tasks, work from outside and a
 * conversation on Full access get it. Each tool is weighed on the rules that name it only: a rule for
 * another tool never covers its requests, so the answers are the ones the whole list gives, found
 * without reading the whole list each time.
 */
function loosened(before: Policy, after: Policy, tools: ToolLister): Loosened[] {
  const rules = [...before.rules, ...after.rules];
  const views: [Who, Policy, Policy][] = [["own", before, after], ["outside", cappedPolicy(before, "schedule"), cappedPolicy(after, "schedule")],
    ["full", policyForMode(before, "full"), policyForMode(after, "full")]];
  const found: Loosened[] = [];
  for (const [name, variants] of toolsFor(rules, tools)) {
    const names = namerOf(name);
    const only = (policy: Policy): Policy => ({ ...policy, rules: policy.rules.filter(names) });
    const pairs = views.map(([who, was, now]) => [who, only(was), only(now)] as const);
    const own = rules.filter(names);
    for (const tool of variants)
      for (const request of requestsFor(tool, own, after))
        for (const [who, was, now] of pairs) {
          const from = evaluatePolicy(was, request).decision, to = evaluatePolicy(now, request).decision;
          if (strictness[to] < strictness[from]) found.push({ kind: kindOf(tool), registered: tool.permission !== null, freed: to === "allow", who });
        }
  }
  return found;
}

function listed(kinds: ToolCategory[]): string {
  const words = kinds.map((kind) => categoryLabels[kind].label.replace(/^./, (first) => first.toLowerCase()));
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
const kindsIn = (found: Loosened[]): ToolCategory[] => toolCategories.filter((kind) => found.some((one) => one.kind === kind));

/** Whose answers the words are about, when they are not the owner's own tasks'. */
const scopes: Record<Exclude<Who, "own">, string> = { outside: "for work started from outside, such as a trigger, a schedule or a chat app", full: "in a conversation on Full access" };

/**
 * What gets looser, by kind of thing rather than by tool, for one set of answers: the owner's own tasks
 * when theirs loosen, otherwise work from outside, otherwise a conversation on Full access, named as such.
 * The tools Branch has now are named; the ones a rule stands for but Branch does not have are named only
 * when nothing Branch has gets looser.
 */
function lessCarefulWords(label: string, found: Loosened[]): string {
  const who = (["own", "outside", "full"] as const).find((view) => found.some((one) => one.who === view)) ?? "own";
  const theirs = found.filter((one) => one.who === who);
  const named = theirs.some((one) => one.registered) ? theirs.filter((one) => one.registered) : theirs;
  const freed = kindsIn(named.filter((one) => one.freed));
  const asked = kindsIn(named.filter((one) => !one.freed)).filter((kind) => !freed.includes(kind));
  const parts = [...(freed.length ? [`${listed(freed)} without asking`] : []), ...(asked.length ? [`ask to ${listed(asked)}, which it refuses now`] : [])];
  return `${label} would let Branch ${parts.join(", and ")}${who === "own" ? "" : ` ${scopes[who]}`}`;
}

/** Without the tools there is nothing to weigh a move on, so it counts as less careful. */
const unweighed = "Branch could not list its tools to weigh this move on, so it counts as less careful";

/**
 * What moving the saved approval setting `current` to `preset` would make less careful, in plain words,
 * or null when nothing would. It throws, as saving would, when the move cannot be made.
 */
export function presetMoveLooser(current: Policy, preset: PolicyPresetName, tools: ToolLister | undefined): string | null {
  const after: Policy = { ...current, preset, rules: presetMoved(current, preset) };
  if (!tools) return unweighed;
  const found = loosened(current, after, tools);
  return found.length ? lessCarefulWords(policyPresets().find((one) => one.id === preset)?.label ?? preset, found) : null;
}

/** Q257: a per-minute limit is looser when it is taken away (0 means none) or raised. */
const limitLooser = (before: number, after: number): boolean => before > 0 && (after === 0 || after > before);
const limitWords: Record<keyof Policy["limits"], string> = {
  toolCallsPerMinute: "the limit on tool calls a minute", modelRoundsPerMinute: "the limit on model turns a minute",
};

/**
 * Q257: what a whole change of the saved approval policy would make less careful, in plain words, or null when
 * nothing would: the rules weighed as a preset move is (every answer before and after, three ways), a command no
 * rule mentions let through without asking, and a per-minute limit raised or taken away. POST /api/policy and
 * POST /api/approvals/categories weigh exactly the policy they would save.
 */
export function policyChangeLooser(before: Policy, after: Policy, tools: ToolLister | undefined): string | null {
  const words: string[] = [];
  if (!tools) words.push(unweighed);
  else {
    const found = loosened(before, after, tools);
    if (found.length) words.push(lessCarefulWords("This change", found));
  }
  if (before.unmatchedCommands === "ask" && after.unmatchedCommands === "allow") words.push("a command no rule mentions would run without asking");
  for (const key of Object.keys(limitWords) as (keyof Policy["limits"])[])
    if (limitLooser(before.limits[key], after.limits[key])) words.push(`${limitWords[key]} would be raised or taken away`);
  return words.length ? words.join("; ") : null;
}
