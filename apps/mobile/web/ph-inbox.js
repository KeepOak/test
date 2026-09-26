/**
 * Inbox (the prototype's phInbox): Needs you, Finished, History.
 *   Needs you   each question (GET /api/policy waiting) with Yes / No for exactly that request (POST /api/policy/approve,
 *               fingerprint, once); each Trunk message (GET /api/state trunkWaiting) with Yes / No (POST
 *               /api/trunks/messages/<id>/answer or /decline). "Allow all N" opens a sheet that lists every request it
 *               will answer, each once, as the window's Allow all does; only for the owner, only fingerprinted questions.
 *   Finished    the tasks that completed (GET /api/state runs), History every task by time.
 */
import { E, P, attempt, av, big, draw, esc, firstLine, on, post, time, w } from "/ph-core.js";
import { allow } from "/ph-home.js";
import { asks, exact, finished, loadProfiles, loadSessions, loadState, loadTrunks, loadWaiting, nameFor, runs, trunkWaiting } from "/ph-data.js";

const who = (sessionId) => nameFor(sessionId) || "Branch";
const trunkName = (id) => (E.trunks?.trunks ?? []).find((t) => t.id === id || t.name === id)?.name ?? id ?? "";
function askCard(q) {
  const buttons = exact(q) ? `<span class="pa"><button type="button" class="p-pri" data-act="allow" data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint)}">${w("rooms.yes", "Yes")}</button><button type="button" data-act="deny" data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint)}">${w("phone8.inbox.no", "No")}</button></span>`
    : `<span class="pa"><button type="button" data-act="open" data-id="${esc(q.sessionId)}">${w("phone8.home.look", "Look first")}</button></span>`;
  return `<div class="p-card8 need8">${av(who(q.sessionId), 32)}<span class="grow"><b>${esc(who(q.sessionId))}</b><span>${esc(q.question || q.label)}</span>${q.target ? `<small>${esc(q.target)}</small>` : ""}${buttons}</span></div>`;
}
function messageCard(m) {
  return `<div class="p-card8 need8">${av(trunkName(m.from), 32)}<span class="grow"><b>${esc(trunkName(m.from))} → ${esc(trunkName(m.to))}</b><span>${esc(m.message)}</span>
    <span class="pa"><button type="button" class="p-pri" data-act="tmsg" data-id="${esc(m.id)}" data-v="answer">${w("rooms.yes", "Yes")}</button><button type="button" data-act="tmsg" data-id="${esc(m.id)}" data-v="decline">${w("phone8.inbox.no", "No")}</button></span></span></div>`;
}
/** What Allow all answers: fingerprinted questions and Trunk messages, never on a household person's profile. */
const allowable = () => (E.profiles?.active?.id ? [] : [...asks().filter(exact).map((q) => ({ q })), ...trunkWaiting().map((m) => ({ m }))]);
function needsTab() {
  const cards = asks().map(askCard).join("") + trunkWaiting().map(messageCard).join("");
  const all = allowable().length > 1 ? `<button type="button" class="p-big" data-act="ph-sheet" data-v="allowall">${w("window.places.inbox.allow-all-go", "Allow all {count}", { count: allowable().length })}</button>` : "";
  return (cards || `<p class="p-empty">${w("ov.needs.none", "Nothing needs you.")}</p>`) + all;
}
function doneTab() {
  return `<div class="p-list">${finished().slice(0, 30).map((r) => `<button type="button" class="p-li" data-act="open" data-id="${esc(r.sessionId)}">${av(who(r.sessionId), 28)}<span class="grow"><b>${esc(firstLine(r.prompt))}</b><small>${esc(who(r.sessionId))}</small></span><span class="p-val">${esc(time(r.updatedAt))}</span></button>`).join("")}</div>`;
}
function historyTab() {
  return `<ol class="p-tl8">${runs().slice(0, 40).map((r) => `<li><time>${esc(time(r.createdAt))}</time>${esc(firstLine(r.prompt))}</li>`).join("")}</ol>`;
}
export function drawInbox() {
  const n = asks().length + trunkWaiting().length;
  const tabs = [["needs", "place.inbox.needs", "Needs you"], ["done", "place.inbox.finished", "Finished"], ["hist", "place.inbox.history", "History"]];
  const seg = `<div class="p-seg8">${tabs.map(([v, k, e]) => `<button type="button" data-act="ph-in" data-v="${v}" aria-pressed="${P.inTab === v}">${w(k, e)}${v === "needs" && n ? ` · ${n}` : ""}</button>`).join("")}</div>`;
  const body = P.inTab === "done" ? doneTab() : P.inTab === "hist" ? historyTab() : needsTab();
  return big(w("place.inbox", "Inbox")) + `<div class="p-scroll">${seg}${body}</div>`;
}
export const loadInbox = () => Promise.all([loadWaiting(), loadState(), loadSessions(), loadTrunks(), loadProfiles()]);

/** The sheet Allow all opens: every request it answers, by name, then one button. */
export function allowAllSheet() {
  const items = allowable();
  const rows = items.map(({ q, m }) => `<div class="p-li"><span class="grow"><b>${esc(q ? q.question || q.label : m.message)}</b><small>${esc(q ? who(q.sessionId) : trunkName(m.from))}</small></span></div>`).join("");
  return `<b>${w("window.places.inbox.allow-all-question", "Allow all {count}?", { count: items.length })}</b><div class="p-list">${rows}</div>
    <button type="button" class="p-big" data-act="allowall-go">${w("window.places.inbox.allow-all-go", "Allow all {count}", { count: items.length })}</button>`;
}
async function allowAll() {
  const items = allowable();
  P.sheet = null;
  await attempt(async () => {
    for (const { q, m } of items) {
      if (q) await post("/api/policy/approve", { sessionId: q.sessionId, decision: "allow", remember: "never", fingerprint: q.fingerprint, carryOn: true });
      else await post(`/api/trunks/messages/${encodeURIComponent(m.id)}/answer`, {});
    }
    await Promise.all([loadWaiting(), loadState()]);
  });
}
export function initInbox() {
  on("ph-in", (el) => { P.inTab = el.dataset.v; draw(); });
  on("tmsg", (el) => attempt(async () => {
    if (!/^[A-Za-z0-9_-]+$/.test(el.dataset.id)) return;
    await post(`/api/trunks/messages/${el.dataset.id}/${el.dataset.v === "answer" ? "answer" : "decline"}`, {});
    await loadState();
  }));
  on("allowall-go", () => allowAll());
  void allow; // Yes / No use Home's allow (data-act="allow" / "deny")
}
