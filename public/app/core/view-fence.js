/* A view drawn after an await is drawn only if nothing changed meanwhile: the same person is still here, signed in and
   not locked out, the window shows the same place, no newer open of the same view began, and no dialog opened or
   closed (ui.js dialogRevision moves on for each, so "nothing open, then one opened and closed" still counts). A late
   answer is dropped rather than bringing back what was left. */
import { S, E } from "./state.js";
import { sessionPrincipal } from "./session-pages.js";
import { dialogRevision } from "./ui.js";

const opens = new Map();
const unlocked = () => !document.getElementById("app")?.classList.contains("locked-b17");

/** Call before the await; the answer says whether it is still right to draw. */
export function viewFence(name) {
  const mine = (opens.get(name) ?? 0) + 1;
  opens.set(name, mine);
  const who = sessionPrincipal(E.profiles), revision = dialogRevision(), view = S.view;
  return () => opens.get(name) === mine && dialogRevision() === revision && S.view === view
    && sessionPrincipal(E.profiles) === who && S.signedIn === true && unlocked();
}

/** The same person, signed in and unlocked: for a view that redraws itself (a live page's poll). */
export function viewerFence() {
  const who = sessionPrincipal(E.profiles);
  return () => sessionPrincipal(E.profiles) === who && S.signedIn === true && unlocked();
}
