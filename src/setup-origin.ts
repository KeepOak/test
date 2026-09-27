import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Setup polish 2: whether the work in progress was asked for from the window's setup. Setup's choices (how much Branch
 * asks, the look, the hello, the first Trunks and their introductions, pairing) are first-run configuration, not
 * accomplishments, so achievements set aside whatever they cause (src/delight.ts).
 *
 * The window sends `x-branch-origin: setup` on every request while setup is open, and `window` otherwise
 * (public/app/core/api.js). The mark follows everything a setup request starts, like the short-lived key's mark
 * (src/key-context.ts). Anything that request leaves running for longer (a timer, a listener) would carry the mark too,
 * so the mark is one shared object that the window's next request from outside setup closes. Requests from anything
 * else (the terminal, the desktop app's own checks) say nothing either way.
 */
export const setupOriginHeader = "x-branch-origin";
interface SetupMark { open: boolean }
const scope = new AsyncLocalStorage<SetupMark>();
let current: SetupMark = { open: false };

/** Called once per request the key let in: "setup" opens (or keeps) setup's mark, "window" closes it. */
export function noteSetupOrigin(header: string | string[] | undefined): void {
  if (header === "window") current.open = false;
  if (header !== "setup") return;
  if (!current.open) current = { open: true };
  scope.enterWith(current);
}
/** True while the work in progress came from setup and setup has not ended since. */
export function fromSetup(): boolean {
  return scope.getStore()?.open === true;
}
