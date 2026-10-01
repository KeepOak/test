import { channelsOn, check, listed, shellOn } from "./kit.js";
import type { SecurityCheck, SecuritySnapshot } from "./types.js";

/** Which models are trusted with outside text, and who can reach the assistant through a chat service. */

/** How many billions of parameters a model's name says it has, or null. "8x7b" counts as 56. */
export function billionsInName(model: string): number | null {
  const mixture = /(?:^|[^a-z0-9.])(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/i.exec(model);
  if (mixture) return Number(mixture[1]) * Number(mixture[2]);
  const plain = /(?:^|[^a-z0-9.])e?(\d+(?:\.\d+)?)b(?![a-z])/i.exec(model);
  return plain ? Number(plain[1]) : null;
}

const smallTier = /(^|[-_:/ .])(nano|tiny|micro|haiku|instant|flash-lite|flash-8b)([-_:/ .]|$)/i;
const legacy = /gpt-3\.5|text-davinci|davinci-00|claude-(1|2|instant)|chat-bison|text-bison|gemini-1\.0|gemini-pro$|llama-?2\b|codellama/i;
const olderTier = /gpt-4o|gpt-4-turbo|gpt-4(-\d{4})?$|claude-3([-.]|$)|gemini-1\.5|llama-?3(\.[01])?(?![.\d])/i;

export type ModelConcern = "small" | "legacy" | "older";
export function modelConcern(model: string): ModelConcern | null {
  if (legacy.test(model)) return "legacy";
  const size = billionsInName(model);
  if ((size !== null && size <= 14) || smallTier.test(model)) return "small";
  return olderTier.test(model) ? "older" : null;
}

const readsOutside = (snapshot: SecuritySnapshot): boolean =>
  snapshot.tools.some((tool) => tool.startsWith("web.") || tool.startsWith("browser.")) || channelsOn(snapshot);
const modelsWith = (snapshot: SecuritySnapshot, concern: ModelConcern) =>
  snapshot.models.filter((entry) => modelConcern(entry.model) === concern).map((entry) => entry.model);

export const modelChecks: SecurityCheck[] = [
  check("models.small-with-outside-text", "models", "warn", "Small models are not left alone with web pages and messages", (snapshot) => {
    const small = modelsWith(snapshot, "small");
    return small.length && readsOutside(snapshot) ? {
      detail: `${listed(small)} ${small.length === 1 ? "is a small model" : "are small models"}, and the assistant reads web pages or messages from outside. Small models are much easier to talk into doing something you did not ask for.`,
      advice: "Use a larger model for tasks that read the web or messages, or keep \"Ask before changes\" on while a small one is chosen.",
    } : null;
  }),
  check("models.legacy", "models", "warn", "No model is from an old generation", (snapshot) => {
    const old = modelsWith(snapshot, "legacy");
    return old.length ? {
      detail: `${listed(old)} ${old.length === 1 ? "is" : "are"} from an old generation of models that resists tricks hidden in text poorly.`,
      advice: "Switch to a current model in Settings → Models.",
    } : null;
  }),
  check("models.older-with-tools", "models", "info", "Models trusted with outside text are current ones", (snapshot) => {
    const older = modelsWith(snapshot, "older");
    return older.length && readsOutside(snapshot) ? {
      detail: `${listed(older)} ${older.length === 1 ? "is" : "are"} a generation behind, and the assistant reads outside text.`,
      advice: "Consider a current model for tasks that read the web or messages.",
    } : null;
  }),
];

const channels = (snapshot: SecuritySnapshot) => snapshot.integrations?.channels ?? [];

export const channelChecks: SecurityCheck[] = [
  check("channels.open-to-anyone", "channels", "critical", "Only people you approved can message the assistant", (snapshot) => {
    const open = channels(snapshot).filter((channel) => !channel.pairing && channel.allowlist.length === 0);
    return open.length ? {
      detail: `On ${listed(open.map((channel) => channel.id))}, anybody who finds the account can talk to the assistant: pairing is off and nobody is listed.`,
      advice: "Turn pairing back on, or list the people allowed, for that chat service in the launch settings file.",
    } : null;
  }),
  check("channels.no-pairing", "channels", "info", "New people are paired before they are answered", (snapshot) => {
    const loose = channels(snapshot).filter((channel) => !channel.pairing && channel.allowlist.length > 0);
    return loose.length ? {
      detail: `On ${listed(loose.map((channel) => channel.id))}, the people listed are answered without pairing first.`,
      advice: "That is fine when the list is exactly right. Pairing adds a code they must send once.",
    } : null;
  }),
  check("channels.always-listening", "channels", "info", "In group chats the assistant answers only when asked", (snapshot) => {
    const always = channels(snapshot).filter((channel) => channel.activation === "always");
    const groups = snapshot.alwaysGroups ?? [];
    if (!always.length && !groups.length) return null;
    const where = [...always.map((channel) => channel.id), ...groups.map((group) => `${group.title} (${group.channel})`)];
    return {
      detail: `On ${listed(where)}, the assistant reads and answers every message, not only the ones that mention it.`,
      advice: groups.length ? "Set activation to \"mention\" for group chats, and set those groups back to answering when mentioned in Settings › Chat apps."
        : "Set activation to \"mention\" for group chats.",
    };
  }),
  check("channels.mail-in-clear", "channels", "warn", "Mail is fetched and sent over encrypted connections", (snapshot) => {
    const plain = channels(snapshot).filter((channel) => !channel.tls);
    return plain.length ? {
      detail: `${listed(plain.map((channel) => channel.id))} ${plain.length === 1 ? "connects" : "connect"} to the mail server without encryption at first.`,
      advice: "Set tls to true for the mail server unless it really only offers STARTTLS on sending.",
    } : null;
  }),
  check("channels.commands-without-asking", "channels", "critical", "A message from outside cannot run a program without you", (snapshot) => {
    // Owner ruling 2026-09-30: "a command no rule mentions" shapes only the owner's own tasks; a chat's task asks before every change.
    const loose = snapshot.policy.rules.some((rule) =>
      rule.decision === "allow" && rule.match === "*" && ["*", "shell.*", "shell.execute"].includes(rule.tool));
    return channelsOn(snapshot) && shellOn(snapshot) && loose ? {
      detail: "People can message the assistant from outside, and a rule lets it run programs without asking you. Tasks from outside are held to \"Ask before changes\", but a rule you wrote can still allow commands.",
      advice: "Change the rule that allows commands to ask, in Settings → Permissions.",
    } : null;
  }),
  check("channels.personal-details-sent", "channels", "warn", "Personal details are hidden in messages the assistant sends", (snapshot) =>
    channelsOn(snapshot) && snapshot.privacy.outbound === "off" ? {
      detail: "Messages the assistant sends to chat services and mailboxes go out with phone numbers, card numbers and addresses left in.",
      advice: "Set personal details on the way out to hide or hold back, in Settings → Permissions.",
    } : null),
  check("channels.no-content-check", "channels", "info", "Messages going out can be checked by your provider", (snapshot) =>
    channelsOn(snapshot) && !snapshot.privacy.moderation ? {
      detail: "Messages the assistant sends out are not checked for harmful content first.",
      advice: "Turn on the content check in Settings → Permissions if your provider offers one.",
    } : null),
];
