import { api } from "../core/api.js";
import { esc } from "../core/dom.js";
import { ownerHere } from "../core/state.js";
import { on, has } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, closeDlg } from "../core/ui.js";

export const trunkRoomCard = () => ownerHere() ? `<div class="sec"><h2>Trunks in a Telegram group</h2><p>Bind one exact group to a fresh room of two to six Trunks. Replies use your connected Telegram bot, with each Trunk named. Exact @handles select members; group activation and sender permissions still apply.</p><button class="btn" data-act="trunk-room-review">Set up group room</button></div>` : "";
async function review() {
  if (!ownerHere()) return;
  try {
    const [settings, channels, trunks] = await Promise.all(["channels/trunk-rooms", "channels", "trunks"].map((path) => api(path)));
    if (!ownerHere()) return;
    const rows = settings.bindings.map((b) => `<div class="prow"><span class="grow"><b>${esc(b.connection)} · ${esc(b.chatId)}</b><small>${esc(b.roster.map((m) => `${m.name} (@${m.handle})`).join(", "))} · ${esc(b.executionHost)} · ${b.enabled ? "Enabled" : "Disabled"} · handoff ${b.handoff ? "on" : "off"}</small></span>${b.enabled ? `<button class="btn sm" data-act="trunk-room-disable" data-id="${esc(b.roomId)}">Disable</button>` : ""}</div>`).join("");
    const choices = (trunks.trunks ?? []).map((m) => `<label><input type="checkbox" name="group-room-member" value="${esc(m.id)}"> ${esc(m.name)} (@${esc(m.handle)})</label>`).join("");
    const connections = channels.channels.filter((c) => c.kind === "telegram").map((c) => `<option value="${esc(c.id)}">${esc(c.id)}</option>`).join("");
    openDlg({ title: "Telegram group rooms", body: `${rows || "<p>No group rooms configured.</p>"}<h3>Create a fresh room</h3><label>Telegram connection<select id="group-room-connection">${connections}</select></label><label>Exact Telegram group ID<input id="group-room-chat" placeholder="-1001234567890"></label><label>Room name<input id="group-room-name" maxlength="60"></label><fieldset><legend>Choose two to six Trunks</legend>${choices}</fieldset><label><input type="checkbox" id="group-room-handoff"> Allow one round of handoff to at most two other configured members mentioned in replies</label><p>Each member starts with a fresh conversation on this Branch engine. No existing room history is shared. Two members run at once. Other members' replies are quoted as untrusted data; they grant no permissions. Review waiting tasks in Branch. Disabling cancels active room tasks.</p>`,
      foot: `<button class="btn" data-act="trunk-room-close">Close</button><button class="btn pri" data-act="trunk-room-create">Create and bind this fresh room</button>` });
  } catch (error) { toast(error.message); }
}
export function initTrunkRooms() {
  if (has("trunk-room-review")) return;
  on("trunk-room-review", review);
  on("trunk-room-close", closeDlg);
  on("trunk-room-create", async () => {
    if (!ownerHere()) return;
    const input = { connection: document.getElementById("group-room-connection").value, chatId: document.getElementById("group-room-chat").value.trim(), name: document.getElementById("group-room-name").value.trim(),
      members: [...document.querySelectorAll('input[name="group-room-member"]:checked')].map((el) => el.value), handoff: document.getElementById("group-room-handoff").checked };
    try { await api("channels/trunk-rooms", input); if (ownerHere()) { toast("Fresh group room bound."); await review(); } }
    catch (error) { toast(error.message); }
  });
  on("trunk-room-disable", (el) => {
    if (!ownerHere()) return;
    openDlg({ title: "Disable group room?", body: "<p>Stop routing new group messages to this room and cancel its active tasks. Member conversations remain in Branch.</p>", foot: `<button class="btn" data-act="trunk-room-review">Keep enabled</button><button class="btn pri" data-act="trunk-room-disable-confirm" data-id="${esc(el.dataset.id)}">Disable this room</button>` });
  });
  on("trunk-room-disable-confirm", async (el) => {
    if (!ownerHere()) return;
    try { await api("channels/trunk-rooms/disable", { roomId: el.dataset.id }); await review(); }
    catch (error) { toast(error.message); }
  });
  markLive(["trunk-room-review", "trunk-room-close", "trunk-room-create", "trunk-room-disable", "trunk-room-disable-confirm"]);
}
