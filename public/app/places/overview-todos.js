/** RES-330/A0635: the owner's existing to-do list, through its existing owner-only routes. */
import { E, S, ownerHere } from "../core/state.js";
import { sessionPrincipal } from "../core/session-pages.js";
import { api, token } from "../core/api.js";
import { esc, renderNow } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { lockdownOn } from "../chat/approvals.js";
import { t, language } from "../../i18n.js";

const T = { who: null, rows: null, snapshot: null, error: null, serial: 0, loading: false, busy: new Set(), removal: null, dialogWho: null };
const who = () => JSON.stringify([sessionPrincipal(E.profiles), S.signedIn, token.get()]);
const current = (identity) => ownerHere() && identity === who();
const writable = () => current(T.who) && !lockdownOn();
const text = (key, values) => t(`window.places.owner-todos.${key}`, values);
function scoped() {
  const identity = who();
  if (!ownerHere() || T.who !== identity) {
    Object.assign(T, { who: identity, rows: null, snapshot: null, error: null, loading: false, busy: new Set(), removal: null });
    ++T.serial;
  }
  return ownerHere();
}
export async function loadOwnerTodos(force = false) {
  if (!scoped() || (!force && (T.loading || T.snapshot === E.state))) return false;
  const identity = T.who, serial = ++T.serial;
  T.snapshot = E.state; T.loading = true;
  try {
    const result = await api("todos");
    if (!current(identity) || serial !== T.serial) return false;
    const changed = JSON.stringify(T.rows) !== JSON.stringify(result.todos) || T.error !== null;
    T.rows = result.todos ?? []; T.error = null;
    return changed;
  } catch (error) {
    if (!current(identity) || serial !== T.serial) return false;
    T.error = error.message;
    return true;
  } finally { if (serial === T.serial) T.loading = false; }
}
const moment = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(language()) : "";
};
function row(item, complete = false) {
  const off = !writable() || T.busy.has(item.id), action = item.done ? "reopen" : "done";
  const by = text(item.source === "owner" ? "by-you" : "by-assistant");
  return `<div class="prow"><span class="grow"><b>${esc(item.text)}</b><small>${esc(by)}${item.dueAt ? ` - ${esc(text("due", { date: moment(item.dueAt) }))}` : ""}</small></span><button class="btn ghost sm" type="button" data-act="owner-todo-done" data-id="${esc(item.id)}" ${off ? "disabled" : ""} aria-label="${esc(text(action + "-label", { item: item.text }))}">${esc(text(action))}</button>${complete ? `<button class="btn ghost sm" type="button" data-act="owner-todo-remove" data-id="${esc(item.id)}" ${off ? "disabled" : ""} aria-label="${esc(text("remove-label", { item: item.text }))}">${esc(text("remove"))}</button>` : ""}</div>`;
}
export function ownerTodosTile() {
  if (!scoped()) return "";
  const open = (T.rows ?? []).filter((item) => !item.done);
  const content = T.error ? `<p role="status">${esc(T.error)}</p>` : T.rows === null ? `<p role="status">${t("live.working")}</p>` : open.length ? open.slice(0, 6).map((item) => row(item)).join("") : `<p class="hint">${esc(text("empty"))}</p>`;
  return `<section class="tile"><h2>${esc(text("title"))}</h2>${content}<div class="acts"><button class="btn sm" type="button" data-act="owner-todo-add" ${writable() && !T.busy.has("add") ? "" : "disabled"}>${esc(text("add"))}</button><button class="btn ghost sm" type="button" data-act="owner-todo-list">${esc(text("view"))}</button></div></section>`;
}
function showList() {
  if (!scoped()) return;
  T.dialogWho = T.who;
  const items = T.rows ?? [], open = items.filter((item) => !item.done), done = items.filter((item) => item.done);
  openDlg({ title: text("title"), body: `${T.error ? `<p role="status">${esc(T.error)}</p>` : ""}<p class="hint">${esc(text("list-note"))}</p>${open.length ? open.map((item) => row(item, true)).join("") : `<p>${esc(text("empty"))}</p>${done.length ? `<details><summary>${esc(text("completed", { count: done.length }))}</summary>${done.map((item) => row(item, true)).join("")}</details>` : ""}`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}
function addDialog() {
  if (!writable()) return;
  T.dialogWho = T.who;
  openDlg({ title: text("add"), body: `<label class="fld"><span>${esc(text("item"))}</span><textarea class="inp" id="owner-todo-text" maxlength="300" rows="3"></textarea></label><label class="fld"><span>${esc(text("due-field"))}</span><input class="inp" id="owner-todo-due" type="datetime-local"></label><p class="hint">${esc(text("due-note"))}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("updates.busy.cancel")}</button><button class="btn pri" type="button" data-act="owner-todo-save">${esc(text("add"))}</button>` });
}
async function change(key, path, body, method, done) {
  if (!writable() || T.busy.has(key)) return;
  const identity = T.who;
  T.busy.add(key); ++T.serial; T.loading = false;
  try {
    await api(path, body, method);
    if (!current(identity)) return;
    done?.();
    await loadOwnerTodos(true);
  } catch (error) { if (current(identity)) toast(error.message); }
  finally { T.busy.delete(key); if (current(identity)) renderNow(); }
}
async function save(el) {
  if (!current(T.dialogWho) || !el.isConnected || el.closest(".scrim") !== dialog()) return;
  const words = dialog()?.querySelector("#owner-todo-text")?.value.trim();
  const due = dialog()?.querySelector("#owner-todo-due")?.value;
  if (!words) return;
  const when = due ? new Date(due) : null;
  if (when && !Number.isFinite(when.getTime())) return;
  el.disabled = true;
  try { await change("add", "todos", { text: words, ...(when ? { dueAt: when.toISOString() } : {}) }, undefined, () => { if (el.isConnected) closeDlg(); }); }
  finally { if (el.isConnected) el.disabled = false; }
}
function removeDialog(el) {
  if (!writable()) return;
  const item = T.rows?.find((entry) => entry.id === el.dataset.id);
  if (!item) return;
  T.removal = item.id; T.dialogWho = T.who;
  openDlg({ title: text("remove"), body: `<p>${esc(text("remove-question", { item: item.text }))}</p>`, foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("updates.busy.cancel")}</button><button class="btn bad" type="button" data-act="owner-todo-confirm">${esc(text("remove"))}</button>` });
}
let started = false;
export function initOwnerTodos() {
  if (started) return; started = true;
  on("owner-todo-add", () => addDialog());
  on("owner-todo-list", () => showList());
  on("owner-todo-save", (el) => save(el));
  on("owner-todo-done", async (el) => {
    const item = T.rows?.find((entry) => entry.id === el.dataset.id);
    if (!item) return;
    await change(item.id, `todos/${encodeURIComponent(item.id)}/done`, { done: !item.done }, undefined, () => { if (el.closest(".scrim") === dialog()) closeDlg(); });
  });
  on("owner-todo-remove", (el) => removeDialog(el));
  on("owner-todo-confirm", async (el) => {
    if (!current(T.dialogWho) || !el.isConnected || el.closest(".scrim") !== dialog() || !T.removal) return;
    const id = T.removal;
    el.disabled = true;
    try { await change(id, `todos/${encodeURIComponent(id)}`, undefined, "DELETE", () => { if (el.isConnected) closeDlg(); if (T.removal === id) T.removal = null; }); }
    finally { if (el.isConnected) el.disabled = false; }
  });
  markLive(["owner-todo-add", "owner-todo-list", "owner-todo-save", "owner-todo-done", "owner-todo-remove", "owner-todo-confirm"]);
}
