/* Which surface this window is on, for Settings rows that only apply to a computer (starting with Windows, the tray,
   keyboard shortcuts, the window's frame, this computer's own permissions, removing Branch from it).
   A phone is known three ways, none of them a guess from the browser's name: the phone app keeps its "branch-phone"
   note for the page (apps/mobile/web/inject.js) and offers its bridge; a phone paired in its browser keeps its own
   secret (public/device-headers.js, never kept on the computer itself); and a touch screen with no pointer that
   hovers. The desktop app (?desktop) is always a computer. */
import { isDesktop } from "../core/api.js";
import { readDevice } from "../../device-headers.js";

function phoneApp() {
  try { return Boolean(sessionStorage.getItem("branch-phone")) || Boolean(window.branchPhone || window.webkit?.messageHandlers?.branchPhone); }
  catch (error) { return false; }
}
function pairedPhone() {
  try { return readDevice(localStorage) !== null; } catch (error) { return false; }
}
const touchOnly = () => window.matchMedia?.("(pointer: coarse) and (hover: none)").matches === true;

/** True when the window runs on a phone: computer-only rows are not drawn there. */
export const onPhone = () => !isDesktop && (phoneApp() || pairedPhone() || touchOnly());
