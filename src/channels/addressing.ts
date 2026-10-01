/**
 * Whether a message in a group is for the assistant (a GrokBot user added their bot to a group and it never answered).
 * Every app says "addressed" when the assistant is @mentioned or replied to, in the app's own way; this adds the third
 * way people talk to a bot in a group, by its name as a word ("Branch, what's the time?", "thanks branch"), the way
 * OpenClaw's mention patterns and Hermes' name triggers do. Only whole words count, so "branches" is not "Branch".
 */
const wordEdge = "[\\p{L}\\p{N}_]";
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words too common to be a name: a bot called "Assistant" is not spoken to by every message that says "assistant". */
const generic = new Set(["bot", "bots", "the", "assistant", "helper", "agent", "chat", "hey", "you", "all", "everyone", "here"]);
/** True when `text` calls the assistant by one of `names` as a whole word, ignoring case. Names under three letters are left out. */
export function calledByName(text: string, names: readonly (string | null | undefined)[]): boolean {
  const usable = [...new Set(names.map((name) => (name ?? "").replace(/^@/, "").trim())
    .filter((name) => name.length >= 3 && !generic.has(name.toLowerCase())))];
  if (!usable.length || !text) return false;
  const pattern = new RegExp(`(?<!${wordEdge})(?:${usable.map(escape).join("|")})(?!${wordEdge})`, "iu");
  return pattern.test(text);
}

/**
 * What each app lets a bot see in a group, for the setup wizard and the group's own setting. "Every message" only works
 * where the app hands the bot every message; elsewhere the bot sees mentions and replies only, whatever Branch is set to.
 */
export interface GroupReading {
  /** True when the bot receives every message in this group; false when only mentions and replies reach it; null when unknown. */
  everyMessage: boolean | null;
  /** What to change on the app's side so it does, in plain words, when it does not. */
  fix?: string;
}
