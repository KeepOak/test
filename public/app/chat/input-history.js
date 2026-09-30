/* Conversation-derived recall and saved draft approach: Hermes composer-input-history.ts
   (Nous Research, MIT, a9a54245b2311c705d29050b7f9868c015917aec). Original Branch wiring. */
import { $, afterDraw } from "../core/dom.js";
import { S, E, activeId, ownerHere, trunkIntro } from "../core/state.js";

let read = () => ({ sessionId: null, messages: [] });
let scope = "", browsing = null, recalling = false;
const context = () => S.view === "chat" && read().sessionId ? JSON.stringify([activeId(), read().sessionId]) : "";
const mine = (m) => m.person ? m.person.id === activeId() : !E.rooms.some((room) => room.sessionId === read().sessionId) || ownerHere();
const identity = (m) => m.messageId ?? m;
const history = () => (read().messages ?? []).filter((m) => m.role === "user" && mine(m) && !m.from && !m.system && !trunkIntro(m) && typeof m.content === "string" && m.content.trim()).slice().reverse();
function sync() {
  const now = context();
  if (scope !== now || (browsing && $("#prompt")?.value !== browsing.text)) browsing = null;
  scope = now;
}
function put(box, words) {
  box.value = words;
  box.setSelectionRange(words.length, words.length);
  recalling = true;
  try { box.dispatchEvent(new Event("input", { bubbles: true })); } finally { recalling = false; }
}
function recall(e) {
  const box = e.target;
  if (box.id !== "prompt" || e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  if (box.readOnly || box.disabled || box.dataset.vim === "normal" || $(".slash6, .pop [data-act='mention-pick'], .pop [data-act='slash-pick']")) return;
  sync();
  if (!scope || box.selectionStart !== box.selectionEnd) return;
  const older = e.key === "ArrowUp", caret = box.selectionStart;
  if (older ? box.value.slice(0, caret).includes("\n") : box.value.slice(caret).includes("\n")) return;
  if (!browsing && (!older || box.value.trim())) return;
  const entries = history();
  const index = browsing ? entries.findIndex((m) => identity(m) === browsing.message) : -1;
  if (browsing && index < 0) { browsing = null; return; }
  const next = older ? index + 1 : index - 1;
  if (next >= entries.length) { if (browsing) e.preventDefault(); return; }
  e.preventDefault();
  if (next < 0) { const draft = browsing.draft; browsing = null; put(box, draft); return; }
  const message = entries[next];
  browsing = { message: identity(message), text: message.content, draft: browsing?.draft ?? box.value };
  put(box, browsing.text);
}
export function initInputHistory(state) {
  read = state;
  afterDraw(sync);
  document.addEventListener("keydown", recall);
  document.addEventListener("input", (e) => { if (e.target.id === "prompt" && !recalling) browsing = null; });
  addEventListener("pagehide", () => { browsing = null; scope = ""; });
}
