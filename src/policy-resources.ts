import { z } from "zod";
import { sandboxSentences, type SandboxChoice } from "./sandbox.js";
import { commandCovers, exactCommandPattern } from "./command-prefix.js";

/**
 * What a rule is *about*, beyond the tool's name: a folder in the workspace, a website, a messaging
 * account, or a command. A rule without one of these means "whatever this tool would touch", which
 * is how every rule written before this existed still behaves.
 */
export const resourceKinds = ["path", "host", "channel", "command"] as const;
export type ResourceKind = (typeof resourceKinds)[number];

export const ResourceMatcherSchema = z
  .object({
    kind: z.enum(resourceKinds),
    /** A folder or file pattern, a website name, a messaging account, or a command name. `*` fits any text. */
    pattern: z.string().trim().min(1).max(300),
    /**
     * Integration review (mac3/tool-safety): the pattern is the whole command, and `*` in it is only
     * a star. Used for a remembered command that could not be narrowed to its action.
     */
    exact: z.boolean().optional(),
  })
  .strict();
export type ResourceMatcher = z.infer<typeof ResourceMatcherSchema>;

/** What a call is actually about, worked out from the tool and its arguments. */
export interface PolicyResource {
  kind: ResourceKind;
  value: string;
  /**
   * Integration review (mac3/tool-safety): the call's target was shortened, so a rule matched against
   * the target alone must not let it through (src/policy.ts).
   */
  cut?: boolean;
  /**
   * mac7/residuals: a command whose program the owner already put on their own list (`process.start`),
   * so no rule about it means "go ahead", as before, instead of the question an unknown command gets.
   */
  listed?: boolean;
  /**
   * Integration (hardening-3): the same path written from the workspace itself, when the call's
   * paths are read inside a folder of it (the active project's folder, or a task's working copy).
   * Folder rules are written about the workspace, so a path rule is weighed against both: "never
   * under finance" holds for "q1.txt" while the active project's folder is finance.
   */
  inWorkspace?: string;
}

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Pattern matching for rules: `*` stands for any text (a path separator included); everything else is literal. */
export function globMatches(pattern: string, value: string): boolean {
  // Integration review (mac3/tool-safety): `*` fits line breaks too. Without the "s" flag a rule
  // matching "*" skipped any target with a line break in it, so `true\ngit push` walked past a refusal.
  return new RegExp("^" + pattern.split("*").map(escaped).join(".*") + "$", "is").test(value);
}

/**
 * Paths are compared with forward slashes, without a leading or trailing slash, so Windows paths fit
 * too. Integration (hardening-3): and one name per folder: "." and empty steps are dropped and
 * "a/.." folds away, so "././finance/q1.txt" is the finance folder a rule names. Only one leading
 * "./" used to be taken off, and the rest read as a folder called ".", past "never under finance".
 */
function tidyPath(value: string): string {
  const kept: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
    else kept.push(part);
  }
  return kept.join("/");
}

/** A folder pattern covers everything inside it: "finance" fits "finance/2026/q1.xlsx". */
export function pathMatches(pattern: string, value: string): boolean {
  const rule = tidyPath(pattern), path = tidyPath(value);
  return globMatches(rule, path) || globMatches(rule + "/*", path);
}

/** A website rule covers the site itself and anything under it: "example.com" fits "shop.example.com". */
export function hostMatches(pattern: string, value: string): boolean {
  const rule = pattern.trim().toLowerCase().replace(/^\*\./, ""), host = value.trim().toLowerCase();
  if (pattern.includes("*")) return globMatches(pattern.toLowerCase(), host);
  return host === rule || host.endsWith("." + rule);
}

/** Tools whose target is a command line: a program on this computer, or one kept open. */
export const isCommandTool = (tool: string): boolean => tool === "shell.execute" || /^(shell|terminal)\./.test(tool);

/** The longest command a rule reads in full; anything longer is treated as cut. */
const longestCommand = 8000;
const joined = (program: unknown, rest: unknown): string =>
  [program, ...(Array.isArray(rest) ? rest : [])].map((v) => String(v ?? "")).join(" ").trim();
/** The whole command a command tool's arguments hold, or null when they do not say. */
function fullCommand(tool: string, a: Record<string, unknown>): string | null {
  if (tool === "shell.execute" && typeof a.executable === "string") return joined(a.executable, a.args);
  if (tool === "shell.session.run" && typeof a.input === "string") return a.input;
  if ((tool === "shell.session.open" || tool === "remote.run") && typeof a.program === "string") return joined(a.program, a.args);
  return null;
}
/** A command resource: the whole command when the arguments hold it, marked when the target was shorter. */
function commandResource(fromTarget: string, whole: string | null): PolicyResource {
  const shown = fromTarget.trim();
  // The arguments are read only when they are the target's own command, carried on past its end.
  const value = whole !== null && whole.trim().startsWith(shown) ? whole.trim() : shown;
  // A command this file cannot read whole from its arguments may have been cut at 300 characters.
  const cut = value.length > longestCommand || value !== shown || (whole === null && shown.length >= 300);
  return { kind: "command", value: value.slice(0, longestCommand), ...(cut ? { cut } : {}) };
}

/** Whether an argument is words to read: text, a number, or a list of those (addresses, say). An object is not. */
const inWords = (value: unknown): boolean =>
  typeof value !== "object" || (Array.isArray(value) && value.length > 0 && value.every((one) => typeof one !== "object"));
/**
 * The messaging account a call is about, or the address for mail. An argument that names it in words
 * is read as it always was, and with none the target is. A message to several chats names them as a
 * list of chats instead, which is never read as text: each chat is judged on its own
 * (src/policy-targets.ts), as "<account>:<chat id>". An account's id never holds a colon (a chat's
 * may), so the account is everything before the first one.
 */
function accountOf(a: Record<string, unknown>, target: string): string {
  const named = a.channel ?? a.to ?? a.chat ?? target;
  if (inWords(named)) return String(named);
  const colon = target.indexOf(":");
  return colon < 0 ? target : target.slice(0, colon);
}

/**
 * Which kind of thing a call is about. The tool's own name decides first, because a browser click
 * is about a website whatever its arguments look like; the arguments decide after that.
 */
/** A bare host name and nothing else: no slash, no space, at least one dot or "localhost". */
const looksLikeHost = (value: string): boolean =>
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value) || value.toLowerCase() === "localhost";

export function resourceOf(tool: string, permission: string, target: string, args: unknown): PolicyResource | null {
  if (!target) return null;
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (/^(browser|web)\./.test(tool) || /^(browser|web)\./.test(permission)) return { kind: "host", value: target };
  // Batch 26 (wave 8): a program on another computer is a command like any other, but its target
  // reads "tower: make build", so the computer's name is taken off before the program is read.
  // Wave mac3 (tool-safety): the value is the whole command, tidied, so a rule can name a program
  // ("git") or one of its actions ("git status"); see src/command-prefix.ts.
  // Integration review: the value is the whole command read from the arguments, never the target,
  // which is cut at 300 characters and could hide `; rm -rf ~` after a harmless start.
  if (tool === "remote.run") return commandResource(target.split(": ").slice(1).join(": ") || target, fullCommand(tool, a));
  if (isCommandTool(tool)) return commandResource(target, fullCommand(tool, a));
  // A rule about a messaging account holds for every chat on it, one chat of a message at a time.
  if (/^(channels|email)\./.test(tool) || /^(channels|email)\./.test(permission))
    return { kind: "channel", value: accountOf(a, target) };
  // Otherwise the target itself says what kind of thing it is. Going by the target rather than the
  // arguments means a tool that reports what it touches through its own `target()` — which is how a
  // tool with no top-level `path` is meant to do it — is covered by a folder rule like any other.
  // Integration (hardening-3): a file tool's target without an address in the call is a file, even
  // when its name has a dot in it: "q1.txt" is not a website, so a folder or file rule still holds.
  const aboutFiles = /^(files|documents|media|data|code)\./.test(permission) && typeof a.url !== "string";
  return looksLikeHost(target) && !aboutFiles ? { kind: "host", value: target } : { kind: "path", value: target };
}

/**
 * Whether a rule's resource matcher fits what the call is about. A different kind never matches.
 * A command rule covers the words it names and anything after them ("git" covers "git push",
 * "git status" does not); what a joined command can match depends on the rule's decision, so a
 * rule can only ever be made stricter by it (src/command-prefix.ts).
 */
export function resourceMatches(
  matcher: ResourceMatcher, resource: PolicyResource | null | undefined, decision: "allow" | "ask" | "deny" = "allow",
): boolean {
  if (!resource || matcher.kind !== resource.kind) return false;
  if (matcher.kind === "path")
    return pathMatches(matcher.pattern, resource.value)
      || (resource.inWorkspace !== undefined && pathMatches(matcher.pattern, resource.inWorkspace));
  if (matcher.kind === "host") return hostMatches(matcher.pattern, resource.value);
  if (matcher.kind === "command")
    return matcher.exact ? !resource.cut && exactCommandPattern(resource.value) === matcher.pattern : commandCovers(matcher.pattern, resource.value, decision);
  return globMatches(matcher.pattern, resource.value);
}

/** Plain words for what a tool does, so a rule can be read as a sentence rather than a pattern. */
const actionWords: Record<string, { words: string; bareHost?: boolean }> = {
  "*": { words: "anything" },
  "files.*": { words: "changing files" },
  "files.write": { words: "writing files" },
  "files.delete": { words: "deleting files" },
  "shell.execute": { words: "running commands" },
  "remote.execute": { words: "running a program on another computer" },
  "terminal.*": { words: "running commands" },
  "browser.*": { words: "browsing", bareHost: true },
  "browser.navigate": { words: "opening", bareHost: true },
  "browser.click": { words: "clicking on" },
  "browser.fill": { words: "typing on" },
  "browser.upload": { words: "sending your files to" },
  "browser.download": { words: "saving a pending download from", bareHost: true },
  "browser.permission": { words: "granting browser permission to", bareHost: true },
  "browser.keys": { words: "pressing keys on" },
  "browser.select": { words: "choosing options on" },
  // mac7/vault-autofill (R17-068): the sign-in named, never the value it stands for.
  "signin.fill": { words: "filling your saved sign-in" },
  "web.*": { words: "reading", bareHost: true },
  "channels.*": { words: "sending messages" },
  "email.*": { words: "sending email" },
};

function action(tool: string, applies: "any" | "changes" | "reads"): { words: string; bareHost?: boolean } {
  if (tool === "*") return { words: applies === "changes" ? "changing anything" : applies === "reads" ? "looking at anything" : "anything" };
  const known = actionWords[tool];
  if (known) return known;
  const group = actionWords[tool.replace(/\.[^.]+$/, ".*")];
  if (group) return group;
  return { words: `using ${tool}` };
}

const prepositions: Record<ResourceKind, string> = { path: "under", host: "on", channel: "in", command: "named" };

/**
 * One rule as a sentence a non-technical person can read: "Ask before writing files under finance",
 * "Never allow browsing example.com". The settings screen shows these instead of the raw patterns.
 */
export function ruleSentence(rule: {
  tool: string; match: string; applies: "any" | "changes" | "reads"; decision: "allow" | "ask" | "deny";
  resource?: ResourceMatcher | undefined;
  /** How tightly a program the rule covers is held, when the owner chose. */
  sandbox?: SandboxChoice | undefined;
}): string {
  const opening = rule.decision === "allow" ? "Always allow" : rule.decision === "deny" ? "Never allow" : "Ask before";
  const { words, bareHost } = action(rule.tool, rule.applies);
  const where = rule.resource
    ? `${bareHost && rule.resource.kind === "host" ? "" : prepositions[rule.resource.kind] + " "}${rule.resource.pattern}`
    : rule.match && rule.match !== "*"
      ? `when it is ${rule.match}`
      : "";
  const held = rule.sandbox ? ` Run it ${sandboxSentences[rule.sandbox]}.` : "";
  return `${opening} ${words}${where ? " " + where : ""}.${held}`;
}

/** Integration (multi-target): the same tidying, for a rule about a folder inside a whole-folder target (src/policy-targets.ts). */
export { tidyPath };
