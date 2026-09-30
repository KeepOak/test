/**
 * Approvals by reaction, for apps with no buttons (WhatsApp, Signal, Matrix), as OpenClaw does: 👍 or ✅ on the question
 * says yes, 👎 or ❌ says no. Only a reaction on that exact question message counts, only from the person the question
 * was asked of, only once, and only for a while. The answer names the question's fingerprint, so it can never land on
 * another question that waits in the same chat; a question about a command still needs its own Yes button
 * (src/channels/owner-commands.ts), so a reaction there is sent to the window like any typed yes.
 */
const yes = new Set(["👍", "✅", "✔️", "✔"]);
const no = new Set(["👎", "❌", "✖️"]);
/** Skin tones and the emoji presentation mark do not change what a reaction says. */
const plain = (emoji: string): string => emoji.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu, "");
export function reactionAnswer(emoji: string): "y" | "n" | null {
  const bare = plain(emoji.trim());
  if ([...yes].some((one) => plain(one) === bare)) return "y";
  if ([...no].some((one) => plain(one) === bare)) return "n";
  return null;
}
interface Watched { chatId: string; senderId: string; fingerprint: string; expires: number }
/** The questions an adapter sent that a reaction may answer, by the message id the app gave them. */
export class ReactionAnswers {
  private readonly watched = new Map<string, Watched>();
  constructor(private readonly now: () => number = Date.now, private readonly lifetimeMs = 30 * 60_000) {}
  watch(messageId: string, chatId: string, senderId: string, fingerprint: string): void {
    if (!messageId || !/^[a-f0-9]{1,32}$/.test(fingerprint)) return;
    this.watched.set(messageId, { chatId, senderId, fingerprint, expires: this.now() + this.lifetimeMs });
    while (this.watched.size > 200) this.watched.delete(this.watched.keys().next().value!);
  }
  /** Whether a reaction on this message may still answer a question. */
  watching(messageId: string): boolean {
    const watched = this.watched.get(messageId);
    return !!watched && watched.expires > this.now();
  }
  /** The answer a reaction gives, as the router reads it ("y:<fingerprint>"), or null; each question answers once. */
  read(messageId: string, chatId: string, senderId: string, emoji: string): string | null {
    const watched = this.watched.get(messageId), answer = reactionAnswer(emoji);
    if (!watched || !answer) return null;
    if (watched.expires <= this.now()) { this.watched.delete(messageId); return null; }
    if (watched.chatId !== chatId || watched.senderId !== senderId) return null;
    this.watched.delete(messageId);
    return `${answer}:${watched.fingerprint}`;
  }
}
