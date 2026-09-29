/**
 * Settings › Chat apps › Edited messages, for apps that report every change to a message (Discord, Slack): the words
 * each recent message had, so a change that left them as they were (a link unfolding into a preview, a reaction) is
 * not read as an edit. The newest 500 messages are remembered.
 */
export class EditedWords {
  private readonly words = new Map<string, string>();
  /** True when `text` differs from what this message said before (or it was never seen); remembers `text`. */
  changed(id: string, text: string): boolean {
    const before = this.words.get(id);
    this.words.delete(id);
    this.words.set(id, text);
    while (this.words.size > 500) this.words.delete(this.words.keys().next().value!);
    return before !== text;
  }
}
