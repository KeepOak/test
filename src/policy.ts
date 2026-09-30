import { z } from "zod";
import { audit } from "./audit.js";
import { globMatches, isCommandTool, ResourceMatcherSchema, resourceMatches, tidyPath, type PolicyResource } from "./policy-resources.js";
import { commandPrefix, exactCommandPattern, plainWords } from "./command-prefix.js";
import { sandboxChoices } from "./sandbox.js";
import { sandboxBackends } from "./sandbox-backends.js";
import type { Store } from "./store.js";
import { optionalFields } from "./feature-switches.js";
import { asksEveryTime, asksUnlessRuled } from "./devices/capabilities.js"; // mac7/nodes

export { globMatches } from "./policy-resources.js";

/**
 * The owner's approval policy: an ordered list of rules that says, for each tool and for what that
 * tool would touch, whether the assistant may go ahead, must ask first, or may not do it at all.
 * The first rule that matches wins. With no rules nothing is asked and nothing is refused, which is
 * how Branch Agent behaves until the owner picks a preset.
 */

/** Tools that ask by default even with no policy rules written (shared desktop control). */
const asksUnlessRuledDefault = (tool: string): boolean => tool.startsWith("desktop.shared.");
export const PolicyDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export const PolicyRememberSchema = z.enum(["never", "session", "always"]);
export type PolicyRemember = z.infer<typeof PolicyRememberSchema>;

export const PolicyRuleSchema = z
  .object({
    /** A tool name, or a pattern where `*` stands for any text: "files.write", "browser.*", "*". */
    tool: z.string().min(1).max(100).default("*"),
    /** What the tool would touch: a file path, a command, or a web address's host. `*` matches anything. */
    match: z.string().min(1).max(500).default("*"),
    /**
     * "changes" limits the rule to tools that can change something; "reads" to tools that only look
     * (Q59: how Plan keeps the owner's own questions without turning its refusals into questions);
     * "any" covers every tool.
     */
    applies: z.enum(["any", "changes", "reads"]).default("any"),
    decision: PolicyDecisionSchema,
    /** What a "yes" to this question is remembered as, unless the person picks differently. */
    remember: PolicyRememberSchema.default("session"),
    /**
     * What the rule is about: a folder, a website, a messaging account or a command. Left out, the
     * rule covers whatever the tool would touch, which is how every rule written before this behaves.
     */
    resource: ResourceMatcherSchema.optional(),
    /**
     * How tightly a program this rule covers is held: in a box with no way out to the internet, in
     * a box, or with no box. Left out, the tool does exactly what it did before rules could say.
     */
    sandbox: z.enum(sandboxChoices).optional(),
    /**
     * Where a program this rule covers actually runs: on this computer, in a container, on the
     * Linux side, or in Windows' own throwaway desktop (see src/sandbox-backends.ts). Left out it
     * runs on this computer, which is what everything did before rules could say otherwise.
     */
    backend: z.enum(sandboxBackends).optional(),
    /**
     * The folders of the workspace a program this rule covers may see. Empty means the whole
     * workspace, which is what every rule written before this behaves as.
     */
    paths: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
    /**
     * Redesign ("Always allow for <Trunk>"): the one Trunk this yes is for. An allow with it covers only work that Trunk
     * is doing; a refusal or an "ask first" with it still holds for everyone. Left out, the rule covers every Trunk and
     * the owner's own conversations, as every rule written before this does.
     */
    trunk: z.string().min(1).max(100).optional(),
  })
  .strict();
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyLimitsSchema = z
  .object({
    /** Most tool calls one conversation may make in a minute; 0 means no limit. */
    toolCallsPerMinute: z.number().int().min(0).max(1000).default(0),
    /** Most times one conversation may go back to the model in a minute; 0 means no limit. */
    modelRoundsPerMinute: z.number().int().min(0).max(1000).default(0),
  })
  .strict();
export type PolicyLimits = z.infer<typeof PolicyLimitsSchema>;

/**
 * Most rules one policy may hold. It is well above the number of tools this app has, because
 * deciding a whole kind of thing at once (see src/tool-categories.ts) writes one rule per tool; with
 * the features that ship on, a fresh install registers over 300 tools, so 300 would drop some.
 */
export const maximumPolicyRules = 500;
export const PolicyPresetSchema = z.enum(["off", "ask-before-changes", "workspace", "read-only", "careful", "custom"]);
export type PolicyPresetName = z.infer<typeof PolicyPresetSchema>;
export const PolicySchema = z
  .object({
    preset: PolicyPresetSchema.default("off"),
    rules: z.array(PolicyRuleSchema).max(maximumPolicyRules).default([]),
    limits: PolicyLimitsSchema.prefault({}),
    /**
     * A command on this computer that no rule says anything about: let it through the way everything else that nothing
     * matches is let through, or ask first. Owner ruling (2026-09-30): it ships as "allow", as OpenClaw's host exec
     * (`tools.exec.mode` defaults to full) and Hermes Agent's terminal (only its dangerous-command list asks) do for their
     * owner. The dangerous commands still ask (src/safety-extras/dangerous-commands.ts), and a task that is not the
     * owner's own (a household person's, a short-lived key's) is held to "ask" whatever this says (src/runtime.ts).
     */
    unmatchedCommands: z.enum(["ask", "allow"]).default("allow"),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;
export const PolicyInputSchema = z
  .object({
    preset: PolicyPresetSchema.optional(),
    rules: z.array(PolicyRuleSchema).max(maximumPolicyRules).optional(),
    limits: optionalFields(PolicyLimitsSchema).optional(),
    unmatchedCommands: z.enum(["ask", "allow"]).optional(),
  })
  .strict();

/**
 * Where a task came from. Anything but the owner's own app or command line is held to the "Ask before changes" preset.
 * "channel" is a message from a chat app (Telegram, Discord, ...): a chat cannot prove who is typing, so it is never the owner.
 */
export type RunSource = "owner" | "trigger" | "schedule" | "mcp" | "a2a" | "acp" | "channel";

interface PresetDefinition { label: string; description: string; rules: z.input<typeof PolicyRuleSchema>[] }
const presetDefinitions: Record<Exclude<PolicyPresetName, "custom">, PresetDefinition> = {
  off: {
    label: "No approvals",
    description: "Tasks you start yourself get on with it; anything started from outside — a trigger, a chat app, another program — still asks before it changes anything.",
    rules: [],
  },
  "ask-before-changes": {
    label: "Ask before changes",
    description: "Reading is free. Anything that changes a file, runs a command or acts on a web page waits for your yes.",
    rules: [{ tool: "*", applies: "changes", decision: "ask", remember: "session" }],
  },
  workspace: {
    label: "Just do it inside my workspace",
    description: "Writing files in your workspace is fine. Running commands and clicking or typing on web pages wait for your yes, and a new website is checked with you once.",
    rules: [
      { tool: "shell.execute", decision: "ask", remember: "session" },
      // A command line kept open is still a command line: every command sent to it asks, exactly
      // as a one-off command does, rather than one yes at the moment it was opened covering the lot.
      { tool: "shell.session.*", decision: "ask", remember: "session" },
      // Batch 26 (wave 8): a program on somebody else's computer always asks, whatever the rule
      // for commands here says. It is a different computer.
      { tool: "remote.run", decision: "ask", remember: "session" },
      { tool: "browser.click", decision: "ask", remember: "session" },
      { tool: "browser.fill", decision: "ask", remember: "session" },
      // Sending one of your own files to a website is always worth a question, whatever site it is.
      { tool: "browser.upload", decision: "ask", remember: "session" },
      { tool: "browser.navigate", decision: "ask", remember: "always" },
      { tool: "web.*", decision: "ask", remember: "always" },
      // Q59 migration: the Auto mode adds a question for every outbound tool the registry holds
      // (src/tool-reach.ts, `policyForMode`), which a preset cannot list because tools come and go.
      // The lines above are what an owner saved when they picked this preset, and saved lines are
      // never rewritten: a conversation that follows the owner's setting keeps exactly these, so
      // there an outbound tool not named here (x.search, gmail.search, remote.read, ...) does not ask.
    ],
  },
  // Q235 (Mac mini's review): what the whole-app Careful preset picks. Every change asks, as Ask before changes does,
  // and looking things up or opening a website is checked with the owner once per site, as the workspace preset does,
  // so moving to it from either loosens nothing. Ask before changes itself stays the cap for work from outside.
  // NAS's adversarial (6512883): it is saved as "custom" with these lines, never by its own name (`writePolicy`).
  careful: {
    label: "Careful",
    description: "Anything that changes a file, runs a command, sends a message or acts on a web page waits for your yes, and looking something up on a new website is checked with you once.",
    rules: [
      { tool: "*", applies: "changes", decision: "ask", remember: "session" },
      { tool: "shell.execute", decision: "ask", remember: "session" },
      { tool: "shell.session.*", decision: "ask", remember: "session" },
      { tool: "remote.run", decision: "ask", remember: "session" },
      { tool: "browser.click", decision: "ask", remember: "session" },
      { tool: "browser.fill", decision: "ask", remember: "session" },
      { tool: "browser.upload", decision: "ask", remember: "session" },
      { tool: "browser.navigate", decision: "ask", remember: "always" },
      { tool: "web.*", decision: "ask", remember: "always" },
    ],
  },
  "read-only": {
    label: "Read only",
    description: "Branch Agent may look at things and answer, but may not change a file, run a command or act on a web page.",
    rules: [{ tool: "*", applies: "changes", decision: "deny" }],
  },
};

/** The rules a named preset expands to; the owner can edit them afterwards. */
export function presetRules(preset: PolicyPresetName): PolicyRule[] {
  if (preset === "custom") return [];
  return presetDefinitions[preset].rules.map((rule) => PolicyRuleSchema.parse(rule));
}
/** One rule as the saved list holds it, so two rules can be told the same however they were written. */
const ruleKey = (rule: PolicyRule): string => JSON.stringify(PolicyRuleSchema.parse(rule));
/** Every line a named preset writes, to tell them from the rules that are the owner's own. */
const presetLineKeys = new Set((Object.keys(presetDefinitions) as Exclude<PolicyPresetName, "custom">[]).flatMap((name) => presetRules(name).map(ruleKey)));

/**
 * Whether a rule stays when the owner moves to another preset. A preset replaces its own lines, never
 * the owner's: every refusal the owner has, a standing "deny, always" or one they wrote themselves, stays.
 * A line some preset writes is that preset's, so Read only's refusal of every change goes with Read only,
 * even from a hand-made list that holds a copy of it. A standing yes ends with the move, so a stricter
 * preset never goes on letting through what the owner once allowed under a looser one.
 */
export function keptThroughPresetMove(rule: PolicyRule): boolean {
  return rule.decision === "deny" && !presetLineKeys.has(ruleKey(rule));
}

/**
 * The rules a move to `preset` saves: the owner's kept refusals first, in their own order, then the
 * preset's own lines. Saving and weighing a move both use this, so what is weighed is what is saved.
 * Nothing is cut to fit: a move that would take the list past the most a policy holds is refused in
 * plain words, and the owner's refusals and the preset's lines all stay as they are.
 */
export function presetMoved(current: Policy, preset: PolicyPresetName): PolicyRule[] {
  const kept = current.rules.filter(keptThroughPresetMove);
  const lines = presetRules(preset);
  if (kept.length + lines.length > maximumPolicyRules)
    throw new Error(`This preset's ${lines.length} rules and the ${kept.length} refusals of your own it keeps come to more than the ${maximumPolicyRules} rules a policy holds. Remove some of your own rules, then choose it again.`);
  return [...kept, ...lines];
}
/** Every preset the owner can pick, with plain-language labels for the settings screen. */
export function policyPresets(): { id: PolicyPresetName; label: string; description: string; rules: PolicyRule[] }[] {
  return (Object.keys(presetDefinitions) as Exclude<PolicyPresetName, "custom">[]).map((id) => ({
    id,
    label: presetDefinitions[id].label,
    description: presetDefinitions[id].description,
    rules: presetRules(id),
  }));
}

/**
 * Permissions whose tools only look at things. Anything not listed here counts as a change, so a
 * tool added later (an MCP server's, for example) is treated as able to change something.
 */
const readOnlyPermissions = new Set([
  "files.read", "memory.read", "history.read", "skills.read",
  // Q59: a repository's status, changes, log and parallel copies, and the read-only review helpers.
  "git.read",
  "documents.read", "web.read", "browser.read", "schedules.read", "user.ask",
  // Looking at a picture or a sound file the person already has changes nothing.
  "media.read",
  // Figures held only for this task, reports already written, watches, and the brief: all look-only.
  "data.read", "research.read", "monitors.read", "brief.read",
  // The shared scratch area is the task's own notepad: reading it touches nothing outside the task.
  "scratch.read",
  // Saying what a call would do, and how the connections to other AI tools are faring, changes
  // nothing at all: nothing is run and nothing is written.
  "mcp.read",
  // Listing Branch's own settings and what each is set to changes nothing (src/settings-kit/tools.ts).
  "settings.read",
  // Reading Branch's own handbook to answer a question about Branch (src/help-search.ts).
  "help.read",
  // Reading back forecasts and their scores changes nothing (src/asks/forecasts.ts).
  "forecasts.read",
  // The prospect list read back as CSV changes nothing (src/asks/leads.ts).
  "leads.read",
  // Looking at what a program left running has printed changes nothing; starting or stopping one does.
  "process.read",
  // Reading GitLab (issues, merge requests, releases, how the checks went) changes nothing; `gitlab.manage` does.
  "gitlab.read",
  // A check-in writing down its own answer (src/heartbeat.ts); the news goes out afterwards, by Branch.
  "heartbeat.respond",
  // mac6/bucket-23: a project's board, which intent a request is, the sources' cursors, the list of
  // app steps and whether other Branch computers are up only look (src/asks/).
  "projects.read", "intents.read", "sources.read", "blocks.read", "nodes.read",
  // mac7/nodes: which of the owner's devices are paired and connected only looks (src/devices/).
  "devices.read",
  // R17-C: reading the owner's own mail, calendar, files, music and house only looks (src/personal/).
  "personal.read",
  // r17-h: the shared board's cards, the widgets' list and the install requests only look (src/flows-boards/).
  "boards.read", "widgets.read", "installs.read",
]);
export const isReadOnlyPermission = (permission: string): boolean => readOnlyPermissions.has(permission);
/** Reads that reach past this computer or into the owner's other conversations: never given by a file (src/trunks/share.ts) or a restore. */
export const notFromAFile = new Set(["web.read", "browser.read", "research.read", "history.read"]);
/** Every permission that only looks, as a list (a restored Trunk is cut down to these, src/trunks/restored.ts). */
export const readOnlyPermissionList = (): string[] => [...readOnlyPermissions];

/** What a call would touch, in the form rules match against: a path, a command, or a host. */
export function policyTarget(tool: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (tool === "shell.execute")
    return [a.executable, ...(Array.isArray(a.args) ? a.args : [])].map((v) => String(v ?? "")).join(" ").trim().slice(0, 300);
  // Wave mac3 (tool-safety): a command sent to a command line kept open is that command, and opening
  // one is the program it opens, exactly as the tools themselves report it (src/shell-session.ts).
  if (tool === "shell.session.run" && typeof a.input === "string") return a.input.slice(0, 300);
  if (tool === "shell.session.open" && typeof a.program === "string")
    return [a.program, ...(Array.isArray(a.args) ? a.args : [])].map((v) => String(v ?? "")).join(" ").trim().slice(0, 300);
  if (typeof a.url === "string") {
    try { return new URL(a.url).host; } catch { return a.url.slice(0, 300); }
  }
  if (typeof a.path === "string") return a.path.slice(0, 300);
  return "";
}

export interface PolicyRequest {
  tool: string; target: string; readOnly: boolean;
  /** What the call is about, for rules that name a folder, a website, an account or a command. */
  resource?: PolicyResource | null | undefined;
  /**
   * mac7/multi-target: when one of several things a call touches is being judged, what the whole call
   * is known by ("2 files: a, b"). A rule's `match` fits either, so a standing answer the owner gave
   * for the whole call still counts for each thing in it.
   */
  callTarget?: string | undefined;
  /** Redesign: the Trunk doing the work, when a Trunk is; a rule for one Trunk covers only that Trunk's work. */
  trunk?: string | undefined;
}
export interface PolicyOutcome { decision: PolicyDecision; rule: PolicyRule | null }
/** Whether one rule covers this call: the tool, what it would touch, and the thing it is about. */
function ruleCovers(rule: PolicyRule, request: PolicyRequest): boolean {
  // Mac mini's review of #285: a Trunk only ever narrows a yes. A refusal or an "ask first" that names a Trunk holds for
  // everyone, so a path that judges a call without knowing its Trunk can never skip one.
  if (rule.trunk !== undefined && rule.decision === "allow" && rule.trunk !== request.trunk) return false;
  if (rule.applies === "changes" && request.readOnly) return false;
  if (rule.applies === "reads" && !request.readOnly) return false;
  if (!globMatches(rule.tool, request.tool)) return false;
  if (!matchesTarget(rule.match, request) && !namesWholeCall(rule, request)) return false;
  if (!rule.resource && rule.decision === "allow" && rule.match !== "*" && !commandTargetTrusted(request)) return false;
  return rule.resource ? resourceMatches(rule.resource, request.resource, rule.decision) : true;
}
/**
 * A rule's `match` against what the call would touch. mac7/residuals: when that is a file, both sides
 * are path-tidied first (hardening-3's `tidyPath`), so an older rule "finance/*" holds for
 * "././finance/q1.txt" and "finance\q1.txt" as well, and for the file inside the active project folder.
 */
function matchesTarget(match: string, request: PolicyRequest): boolean {
  if (globMatches(match, request.target)) return true;
  const resource = request.resource;
  if (match === "*" || resource?.kind !== "path") return false;
  const rule = tidyPath(match);
  return [request.target, resource.inWorkspace].some((path) => path !== undefined && globMatches(rule, tidyPath(path)));
}
/**
 * mac7/multi-target: a standing answer given for the whole call ("2 files: a, b") counts for each
 * thing in it. Integration: only when it names that exact call — a `*` in it is a star here, not
 * "anything", so an "Always" for "2 files: a, *" (a file really called `*`) or an owner's "*src*" never
 * covers a file of another call that the answer's words happen to fit.
 */
const namesWholeCall = (rule: PolicyRule, request: PolicyRequest): boolean =>
  request.callTarget !== undefined && !rule.match.includes("*") && globMatches(rule.match, request.callTarget);
/**
 * Integration review (mac3/tool-safety): an allow that names a command only through its target — a
 * remembered command from before, or "npm *" — covers a command only when the target is the whole
 * command and a plain list of words. A `*` in it never stands for `; rm -rf ~`, and a command cut
 * at 300 characters is never let through by its harmless start.
 */
function commandTargetTrusted(request: PolicyRequest): boolean {
  const resource = request.resource;
  if (resource?.kind !== "command") return true;
  return !resource.cut && plainWords(resource.value) !== null;
}
/**
 * The first rule that matches decides, and rules that name a particular folder, website, account or
 * command are looked at before the broader ones, so "never under finance" beats "files are fine".
 * Within each of those two groups the owner's own order is kept, so an older rule list is unchanged.
 */
export function evaluatePolicy(policy: Policy, request: PolicyRequest): PolicyOutcome {
  const named = policy.rules.filter((rule) => rule.resource);
  const broad = policy.rules.filter((rule) => !rule.resource);
  for (const rule of [...named, ...broad]) if (ruleCovers(rule, request)) return { decision: rule.decision, rule };
  return unmatched(policy, request);
}
/**
 * Nothing matched. Everywhere else that means "go ahead", which is how Branch Agent has always
 * behaved and still does. A command on this computer is the exception: it can do anything at all,
 * including things no tool of Branch's own offers, so a command nobody has decided about is put to
 * the person rather than run on a guess. Saying yes to it writes a standing rule for that command,
 * so it is one question the first time and nothing afterwards.
 */
function unmatched(policy: Policy, request: PolicyRequest): PolicyOutcome {
  // ---- mac7/nodes: a device taking a picture, a sound, a place, a file or running a command asks
  // unless a rule decided (src/devices/capabilities.ts). A yes is remembered for the conversation. ----
  if (asksUnlessRuled(request.tool))
    return { decision: "ask", rule: { tool: request.tool, match: request.target || "*", applies: "any", decision: "ask",
      remember: asksEveryTime(request.tool) ? "never" : "session" } };
  // ---- end mac7/nodes ----
  // FQ-execution.desktop: shared desktop control tools ask by default (desktop.shared.*).
  if (asksUnlessRuledDefault(request.tool))
    return { decision: "ask", rule: { tool: request.tool, match: request.target || "*", applies: "any", decision: "ask", remember: "session" } };
  // ---- end FQ-execution.desktop ----
  // mac7/residuals: `listed` is a program the owner put on their own list (only process.start says so, through
  // its `command` hook); a new tool declaring `command` gets this exemption too, so it must mean the same.
  if (request.resource?.kind !== "command" || request.resource.listed || policy.unmatchedCommands === "allow")
    return { decision: "allow", rule: null };
  return {
    decision: "ask",
    rule: { tool: request.tool, match: request.target || "*", applies: "any", decision: "ask", remember: "always" },
  };
}

/**
 * Tasks the owner did not start themselves (a trigger, a schedule, a chat app, another AI tool over
 * MCP, A2A or ACP) never get more freedom than "Ask before changes": standing yeses do not apply to
 * them. That holds under "No approvals" too (0.18.1): the default setting frees the owner's own
 * tasks, never something started from outside. A schedule counts as outside even when the owner
 * made it — nobody is there when it runs — so its change waits in the owner's window.
 */
export function cappedPolicy(policy: Policy, source: RunSource): Policy {
  if (source === "owner") return policy;
  return { ...policy, rules: [...policy.rules.filter((rule) => rule.decision !== "allow"), ...presetRules("ask-before-changes")] };
}

const policyKey = "policy";
/**
 * Owner ruling (2026-09-30): the one step that moves an install saved before commands shipped as "allow". Only a policy
 * on "No approvals" is moved, since every other preset asks before commands through its own lines anyway and an owner
 * who picked one chose care. A note records that it ran, so a later choice of "ask" is never undone.
 */
export const commandsDefaultMigrationKey = "policy-commands-allow-migration";
export function migrateUnmatchedCommands(store: Store, owner: string): boolean {
  if (store.get("settings", owner, commandsDefaultMigrationKey)) return false;
  store.save("settings", owner, commandsDefaultMigrationKey, { ranAt: new Date().toISOString() });
  const saved = store.get("settings", owner, policyKey)?.data as { preset?: unknown; unmatchedCommands?: unknown } | undefined;
  if (!saved || saved.unmatchedCommands !== "ask" || (saved.preset ?? "off") !== "off") return false;
  store.save("settings", owner, policyKey, { ...saved, unmatchedCommands: "allow" });
  audit(store, owner, { action: "policy.changed", actor: "branch", subject: "A command no rule mentions: allow",
    reason: "Commands now run without asking under No approvals, as in Hermes Agent and OpenClaw; dangerous commands still ask", outcome: "saved" });
  return true;
}
/**
 * NAS's adversarial of Q235 (6512883): an older build reads the saved policy with its own list of preset names and
 * falls back to no rules at all when a name is new to it, so a rollback would have dropped every rule under Careful.
 * Careful is therefore saved as "custom" with its own lines, which every build reads, and read back as Careful from
 * those lines: a custom list holding every line of Careful and no other preset's is Careful, however it was made.
 * NAS's adversarial (af0a751): only when everything else in it is a refusal of the owner's, as a move to Careful
 * leaves it. A yes (or an "ask") of the owner's own makes it their own list, as a rules edit does for every preset,
 * so picking Careful again is a real move that drops the yes, never a no-op that leaves it letting things through.
 */
const carefulKeys = new Set(presetRules("careful").map(ruleKey));
function named(policy: Policy): Policy {
  if (policy.preset !== "custom") return policy;
  const lines = new Set(policy.rules.map(ruleKey).filter((key) => presetLineKeys.has(key)));
  const careful = lines.size === carefulKeys.size && [...carefulKeys].every((key) => lines.has(key))
    && policy.rules.every((rule) => presetLineKeys.has(ruleKey(rule)) || rule.decision === "deny");
  return careful ? { ...policy, preset: "careful" } : policy;
}
/** Every save of the policy goes through here, so no build is ever handed a preset name it may not know. */
function writePolicy(store: Store, owner: string, policy: Policy): void {
  store.save("settings", owner, policyKey, policy.preset === "careful" ? { ...policy, preset: "custom" } : policy);
}
/** The owner's saved policy, or the empty default when nothing is saved or the saved value is unreadable. */
export function readPolicy(store: Store, owner: string): Policy {
  const saved = PolicySchema.safeParse(store.get("settings", owner, policyKey)?.data ?? {});
  return saved.success ? named(saved.data) : PolicySchema.parse({});
}
/**
 * Saves a preset, a hand-edited rule list, or new limits; anything left out keeps its current value.
 * A preset on its own keeps the owner's refusals in front of its lines (`presetMoved`).
 */
/** Q257: the policy a save of `input` would leave, worked out without saving, so a change can be weighed first. */
export function nextPolicy(current: Policy, input: unknown): Policy {
  const value = PolicyInputSchema.parse(input ?? {});
  return {
    preset: value.preset ?? (value.rules ? "custom" : current.preset),
    rules: value.rules ?? (value.preset ? presetMoved(current, value.preset) : current.rules),
    limits: PolicyLimitsSchema.parse({ ...current.limits, ...value.limits }),
    unmatchedCommands: value.unmatchedCommands ?? current.unmatchedCommands,
  };
}
export function savePolicy(store: Store, owner: string, input: unknown, reason = "The approval settings were saved"): Policy {
  const next = nextPolicy(readPolicy(store, owner), input);
  writePolicy(store, owner, next);
  audit(store, owner, { action: "policy.changed", actor: owner, subject: `${next.preset}, ${next.rules.length} rules`, reason, outcome: "saved" });
  return next;
}
/**
 * Wave mac3 (tool-safety): a standing answer about a command covers that one action of the program
 * — "git status" with any flags, but not "git push" — rather than only the exact words it was given
 * for. A command that cannot be narrowed safely (see src/command-prefix.ts) is kept word for word,
 * and a program on another computer stays tied to that computer.
 */
export function standingRule(rule: PolicyRule): PolicyRule {
  const remote = rule.tool === "remote.run";
  if (rule.resource || rule.match === "*" || !(remote || isCommandTool(rule.tool))) return rule;
  const at = remote ? rule.match.indexOf(": ") : 0;
  if (at < 0) return rule;
  const command = remote ? rule.match.slice(at + 2) : rule.match;
  const match = remote ? `${rule.match.slice(0, at)}: *` : "*";
  // Integration review: a `*` in a remembered command is a star, not "anything" — `rm -rf *` must
  // never cover `rm -rf /` — so such a command is kept as an exact rule.
  const prefix = rule.match.includes("*") ? null : commandPrefix(command);
  if (prefix) return { ...rule, match, resource: { kind: "command", pattern: prefix } };
  if (!rule.match.includes("*")) return rule;
  return { ...rule, match, resource: { kind: "command", pattern: exactCommandPattern(command), exact: true } };
}
const carefulness: Record<PolicyDecision, number> = { allow: 0, ask: 1, deny: 2 };
/**
 * At the most rules a policy holds, the oldest rule of the owner's own makes room for the newest
 * answer, in front: never a line of the preset, and never the answer just given. Q212, Q215: the least
 * careful kind goes first (a yes, then a question, then a refusal), and never one more careful than the
 * new answer, so a standing yes never pushes out one of the owner's refusals or "ask first" rules. When
 * nothing may make room the answer is not kept (null).
 */
function withRoom(rules: PolicyRule[], preset: PolicyPresetName): { rules: PolicyRule[]; dropped: PolicyRule | undefined } | null {
  if (rules.length <= maximumPolicyRules) return { rules, dropped: undefined };
  const lines = new Set(presetRules(preset).map(ruleKey));
  const own = (rule: PolicyRule, at: number): boolean => at > 0 && !lines.has(ruleKey(rule));
  for (const decision of ["allow", "ask", "deny"] as const) {
    if (carefulness[decision] > carefulness[rules[0]!.decision]) break;
    const oldest = rules.findLastIndex((rule, at) => own(rule, at) && rule.decision === decision);
    if (oldest >= 0) return { rules: rules.filter((_rule, at) => at !== oldest), dropped: rules[oldest] };
  }
  return null;
}
/** Q215: the words for a standing answer that was not kept because the rules are full. */
export const policyFullNote = `Your approval rules are full (${maximumPolicyRules}), so this answer was not kept as a standing rule. It holds for this conversation. Remove some rules under "When to check with me" in Settings to keep more.`;
/** Records a standing answer as a rule in front of the others, so it beats the broader ones. */
export function addPolicyRule(store: Store, owner: string, rule: z.input<typeof PolicyRuleSchema>): Policy {
  return keepPolicyRule(store, owner, rule).policy;
}
/** The same, saying whether the rule was kept (Q215): a full list keeps it only when a less careful rule makes room. */
export function keepPolicyRule(store: Store, owner: string, rule: z.input<typeof PolicyRuleSchema>): { policy: Policy; kept: boolean } {
  const current = readPolicy(store, owner);
  const added = standingRule(PolicyRuleSchema.parse(rule));
  const room = withRoom([added, ...current.rules], current.preset);
  const subject = `${added.tool} on ${added.match}`;
  if (!room) {
    // Q212: the answer still counts for the question it was given to; it is only not remembered.
    audit(store, owner, {
      action: "policy.changed", actor: owner, subject, outcome: "not kept",
      reason: `A standing "${added.decision}" was not remembered: the approval rules are full (${maximumPolicyRules}), and making room would drop one of your refusals or "ask first" rules. Remove some rules to keep more answers.`,
    });
    return { policy: current, kept: false };
  }
  const next: Policy = { ...current, rules: room.rules };
  writePolicy(store, owner, next);
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject,
    reason: `A standing "${added.decision}" was remembered from a question you answered`
      + (added.resource ? `, for the command ${added.resource.pattern}` : "")
      + (room.dropped ? `. The rules were full, so your oldest rule (${room.dropped.decision} ${room.dropped.tool} on ${room.dropped.match}) made room` : ""),
    outcome: "saved",
  });
  return { policy: next, kept: true };
}
