/* Conversations like iMessage (src/conversation-actions.ts): Pin to top, Rename, Archive and Delete in a row's menu (right-
   click, the row's "…", or the keyboard's menu key), swipe on touch (left Delete, right Pin), and Archived and Recently
   Deleted at the end of the list, only while they hold something. Every change is the engine's (POST /api/sessions/<id>/
   pin|rename|archive|delete|restore|delete-now, POST /api/sessions/put-away/empty) and is read back with refresh().
   A Trunk's or a room's own conversation is pinned and renamed through its Trunk or room (flows/trunk.js). */

import { $, esc, renderNow } from "../core/dom.js";
import { S, E, refresh, ownName } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { ic, mi, openDlg, closeDlg, closePop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { chatOwner, pinChat, renameDlg } from "../flows/trunk.js";
import { pinLine } from "./trunkline.js";
import { t, tc } from "../../i18n.js";

const sid = (s) => s.sessionId ?? s.id;
const find = (id) => E.sessions.find((s) => sid(s) === id);
const titleOf = (row) => ownName(row.sessionId) || row.title || row.opening || t("comfort.field.newConversation");
const P = { away: null };

/* The menu's own items after Open and Mark as unread: Pin to top / Unpin and Rename, then Archive and Delete. */
export function convItems(id) {
  const own = chatOwner(id), s = find(id), pinned = own ? own.pinned : s?.pinned;
  return mi("pin-id", "pin", pinned ? t("accounts.action.unpin") : t("window.shell.extras.pin-to-top"), "", `data-id="${esc(id)}"`)
    + mi("rename-id", "edit", t("accounts.action.rename"), "", `data-id="${esc(id)}"`)
    + mi("conv-archive", "folder", t("window.chat.putaway.archive"), "", `data-id="${esc(id)}"`)
    + mi("conv-delete", "trash", t("window.chat.putaway.delete"), "", `data-id="${esc(id)}"`);
}

/* chat-029 (batch A): the conversation menu's Pin to top / Unpin for an ordinary conversation, through the engine's own
   marks as the row's menu does (POST /api/sessions/<id>/pin). */
export function pinItem(id) {
  return mi("pin-id", "pin", find(id)?.pinned ? t("accounts.action.unpin") : t("window.shell.extras.pin-to-top"), "", `data-id="${esc(id)}"`);
}

/* The two entries at the end of the list, each only while the engine counts something in it (GET /api/sessions). */
export function putAwayEntries() {
  const n = E.putAway ?? {};
  const entry = (v, icon, words, count) => (count ? `<button class="nav pa18" type="button" data-act="putaway" data-v="${v}">${ic(icon)}${words}<span class="cnt">${esc(String(count))}</span></button>` : "");
  const html = entry("archived", "folder", t("window.chat.putaway.archived"), n.archived) + entry("deleted", "trash", t("window.chat.putaway.recently-deleted"), n.deleted);
  return html ? `<div class="pa18-list">${html}</div>` : "";
}

async function pin(id) {
  closePop();
  if (chatOwner(id)) return pinChat(id);
  try { await api(`sessions/${id}/pin`, { pinned: !find(id)?.pinned }); await refresh(); } catch (error) { toast(error.message); }
}

/* `own`: the conversation itself, even a Trunk's own chat (a timeline's line menu, chat/trunkline.js). */
function rename(id, own = false) {
  closePop();
  if (!own && chatOwner(id)) return renameDlg(id);
  const s = find(id);
  openDlg({ title: t("window.chat.putaway.rename-title"), body: `<div class="field"><label for="cv-name">${t("accounts.field.name")}</label><input class="inp" id="cv-name" maxlength="120" value="${esc(s?.title || s?.opening || "")}"></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="conv-rename-save" data-id="${esc(id)}">${t("action.save")}</button>` });
  setTimeout(() => $("#cv-name")?.select(), 0);
}
export const renameConversation = (id) => rename(id, true);
/* In the name box Enter saves and Esc leaves it as it was. */
function renameKeys(e) {
  if (e.target.id !== "cv-name") return;
  if (e.key === "Enter") { e.preventDefault(); $('[data-act="conv-rename-save"]')?.click(); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDlg(); }
}
async function renameSave(el) {
  const title = ($("#cv-name")?.value ?? "").trim();
  try { await api(`sessions/${el.dataset.id}/rename`, { title: title || null }); await refresh(); closeDlg(); } catch (error) { toast(error.message); }
}

/* A conversation with a task still going: the engine's own words, and the choice to stop the task (POST /api/runs/<id>/cancel). */
function askToStop(id, error) {
  const running = (E.state?.runs ?? []).filter((r) => r.sessionId === id && ["running", "needs_input"].includes(r.status));
  if (!running.length) return toast(error.message);
  openDlg({ title: t("window.chat.putaway.stop-it"), body: `<p>${esc(error.message)}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="conv-stop" data-v="${esc(running.map((r) => r.id).join(","))}">${t("window.chat.putaway.stop-it")}</button>` });
}
async function stopRuns(el) {
  try { for (const run of el.dataset.v.split(",")) await api(`runs/${run}/cancel`, {}); closeDlg(); await refresh(); } catch (error) { toast(error.message); }
}

async function archive(id, archived = true) {
  closePop();
  try { await api(`sessions/${id}/archive`, { archived }); } catch (error) { return archived ? askToStop(id, error) : toast(error.message); }
  if (archived) leaveRecent(id, "archived");
  toast(archived ? t("window.chat.putaway.archived-toast") : t("window.chat.putaway.unarchived"), archived ? () => archive(id, false) : undefined);
  await refresh().catch((error) => toast(error.message));
  if (P.away) await openList(P.away.kind);
}
/* Once the engine has put it away, its row leaves Recent at once and the entry counts it, before the list is read again. */
function leaveRecent(id, where) {
  if (S.chat === id) S.chat = null;
  E.sessions = E.sessions.filter((s) => sid(s) !== id);
  E.putAway = { ...E.putAway, [where]: (E.putAway?.[where] ?? 0) + 1 };
  document.dispatchEvent(new CustomEvent("conv-put-away", { detail: id })); // trunk-one-row: its timeline moves on (chat/chat.js)
  renderNow();
}

async function remove(id) {
  closePop();
  try { await api(`sessions/${id}/delete`, {}); } catch (error) { return askToStop(id, error); }
  leaveRecent(id, "deleted");
  toast(t("window.chat.putaway.moved"), () => restore(id));
  await refresh().catch((error) => toast(error.message));
}

async function restore(id) {
  try { await api(`sessions/${id}/restore`, {}); await refresh(); } catch (error) { return toast(error.message); }
  if (P.away) await openList(P.away.kind);
  toast(t("window.chat.putaway.restored"));
}

const daysLeft = (n) => (n === 1 ? t("window.chat.putaway.day-left") : t("window.chat.putaway.days-left", { count: n }));
function listRow(kind, row) {
  const id = esc(row.sessionId), sub = kind === "deleted" ? daysLeft(row.daysLeft) : "";
  const acts = kind === "deleted"
    ? `<button class="btn sm" type="button" data-act="conv-restore" data-id="${id}">${t("window.chat.putaway.restore")}</button><button class="btn ghost sm bad" type="button" data-act="conv-delnow" data-id="${id}">${t("window.chat.putaway.delete-now")}</button>`
    : `<button class="btn sm" type="button" data-act="chat" data-id="${id}">${t("ov.open")}</button><button class="btn ghost sm" type="button" data-act="conv-unarchive" data-id="${id}">${t("window.chat.putaway.unarchive")}</button>`;
  return `<div class="prow" data-pa="${id}"><span class="grow"><b>${esc(titleOf(row))}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</span>${acts}</div>`;
}
/* Every page of one list (GET /api/sessions/put-away?kind=&offset=), in the engine's order, until it says there is no more. */
export async function allOf(kind) {
  const rows = [];
  for (let offset = 0; offset !== null && rows.length < 100000;) {
    const page = await api(`sessions/put-away?kind=${kind}&offset=${offset}`);
    rows.push(...(page[kind] ?? []));
    offset = page.next?.[kind] ?? null;
  }
  return rows;
}
/* Archived or Recently Deleted, each row with its days left, Restore and Delete now. */
async function openList(kind) {
  let rows;
  try { rows = await allOf(kind); } catch (error) { return toast(error.message); }
  P.away = { kind, rows };
  if (!rows.length) { P.away = null; closeDlg(); return; }
  openDlg({ title: kind === "deleted" ? t("window.chat.putaway.recently-deleted") : t("window.chat.putaway.archived"),
    body: `<div class="rows">${rows.map((row) => listRow(kind, row)).join("")}</div>`,
    foot: kind === "deleted" ? `<button class="btn ghost bad" type="button" data-act="conv-delall">${t("window.chat.putaway.delete-all")}</button><button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` : `<button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}

const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
/* Delete now asks first, listing exactly what goes (GET /api/sessions/<id>/delete-now). */
async function askDeleteNow(id) {
  let what;
  try { what = await api(`sessions/${id}/delete-now`); } catch (error) { return toast(error.message); }
  /* Only what there is: no files, no line about files. */
  const files = what.files.length ? `<p>${t("window.chat.putaway.now-files")}</p><ul class="pa18-files">${what.files.map((f) => `<li>${esc(f.name)} <small>${esc(size(f.bytes))}</small></li>`).join("")}</ul>` : "";
  const counts = { messages: tc("window.chat.putaway.now-messages", what.messages), tasks: tc("window.chat.putaway.now-tasks", what.tasks) };
  /* What its tasks left elsewhere and goes with it: facts memory learned only here, to-dos, board cards, earlier file versions. */
  const also = ["facts", "todos", "cards", "versions"].map((k) => ((what[k] ?? []).length ? `<p>${t(`window.chat.putaway.now-${k}`)}</p><ul class="pa18-files">${what[k].map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "")).join("");
  /* An outside memory service its tasks sent something to keeps it: Branch cannot remove it there, and says so. */
  const outside = (what.outside ?? []).length ? `<p>${esc(t("window.chat.putaway.now-outside", { services: what.outside.join(", ") }))}</p>` : "";
  openDlg({ title: t("window.chat.putaway.now-title"), body: `<p>${esc(t("window.chat.putaway.now-body", counts))}</p>${files}${also}${outside}`,
    foot: `<button class="btn ghost" type="button" data-act="putaway" data-v="deleted">${t("first-run-steps.restore-no")}</button><button class="btn pri bad" type="button" data-act="conv-delnow-go" data-id="${esc(id)}">${t("window.chat.putaway.delete-now")}</button>` });
}
async function deleteNow(id) {
  try { await api(`sessions/${id}/delete-now`, {}); await refresh(); } catch (error) { return toast(error.message); }
  toast(t("window.chat.putaway.gone"));
  await openList("deleted");
}
function askDeleteAll() {
  const count = P.away?.rows.length ?? 0;
  openDlg({ title: t("window.chat.putaway.all-title"), body: `<p>${esc(tc("window.chat.putaway.all-body", count))}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="putaway" data-v="deleted">${t("first-run-steps.restore-no")}</button><button class="btn pri bad" type="button" data-act="conv-delall-go">${t("window.chat.putaway.delete-all")}</button>` });
}
async function deleteAll() {
  let done;
  try { done = await api("sessions/put-away/empty", {}); await refresh(); } catch (error) { return toast(error.message); }
  toast(t("window.chat.putaway.all-gone", { count: done.deleted }));
  await openList("deleted");
}

/* Swipe on touch: left is Delete, right is Pin to top; the row follows the finger and a swipe is not also a click. */
const SW = { row: null, x: 0, y: 0, dx: 0, swiped: 0 };
function swipeStart(e) {
  const row = e.pointerType === "touch" && e.target.closest?.("#side .row[data-id]");
  if (!row) return;
  Object.assign(SW, { row, x: e.clientX, y: e.clientY, dx: 0 });
}
function swipeMove(e) {
  if (!SW.row) return;
  const dx = e.clientX - SW.x;
  if (Math.abs(e.clientY - SW.y) > 24 && Math.abs(dx) < 24) { swipeEnd(); return; }
  SW.dx = dx;
  SW.row.classList.add("swiping18");
  SW.row.style.setProperty("--swipe", `${Math.max(-120, Math.min(120, dx))}px`);
}
function swipeEnd() {
  const { row, dx } = SW;
  SW.row = null;
  if (!row) return;
  row.classList.remove("swiping18");
  row.style.removeProperty("--swipe");
  if (Math.abs(dx) < 72) return;
  SW.swiped = Date.now();
  // trunk-one-row: a Trunk's row is the Trunk, not one conversation: right pins it, left deletes nothing.
  if (row.dataset.line) { if (dx > 0) pinLine(row.dataset.line); return; }
  if (dx < 0) remove(row.dataset.id); else pin(row.dataset.id);
}
function noClickAfterSwipe(e) {
  if (Date.now() - SW.swiped < 400 && e.target.closest?.("#side .row[data-id]")) { e.preventDefault(); e.stopPropagation(); }
}

export function initPutAway() {
  markLive(["sw:cv-name", "pin-id", "rename-id", "conv-archive", "conv-delete", "putaway", "conv-restore", "conv-unarchive", "conv-delnow", "conv-delnow-go", "conv-delall", "conv-delall-go", "conv-rename-save", "conv-stop", "conv-more"]);
  on("pin-id", (el) => pin(el.dataset.id));
  on("rename-id", (el) => rename(el.dataset.id));
  on("conv-rename-save", (el) => renameSave(el));
  on("conv-archive", (el) => archive(el.dataset.id));
  on("conv-delete", (el) => remove(el.dataset.id));
  on("conv-stop", (el) => stopRuns(el));
  on("putaway", (el) => { closePop(); openList(el.dataset.v); });
  on("conv-restore", (el) => restore(el.dataset.id));
  on("conv-unarchive", (el) => archive(el.dataset.id, false));
  on("conv-delnow", (el) => askDeleteNow(el.dataset.id));
  on("conv-delnow-go", (el) => deleteNow(el.dataset.id));
  on("conv-delall", () => askDeleteAll());
  on("conv-delall-go", () => deleteAll());
  document.addEventListener("pointerdown", swipeStart);
  document.addEventListener("pointermove", swipeMove);
  document.addEventListener("pointerup", swipeEnd);
  document.addEventListener("pointercancel", () => { if (SW.row) { SW.dx = 0; swipeEnd(); } });
  document.addEventListener("click", noClickAfterSwipe, true);
  document.addEventListener("keydown", renameKeys, true);
  renderNow();
}
