import { globMatches, type Policy, type PolicyRule } from "../policy.js";
import type { Store } from "../store.js";
import { readComfort } from "./settings.js";

/**
 * R17-S19: the browser's extra care. Each of these only ever tightens what the approval rules and
 * the browser already do; with every switch at its default nothing here changes anything.
 */

/**
 * The browser steps that type, press, send a file, sign in as the owner or take over the owner's own
 * browser. The shared computer tools press and type on the same page, so they count too
 * (integration review).
 */
export const sensitiveBrowserTools = [
  "browser.click", "browser.fill", "browser.act", "browser.upload", "browser.borrow", "browser.profile",
  "browser.keys", "browser.select",
  "computer.press", "computer.type",
] as const;

export const browserConfirmationHold = "Settings asks before every sensitive browser step";
/**
 * Integration review: whether this step's question may only be answered "just this once". An
 * earlier yes kept for the conversation must not stand in for it either, or "every time" would
 * only mean "the first time".
 */
export function holdsBrowserStep(store: Pick<Store, "get">, owner: string, tool: string): boolean {
  return (sensitiveBrowserTools as readonly string[]).includes(tool) && readComfort(store, owner, "browser").confirmSensitive;
}

/**
 * With "confirm sensitive actions" on, each of those steps is asked about every time, whatever the
 * owner allowed before — including a yes for one website. Every refusal keeps deciding exactly
 * where it did, so turning this on can never make a refused step askable.
 *
 * Nothing is put in front of the owner's rules. Instead, just before each rule that would let one of
 * those steps through, the same rule is written again as a question for that step, so it sits in the
 * same place (src/policy.ts looks at rules naming a website first, then the broad ones, each in the
 * owner's order). A broad question for each step goes last, for a step no rule speaks about.
 */
export function withBrowserConfirmation(policy: Policy, store: Pick<Store, "get">, owner: string): Policy {
  if (!readComfort(store, owner, "browser").confirmSensitive) return policy;
  const question = (rule: Pick<PolicyRule, "match" | "applies" | "resource">, tool: string): PolicyRule => ({
    tool, match: rule.match, applies: rule.applies, decision: "ask", remember: "never",
    ...(rule.resource ? { resource: rule.resource } : {}),
  });
  const rules = policy.rules.flatMap((rule) => rule.decision !== "allow" ? [rule]
    : [...sensitiveBrowserTools.filter((tool) => globMatches(rule.tool, tool)).map((tool) => question(rule, tool)), rule]);
  const lastly = sensitiveBrowserTools.map((tool) => question({ match: "*", applies: "any" }, tool));
  return { ...policy, rules: [...rules, ...lastly] };
}

export const uploadsBlocked = "Sending files to websites is switched off in Settings › Computer & browser.";

/** What the browser needs to know before each step. */
export interface BrowserCare {
  blockUploads: boolean;
  dialogs: "dismiss" | "accept";
  numberMarks: boolean;
  recordTasks: boolean;
  downloadsFrom: "anywhere" | "known" | "ask";
}
export const browserCareDefaults: BrowserCare = { blockUploads: false, dialogs: "dismiss", numberMarks: true, recordTasks: false, downloadsFrom: "anywhere" };

export function browserCare(store: Pick<Store, "get">, owner: string): BrowserCare {
  const { blockUploads, dialogs, numberMarks, recordTasks, downloadsFrom } = readComfort(store, owner, "browser");
  return { blockUploads, dialogs, numberMarks, recordTasks, downloadsFrom };
}

export const marksOff = "Numbering what's on a page is switched off in Settings › Computer & browser › The browser, more.";
export const downloadNotKnown = (host: string): string =>
  `A file from ${host} was not kept: Settings › Permissions says downloads may come only from sites this task's pages were on.`;

/**
 * "Ask before a site it hasn't visited": opening an address asks once for each site. A question is put before every
 * rule that would let browser.navigate go anywhere (match "*"); a rule the owner already has for one site (an earlier
 * "always" answered here writes one) still comes first, so a site said yes to is not asked about again.
 */
/**
 * Downloads may come from › Ask each time: keeping a held file is put to the owner every time, ahead of every other rule,
 * so a broad "allow" preset never keeps one without a yes. A yes is for that one file only.
 */
export function withDownloadQuestion(policy: Policy, store: Pick<Store, "get">, owner: string): Policy {
  if (readComfort(store, owner, "browser").downloadsFrom !== "ask") return policy;
  const question: PolicyRule = { tool: "browser.keep_download", match: "*", applies: "any", decision: "ask", remember: "never" };
  return { ...policy, rules: [question, ...policy.rules] };
}
export const downloadHeld = (name: string): string =>
  `${name} is waiting outside the workspace: Settings › Permissions says to ask each time. Call browser.keep_download with its held id to ask the owner.`;

export function withNewSiteQuestion(policy: Policy, store: Pick<Store, "get">, owner: string): Policy {
  if (!readComfort(store, owner, "browser").askNewSites) return policy;
  const question: PolicyRule = { tool: "browser.navigate", match: "*", applies: "any", decision: "ask", remember: "always" };
  const at = policy.rules.findIndex((rule) => !rule.resource && rule.match === "*" && globMatches(rule.tool, "browser.navigate"));
  const rules = at < 0 ? [...policy.rules, question] : [...policy.rules.slice(0, at), question, ...policy.rules.slice(at)];
  return { ...policy, rules };
}
