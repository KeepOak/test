import type { CommandContext } from "./chat-commands.js";

const usage = "Send /diff [relative folder] or /diff --staged [relative folder]. It shows tracked changes in Branch's workspace.";

/** CHAT-195: the existing read-only tool keeps folder rules, ignored files and the caller's permissions. */
export async function chatDiffCommand(argument: string, context: CommandContext): Promise<string> {
  try {
    if (!context.ownerDm) return "Read a workspace diff from your own live direct chat on Telegram, Discord, Slack or Matrix.";
    context.runtime.store.profiles.requireOwner("Reading a workspace diff from chat");
    if (!context.diffRefusal) return "Reading a diff is unavailable from this chat.";
    const refusal = context.diffRefusal();
    if (refusal) return refusal;
    if (context.turn) return "Something is working here. Send /stop first, then /diff.";
    if (!context.permissions.includes("git.read")) return "This chat cannot read Git changes. Allow git.read for it in the Branch app first.";
    const words = argument.trim().split(/\s+/).filter(Boolean);
    const staged = words[0] === "--staged";
    if (staged) words.shift();
    if (words.length > 1 || words.some((word) => word.startsWith("-"))) return usage;
    const result = await context.runtime.executeTool("git.diff", { folder: words[0] ?? ".", staged }, {
      mode: "policy", source: "channel", within: context.permissions, signal: AbortSignal.timeout(30000),
    });
    return diffReply(result, context.maxReplyChars ?? 3500);
  } catch (error) {
    return context.runtime.hideSecrets(error instanceof Error ? error.message : String(error));
  }
}

/** Keep one closed fence within the adapter's limit, including a visible truncation notice. */
function diffReply(result: unknown, maximum: number): string {
  const value = result as { text?: unknown; truncated?: unknown } | null;
  if (!value || typeof value.text !== "string") return "The Git tool did not return a diff.";
  if (!value.text) return "No visible tracked changes in that workspace folder. New untracked files are not included.";
  const limit = Number.isFinite(maximum) ? Math.max(256, Math.min(3500, Math.floor(maximum))) : 3500;
  const header = "Tracked Git changes (workspace folder):\n```diff\n", end = "\n```";
  const notice = "\nDiff shortened. Open Git changes in the Branch app to read the rest.";
  // A diff can contain Markdown's own fences; a zero-width separator keeps those lines inside ours.
  const text = value.text.replace(/```/g, "``\u200b`");
  const room = limit - header.length - end.length - notice.length;
  let shown = text.slice(0, room);
  if (shown.length < text.length && shown.lastIndexOf("\n") > 0) shown = shown.slice(0, shown.lastIndexOf("\n"));
  return header + shown + end + (value.truncated === true || shown.length < text.length ? notice : "");
}
