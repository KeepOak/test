/**
 * parity-b2 (review): whether Branch's own sign-in handling is on at this moment, so the owner's live view of the screen
 * (src/live-screen.ts) takes no frame while it is: a saved sign-in being read and typed (src/vault-autofill.ts), and the
 * window the owner signs in by hand in (src/integrations/browser.ts signIn). Kept in memory only.
 */
let open = 0;

/** True while any of Branch's own sign-in handling is under way. */
export function signInShowing(): boolean { return open > 0; }

/** Runs `work` with the screen held back until it has finished, however it finishes. */
export async function whileSignInShows<T>(work: () => Promise<T>): Promise<T> {
  open += 1;
  try { return await work(); } finally { open -= 1; }
}
