/* Beside-pane search uses Branch's existing scoped sessions/search contract. */
import { $, esc, afterDraw } from "../core/dom.js";
import { E, S, activeId, ownName, chatFace } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { openPop, closePop, av } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const P = { rows: [], next: null, busy: false, error: "", timer: null, request: null, scope: null, picked: null };
const idOf = (row) => row.sessionId ?? row.id;
const scope = () => JSON.stringify([activeId(), E.profiles?.isOwner ?? null]);
const title = (row) => ownName(idOf(row)) || row.title || row.opening || row.preview || "";
export const pickedBesideName = (id) => P.picked?.scope === scope() && P.picked.id === id ? P.picked.name : "";
export function rememberBesidePick(id) {
  const row = P.scope === scope() && P.rows.find((r) => idOf(r) === id);
  P.picked = row ? { id, name: title(row), scope: scope() } : null;
}
function rowsHTML() {
  const rows = P.rows.filter((r) => idOf(r) !== S.chat).map((r) => `<button class="mi" type="button" data-act="beside15" data-v="${esc(idOf(r))}">${av(chatFace(idOf(r)), 22)}<span><span class="mi-t">${esc(title(r))}</span><span class="mi-s">${esc(String(r.match || r.lastMessage || "").slice(0, 80))}</span></span></button>`).join("");
  const more = P.next !== null ? `<button class="mi" type="button" data-act="beside-more"${P.busy ? " disabled" : ""}>${t("action.load-more-conversations")}</button>` : "";
  const empty = !rows && !P.busy && !P.error ? `<p class="hint" role="status">${t("window.chat.beside.no-matches")}</p>` : "";
  return rows + empty + (P.busy ? `<p class="hint" aria-live="polite">${t("docs.status.looking")}</p>` : "") + (P.error ? `<p class="hint" role="status">${esc(P.error)}</p>` : "") + more;
}
const drawRows = () => { const rows = $("#beside-rows"); if (rows) rows.innerHTML = rowsHTML(); };
async function search(box, offset = 0) {
  const query = box.value.trim(), who = scope(), request = new AbortController();
  P.request?.abort();
  P.request = request;
  P.busy = true; P.error = ""; drawRows();
  const current = () => P.request === request && box === $("#beside-query") && box.value.trim() === query && scope() === who;
  try {
    const result = await api("sessions/search", { query, offset }, "POST", request.signal);
    if (!current()) return;
    const rows = offset ? [...P.rows, ...(result.sessions ?? [])] : result.sessions ?? [];
    P.rows = [...new Map(rows.map((row) => [idOf(row), row])).values()];
    P.next = result.nextOffset ?? null;
  } catch (error) { if (current() && error.name !== "AbortError") P.error = error.message; }
  finally { if (current()) { P.busy = false; drawRows(); } }
}
export function openBesidePicker(anchor) {
  clearTimeout(P.timer); P.request?.abort();
  Object.assign(P, { rows: E.sessions.slice(0, 20), next: null, busy: false, error: "", scope: scope() });
  openPop(anchor, `<div class="ph">${t("window.chat.beside.open-beside")}</div><input class="inp" id="beside-query" type="search" maxlength="500" aria-label="${t("action.search")}" placeholder="${t("action.search")}"><div id="beside-rows">${rowsHTML()}</div>`, { right: true, force: true });
  const box = $("#beside-query"); box?.focus(); if (box) void search(box);
}
export function initBesidePicker() {
  markLive(["beside-more", "sw:beside-query"]);
  on("beside-more", () => { const box = $("#beside-query"); if (box && !P.busy && P.next !== null) void search(box, P.next); });
  document.addEventListener("input", (e) => {
    if (e.target.id !== "beside-query") return;
    clearTimeout(P.timer); P.request?.abort(); P.request = null;
    Object.assign(P, { rows: [], next: null, busy: true, error: "" }); drawRows();
    const box = e.target; P.timer = setTimeout(() => { if (box === $("#beside-query")) void search(box); }, 250);
  });
  afterDraw(() => {
    if (P.scope === scope()) return;
    clearTimeout(P.timer); P.request?.abort();
    Object.assign(P, { rows: [], next: null, request: null, picked: null, busy: false, scope: scope() });
    if ($("#beside-query")) closePop();
  });
}
