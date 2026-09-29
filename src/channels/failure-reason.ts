import { trunkSignInRefusal } from "../accounts/context.js";

/** owner-dm-signin: the longest reason a chat is given for a task that did not finish. */
export const reasonAtMost = 280;

/**
 * owner-dm-signin: what a chat is told about its own sign-in refusal. In a direct chat, it names the setting that makes
 * that account the owner's (Settings › Chat apps › Commands from your own chat, where the switch may stay off); a group
 * is never the owner, so it hears only the way that works there.
 */
export const chatSignInRefusal = {
  direct: "My model here is one of your sign-in accounts, which answers only you. If this is your own account, "
    + "open Settings › Chat apps › Commands from your own chat in Branch and tick it as yours (the switch can stay off). "
    + "Or add a model connection with an API key.",
  group: "My model here is one of the owner's sign-in accounts, which answers only the owner, never a group. "
    + "The owner can add a model connection with an API key in Settings › Models.",
} as const;

/**
 * owner-dm-signin: the one or two lines a chat gets when its task did not finish, with the task's own reason in place of
 * the bare status. `scrub` hides keys and private details (the router's hideLeaks over the runtime's hideSecrets); the
 * reason is then cut to its first two sentences and at most `reasonAtMost` characters, so a long error never floods
 * the chat. With no reason recorded, the status is all there is to say.
 */
export function chatFailureLine(status: string, output: string, chatKind: "direct" | "group", scrub: (text: string) => string): string {
  if (output.includes(trunkSignInRefusal)) return `I could not answer that. ${chatSignInRefusal[chatKind]}`;
  const plain = scrub(output).replace(/\s+/g, " ").trim();
  if (!plain) return `I could not finish that (${status}).`;
  const sentences = plain.split(/(?<=[.!?])\s+/);
  let reason = sentences[0]!;
  if (sentences[1] && reason.length + 1 + sentences[1].length <= reasonAtMost) reason += ` ${sentences[1]}`;
  if (reason.length > reasonAtMost) reason = `${reason.slice(0, reasonAtMost - 1).trimEnd()}…`;
  return `I could not finish that: ${reason}`;
}
