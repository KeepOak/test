import { esc } from "../core/dom.js";
import { E, S, ownerHere } from "../core/state.js";
import { api, token } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { openConversation } from "../chat/chat.js";

let frame = null, generation = 0, busy = false;
const actor = () => ({ profiles: E.profiles, key: token.get(), signedIn: S.signedIn });
const sameActor = (before) => ownerHere() && before.profiles === E.profiles && before.key === token.get()
  && before.signedIn === S.signedIn && S.signedIn && !document.getElementById("app")?.classList.contains("locked");
function body(view) {
  const pin = view.pinned;
  return `<p>Keep one private conversation one click away from Home. These actions do not send a message or run a task.</p>
    ${pin ? `<p><b>${esc(pin.title)}</b></p><button type="button" class="btn pri" data-act="home-conversation-open" data-v="${esc(pin.sessionId)}">Open Home conversation</button><button type="button" class="btn ghost" data-act="home-conversation-unpin">Unpin</button>` : `<p>${view.unavailable ? "The saved conversation is unavailable. Unpin it or choose another." : "No Home conversation pinned."}</p>${view.unavailable ? '<button type="button" class="btn ghost" data-act="home-conversation-unpin">Unpin unavailable conversation</button>' : ""}`}
    <p><button type="button" class="btn" data-act="home-conversation-create">Create empty Home conversation</button></p>
    <h3>Pin an existing conversation</h3><p>Newest 100 eligible conversations. Temporary, archived, deleted, shared, imported and helper conversations are unavailable.</p>
    ${view.conversations.map((row) => `<p><button type="button" class="btn ghost" data-act="home-conversation-pin" data-v="${esc(row.sessionId)}">${esc(row.title)}</button><small>${esc(row.createdAt)}</small></p>`).join("") || "<p>No eligible conversations yet.</p>"}`;
}
async function show() {
  if (!ownerHere() || busy) return;
  const before = actor(), ticket = ++generation;
  try {
    const view = await api("home-conversation");
    if (!sameActor(before) || ticket !== generation) return;
    frame = openDlg({ title: "Home conversation", body: body(view), wide: true });
  } catch (error) { if (sameActor(before)) toast(error.message); }
}
async function change(action, sessionId) {
  if (!ownerHere() || busy || dialog() !== frame) return;
  const before = actor(), previous = frame, ticket = ++generation;
  busy = true;
  previous.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    const view = await api("home-conversation", { action, ...(sessionId ? { sessionId } : {}) });
    if (!sameActor(before) || ticket !== generation || dialog() !== previous) return;
    frame = openDlg({ title: "Home conversation", body: body(view), wide: true });
  } catch (error) { if (sameActor(before) && dialog() === previous) toast(error.message); }
  finally { busy = false; if (dialog() === previous) previous.querySelectorAll("button").forEach((button) => { button.disabled = false; }); }
}
async function open(id) {
  if (!ownerHere() || busy || dialog() !== frame) return;
  const before = actor(), previous = frame;
  try {
    const view = await api("home-conversation");
    if (!sameActor(before) || dialog() !== previous) return;
    if (view.pinned?.sessionId !== id) { toast("The Home conversation changed or is unavailable. Review it again."); return show(); }
    closeDlg(); frame = null; openConversation(id);
  } catch (error) { if (sameActor(before)) toast(error.message); }
}
export function initHomeConversation() {
  markLive(["home-conversation", "home-conversation-open", "home-conversation-pin", "home-conversation-unpin", "home-conversation-create"]);
  on("home-conversation", show);
  on("home-conversation-open", (el) => open(el.dataset.v));
  on("home-conversation-pin", (el) => change("pin", el.dataset.v));
  on("home-conversation-unpin", () => change("unpin"));
  on("home-conversation-create", () => change("create"));
}
