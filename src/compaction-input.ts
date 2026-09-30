import type { Message } from "./contracts.js";

/**
 * P0 (self-build): what a fold of the conversation is made from. The summariser used to be handed only the first
 * 60,000 characters of the folded range, so the newest part of it (what was being done when the room ran out) was
 * never read, while a task's own fold kept only the end. Both now keep the start and the end.
 */

/**
 * The summariser's input held to `max` characters: 45% from the start, 55% from the end, and a marker saying how much
 * of the middle was left out. Adapted from Hermes Agent's `_bound_summary_input` (NousResearch/hermes-agent,
 * agent/context_compressor.py, MIT).
 */
export function boundSummaryInput(content: string, max: number): string {
  if (content.length <= max) return content;
  let omitted = content.length, head = 0, tail = 0, marker = "";
  // The marker's own length changes with the number in it: estimate, then build once more.
  for (let pass = 0; pass < 2; pass++) {
    marker = `\n\n...[omitted ${omitted.toLocaleString("en-US")} chars from the middle, to keep this summary's input within room]...\n\n`;
    const remaining = Math.max(max - marker.length, 0);
    head = Math.floor(remaining * 0.45);
    tail = remaining - head;
    omitted = Math.max(content.length - head - tail, 0);
  }
  return content.slice(0, head).trimEnd() + marker + (tail ? content.slice(-tail).trimStart() : "");
}

/** One message as the summariser reads it. */
export const transcriptLine = (m: Message): string =>
  `${m.role}: ${m.content}${m.toolCalls ? " [requested tools: " + m.toolCalls.map((c) => c.name).join(", ") + "]" : ""}`;

/** The most of the owner's own words kept word for word through a fold, in tokens (Codex's COMPACT_USER_MESSAGE_MAX_TOKENS). */
export const ownerWordsMaxTokens = 20_000;

/**
 * The owner's own messages from the folded part, newest first until `budgetChars` is spent, given back oldest first
 * as one block for the summary; the one that no longer fits whole is cut and ends the list. Null when there are none.
 * Adapted from Codex's `build_compacted_history_with_limit` (openai/codex, codex-rs/core/src/compact.rs, Apache-2.0).
 */
export function ownerWordsSection(newestFirst: readonly string[], budgetChars: number): string | null {
  const kept: string[] = [];
  let remaining = budgetChars;
  for (const text of newestFirst) {
    if (remaining <= 0) break;
    const words = text.trim();
    if (!words) continue;
    if (words.length > remaining) { kept.push(`${words.slice(0, remaining).trimEnd()} [cut]`); break; }
    kept.push(words);
    remaining -= words.length;
  }
  if (!kept.length) return null;
  return `What the owner said in the folded part, word for word (oldest first):\n${kept.reverse().map((words) => `- ${words}`).join("\n")}`;
}
