/**
 * What the engine asks a new Trunk to say first, in its own conversation (src/trunks/index.ts introduce). Nobody typed
 * it, so a Branch whose only conversations are these introductions still counts as empty for a restore (src/backup.ts).
 */
export const introPrompt = "Introduce yourself to the owner in two or three short sentences: your name, your role, and what you can help with. This is the first message of your own conversation.";
/** The mark its message carries (runtime.run `system`), so the message is known as the engine's, not the owner's. */
export const introSystem = "trunk-intro";
/**
 * QA 2026-09-28 (Pass 2): the default Trunk made quietly (no model asked) opens its conversation with these words, written
 * rather than generated. Like an introduction, nobody typed them, so they leave a Branch empty for a restore.
 */
export const defaultGreeting = (name: string): string =>
  `Hi, I'm ${name}. I answer every conversation that doesn't pick another Trunk. Ask me anything, or tell me what you're working on.`;
