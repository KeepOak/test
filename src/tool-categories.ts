import { z } from "zod";
import type { ToolRegistry } from "./registry.js";
import { PolicyDecisionSchema, isReadOnlyPermission, maximumPolicyRules, type PolicyDecision, type PolicyRule } from "./policy.js";

/**
 * Grouping the tools so the owner decides once per kind of thing rather than once per tool. There
 * are seven kinds — looking things up, changing files, running commands, using a web page, messaging
 * people, spending money and changing settings — and each tool falls into one of them, worked out
 * from the permission it needs. A short override list moves the handful of tools whose permission
 * does not say enough, so a tool that sends a message is never filed under "using a web page".
 */
export const toolCategories = ["read", "files", "commands", "browse", "message", "spend", "settings"] as const;
export type ToolCategory = (typeof toolCategories)[number];

export const categoryLabels: Record<ToolCategory, { label: string; description: string }> = {
  read: { label: "Look things up", description: "Reading files, searching your notes and looking at web pages without changing anything." },
  files: { label: "Change files", description: "Writing, editing and deleting files, and saving versions of your work." },
  commands: { label: "Run commands", description: "Running programs on this computer, including anything a skill or plugin asks it to run." },
  browse: { label: "Use a web page", description: "Clicking, typing and uploading on a real web page in the browser." },
  message: { label: "Message people", description: "Sending messages, emails and chat replies on your behalf." },
  spend: { label: "Spend money", description: "Anything that can cost you money, such as buying or paying for something." },
  settings: { label: "Change settings", description: "Changing how Branch Agent itself is set up: schedules, connections and saved secrets." },
};

/** Permissions whose tools clearly belong to one kind; anything unlisted falls back to the rules below. */
const permissionCategories: Record<string, ToolCategory> = {
  "files.write": "files", "code.edit": "files", "history.write": "files",
  "git.write": "files", "git.remote": "files", "patch.write": "files",
  "workbooks.write": "files", // P17-D §3: a learning task saving the workbook it wrote
  "shell.execute": "commands", "terminal.write": "commands", "remote.execute": "commands",
  "browser.write": "browse", "browser.act": "browse",
  "channels.send": "message", "email.send": "message", "github.manage": "message",
  "issues.write": "message",
  "payments.spend": "spend", "billing.write": "spend",
  "schedules.write": "settings", "secrets.write": "settings", "settings.write": "settings",
  "mcp.manage": "settings", "plugins.manage": "settings", "skills.write": "settings",
};
/** The few tools whose permission does not say enough on its own. */
const toolOverrides: Record<string, ToolCategory> = {
  "browser.navigate": "browse", "browser.click": "browse", "browser.fill": "browse", "browser.upload": "browse",
  "github.open_pull_request": "message", "github.create_issue": "message", "issues.comment": "message",
  "channels.notify": "message", "user.ask": "read",
};

/** Which kind one tool belongs to, from its name first and its permission after. */
export function categoryOf(tool: string, permission: string): ToolCategory {
  const override = toolOverrides[tool];
  if (override) return override;
  const known = permissionCategories[permission];
  if (known) return known;
  if (isReadOnlyPermission(permission)) return "read";
  if (permission.startsWith("browser.")) return "browse";
  if (permission.startsWith("files.") || permission.startsWith("git.") || permission.startsWith("code.")) return "files";
  if (permission.startsWith("shell.") || permission.startsWith("terminal.")) return "commands";
  if (permission.startsWith("channels.") || permission.startsWith("email.")) return "message";
  // A tool nobody anticipated can change something, so it goes with the settings rather than reading.
  return "settings";
}

export const CategoryDecisionsSchema = z.object(
  Object.fromEntries(toolCategories.map((id) => [id, PolicyDecisionSchema.optional()])) as
    Record<ToolCategory, z.ZodOptional<typeof PolicyDecisionSchema>>,
).strict();
export type CategoryDecisions = Partial<Record<ToolCategory, PolicyDecision>>;

export interface CategoryView {
  id: ToolCategory; label: string; description: string;
  tools: { name: string; permission: string }[];
  /** The decision every tool in this kind currently shares, or null when they differ. */
  decision: PolicyDecision | null;
}

/** Every tool sorted into its kind, for the approval settings screen. */
export function categorise(registry: ToolRegistry): Map<ToolCategory, { name: string; permission: string }[]> {
  const grouped = new Map<ToolCategory, { name: string; permission: string }[]>(
    toolCategories.map((id) => [id, [] as { name: string; permission: string }[]]));
  for (const tool of registry.inventory())
    grouped.get(categoryOf(tool.name, tool.permission))!.push({ name: tool.name, permission: tool.permission });
  for (const list of grouped.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return grouped;
}

/** The rules a set of per-kind decisions expands to: one rule per tool, in category order. */
export function rulesForDecisions(registry: ToolRegistry, input: unknown): PolicyRule[] {
  const decisions = CategoryDecisionsSchema.parse(input ?? {}) as CategoryDecisions;
  const grouped = categorise(registry);
  const rules: PolicyRule[] = [];
  for (const id of toolCategories) {
    const decision = decisions[id];
    if (!decision) continue;
    for (const tool of grouped.get(id) ?? [])
      rules.push({ tool: tool.name, match: "*", applies: "any", decision, remember: "session" });
  }
  return rules.slice(0, maximumPolicyRules);
}

/**
 * A rule this mechanism wrote: one named tool, whatever it would touch, whether or not it changes
 * something. A rule the owner wrote by hand, and a standing yes remembered for one web address,
 * both look different, and neither is ever replaced by a choice made here.
 */
const isCategoryRule = (rule: PolicyRule): boolean =>
  !rule.tool.includes("*") && rule.match === "*" && rule.applies === "any";

/**
 * The saved rules with one or more kinds decided again. Only the rules this mechanism itself wrote
 * for the kinds named in this request are replaced: another kind decided earlier stays, and so does
 * every hand-edited rule and every standing yes remembered from a question the owner answered.
 * The new rules go after those, so a narrower rule the owner set deliberately still wins.
 */
export function mergeCategoryRules(registry: ToolRegistry, current: readonly PolicyRule[], input: unknown): PolicyRule[] {
  const decisions = CategoryDecisionsSchema.parse(input ?? {}) as CategoryDecisions;
  const grouped = categorise(registry);
  const replaced = new Set<string>();
  for (const id of toolCategories)
    if (decisions[id]) for (const tool of grouped.get(id) ?? []) replaced.add(tool.name);
  const kept = current.filter((rule) => !(isCategoryRule(rule) && replaced.has(rule.tool)));
  return [...kept, ...rulesForDecisions(registry, input)].slice(0, maximumPolicyRules);
}

/** What the saved rules say each kind is set to now; null when the tools inside it disagree. */
export function decisionsFromRules(registry: ToolRegistry, rules: readonly PolicyRule[]): CategoryView[] {
  const grouped = categorise(registry);
  // Only the rules this mechanism writes are read back, so a narrower rule elsewhere is not
  // mistaken for a decision about a whole kind.
  const byTool = new Map(rules.filter(isCategoryRule).map((rule) => [rule.tool, rule.decision]));
  return toolCategories.map((id) => {
    const tools = grouped.get(id) ?? [];
    const decisions = new Set(tools.map((tool) => byTool.get(tool.name)));
    const only = decisions.size === 1 ? [...decisions][0] : undefined;
    return { id, ...categoryLabels[id], tools, decision: tools.length && only ? only : null };
  });
}
