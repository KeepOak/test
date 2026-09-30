import type { PreloadedTool } from "./tool-loading.js";

/** Routes into existing, permission-filtered tools; these hints never register or grant a tool. */
const routes = [
  { words: /\b(settings?|configur\w*|preferences?)\b/i,
    tools: ["settings.find", "settings.list", "settings.change", "settings.why", "settings.undo"],
    help: "When changing Branch's own runtime settings, use the settings tools rather than source code. A request to fix an application's settings code still needs the requested code change. Read current values, apply the requested change, and read back the result; use undo if verification fails." },
  { words: /\b(skills?|learn\w*|remember\w*)\b/i,
    tools: ["skills.list", "skills.read", "skills.sync", "skills.readiness", "memory.search", "memory.put"],
    help: "Inspect existing skills and memory first. Save reusable instructions through the available skill workflow, check readiness and test the procedure. Keep only verified lessons with their evidence; an installed or drafted skill is not necessarily enabled." },
  { words: /\b(install\w*|download\w*|plugins?|extensions?|dependencies|mcp|capabilit\w*)\b/i,
    tools: ["code.run", "shell.execute", "mcp.servers", "mcp.dry_run", "tools.from_openapi", "addon.draft"],
    help: "Inspect the environment and existing integrations, then use the permitted installation or extension workflow. Check compatibility and verify the resulting tool. Distinguish a draft, an installation and an enabled working capability." },
  { words: /\b(self[- ]?(?:improv\w*|modif\w*|develop\w*)|your(?:self| own)|branch agent|source code)\b/i,
    tools: ["branch.prepare_source_change", "branch.widen_source_contract", "branch.finish_source_change", "branch.restart_engine"],
    help: "For changes to Branch's source, use its isolated source-change workflow: define success and rollback, implement, test and review the exact change, then finish through its checked integration path. Do not edit the running installation. A merge is not proof that the installed app updated." },
] as const;

export function adaptiveTools(prompt: string, available: readonly string[]): PreloadedTool[] {
  const names = new Set(available), selected = new Set<string>();
  for (const route of routes) if (route.words.test(prompt))
    for (const name of route.tools) if (names.has(name)) selected.add(name);
  return [...selected].map(name => ({ name, reason: "Matches the requested capability change" }));
}

export function adaptiveInstructions(prompt: string, available: readonly string[]): string {
  const names = new Set(available);
  const relevant = routes.filter(route => route.words.test(prompt) && route.tools.some(name => names.has(name)));
  if (!relevant.length) return "";
  return "\n" + relevant.map(route => route.help).join(" ")
    + " Plan, act, inspect results and repair failures within the task's limits. Search tools before claiming a capability is missing."
    + " Use the existing authorization; do not invent extra approvals or bypass a refusal, disabled feature, credential boundary or source contract."
    + " Report what was verified and the concrete blocker for anything unfinished.\n";
}

/** Only unevidenced first-person claims of missing ability, never a policy or consent refusal. */
export function uncheckedCapabilityClaim(answer: string): boolean {
  if (/\b(permission|approval|authoriz\w*|policy|lockdown|consent|credential\w*|not allowed|not permitted|unsafe|harmful)\b/i.test(answer)) return false;
  return /\b(?:I|we)\s+(?:(?:can(?:not|['’]t)|am unable to|are unable to)\s+(?:directly\s+)?(?:read|write|edit|change|modify|install|download|run|execute|create|use|access|learn|improve|add|configure)\b|(?:do not|don['’]t) have (?:the |any )?(?:tools?|ability|capability|access)\b)/i.test(answer);
}

/** A conservative action gate: a quotation, explanation or writing exercise is already a valid answer. */
export function capabilityActionRequested(prompt: string): boolean {
  if (/["“”«»]/.test(prompt) || /\b(translate|rephrase|quote|repeat|explain|summari[sz]e|poem|story|dialogue|fiction|example|sentence|paragraph|wording)\b/i.test(prompt)) return false;
  return /^\s*(?:(?:please|now|go and|can you|could you|would you|I want you to)\s+)*(?:read|edit|change|modify|install|download|run|execute|access|learn|improve|add|configure|fix|update)\b/i.test(prompt);
}

export const capabilityDiscoveryNudge = "Before concluding that you lack a capability, check this task's tools with tools.search or tools.describe. "
  + "Then do the authorized work if supported, or explain the specific missing tool or restriction shown by the result. "
  + "Do not bypass permissions, approvals, disabled features or safety restrictions.";
export const capabilityDiscoveryFailure = "The assistant repeated a capability refusal without checking its available tools. The requested work is unfinished.";
