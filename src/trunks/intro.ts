/**
 * What the engine asks a new Trunk to say first, in its own conversation (src/trunks/index.ts introduce). Nobody typed
 * it, so a Branch whose only conversations are these introductions still counts as empty for a restore (src/backup.ts).
 */
export const introPrompt = "Introduce yourself to the owner in two or three short sentences: your name, your role, and what you can help with. This is the first message of your own conversation.";
/** The mark its message carries (runtime.run `system`), so the message is known as the engine's, not the owner's. */
export const introSystem = "trunk-intro";
