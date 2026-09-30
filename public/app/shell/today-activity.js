import { esc } from "../core/dom.js";
import { ownerHere } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, closePop, toast } from "../core/ui.js";
import { openConversation } from "../chat/chat.js";

async function read() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return api(`/api/activity/today?timezone=${encodeURIComponent(timezone)}`);
}
function body(today) {
  const count = `${today.capped ? "At least " : ""}${today.count} done today`;
  return `<section aria-label="Today's completed tasks"><h3>Today · ${esc(count)}</h3>
    <p>${esc(today.date)} · ${esc(today.timezone)}. Recorded completed primary owner runs; outcomes have not been independently verified.</p>
    ${today.rows.map((row) => `<p><button type="button" class="btn ghost" data-act="today-source" data-v="${esc(row.sessionId)}">${esc(row.title)}</button>
      <small>${esc(new Date(row.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))} · Completed · ${esc(row.id)}</small></p>`).join("") || "<p>No eligible completed tasks recorded today.</p>"}
    <p>${esc(today.history)} ${today.capped ? "The 1,000-row read limit was reached; the count is a lower bound." : ""}
      ${today.count > today.listed ? `Showing the newest ${today.listed} of ${today.count} retained completions.` : ""}</p></section>`;
}
export async function todayActivityHTML() {
  if (!ownerHere()) return "";
  try { const today = await read(); return ownerHere() ? body(today) : ""; }
  catch { return ownerHere() ? "<section><h3>Today</h3><p>Completed activity unavailable. Count unknown.</p></section>" : ""; }
}
export function initTodayActivity() {
  markLive(["today-activity", "today-source"]);
  on("today-activity", async () => {
    if (!ownerHere()) return;
    const html = await todayActivityHTML();
    if (ownerHere()) openDlg({ title: "Today's activity", wide: true, body: html });
  });
  on("today-source", async (el) => {
    if (!ownerHere()) return;
    try {
      const fresh = await read();
      if (!ownerHere()) return;
      if (!fresh.rows.some((row) => row.sessionId === el.dataset.v)) { toast("This activity changed. Refresh Today."); return; }
      closePop(); closeDlg(); openConversation(el.dataset.v);
    } catch (error) { toast(error.message); }
  });
}
