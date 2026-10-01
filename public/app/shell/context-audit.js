/* Context presentation follows NousResearch/hermes-agent a9a54245b2311c705d29050b7f9868c015917aec,
 * context-usage-panel.tsx and hooks/use-context-breakdown.ts. MIT License.
 * Copyright (c) 2025 Nous Research
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { api } from "../core/api.js";
import { esc, renderNow } from "../core/dom.js";
import { S, E, activeId, ownerHere } from "../core/state.js";
import { sessionAuthority } from "../core/session-pages.js";
import { conversationWho } from "../chat/chat.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openPop, closePop, openDlg, closeDlg, dialog, toast } from "../core/ui.js";

let current = null, state = null, error = "", loading = false, last = 0, generation = 0;
const unlocked = () => S.signedIn && ownerHere() && !document.getElementById("app")?.classList.contains("locked-b17");
const identity = (sid) => `${activeId() ?? "owner"}:${sid}`;
const same = (sid, token) => unlocked() && S.view === "chat" && current === sid
  && conversationWho().sessionId === sid && identity(sid) === key && token === generation;
const endpoint = (sid) => `sessions/${encodeURIComponent(sid)}/context-audit`;
const number = (n) => Number(n).toLocaleString();
const used = (view) => view.reported ?? view.estimated;
const percent = (view) => Math.max(0, Math.min(100, Math.round(used(view) / view.limit * 100)));
let key = "";
/* Sticky owner authority (core/session-pages.js), so a profile switch away and back or a lock and unlock is never
   missed between renders: each read holds its own from request to result, the open panel's spans its read and the
   choice, and the choice's own spans its confirmation, the live read and the write. */
let panel = null, proposal = null;
const authorityNow = () => sessionAuthority(E.profiles, document.getElementById("app"));
const ownPop = () => document.querySelector("#app > .pop")?.dataset.contextAudit !== undefined;
/* A read that outlived its authority: neither its answer nor anything read before it is shown again. */
function forget() {
  generation++; state = null; error = ""; last = Date.now();
  panel?.close(); panel = null;
  if (ownPop()) closePop();
}

async function refresh(sid) {
  if (loading) return;
  const token = generation, authority = authorityNow();
  loading = true; last = Date.now();
  let kept = false;
  try {
    const next = await api(endpoint(sid), undefined, undefined, AbortSignal.timeout(5000));
    kept = authority.current(E.profiles);
    if (kept && same(sid, token)) { state = next; error = ""; }
  } catch (why) { kept = authority.current(E.profiles); if (kept && same(sid, token)) { state = null; error = why.message; } }
  finally {
    authority.close();
    if (token === generation) { if (!kept) forget(); loading = false; renderNow(); }
  }
}

export function contextMeter(sid) {
  const nextKey = sid && unlocked() && S.view === "chat" ? identity(sid) : "";
  if (key !== nextKey) { key = nextKey; current = nextKey ? sid : null; generation++; state = null; error = ""; loading = false; last = 0; }
  if (!nextKey) return "";
  if (Date.now() - last > 5000) refresh(sid);
  const view = state?.available ? state : null;
  const label = view ? `${view.reported === null ? "~" : ""}${percent(view)}%${view.pending ? " · pending" : ""}` : "unknown";
  /* The status bar's collapse (pass 18, styles/context-audit.css): the word goes once the bar is tight and the whole item
     where even the meter has no room, so the running count and the connection are never cut off. */
  return `<button class="sb" type="button" data-act="context-audit" aria-haspopup="dialog" aria-expanded="false" aria-label="Context of the last model request: ${esc(label)}"><span><span class="sbt18c">Context </span>${esc(label)}</span>${view ? `<meter min="0" max="100" value="${percent(view)}" aria-label="Last request fullness" data-css="width:38px"></meter>` : ""}</button>`;
}
function rows(view) {
  const groups = view.categories.map((entry) => `<li>${esc(entry.name)} <span>~${number(entry.tokens)}</span></li>`).join("");
  const definitions = view.definitions.map((entry) => `<li>${esc(entry.name)} <span>~${number(entry.tokens)}</span></li>`).join("");
  const items = view.items.map((item) => `<li><span>${esc(item.name)} · ~${number(item.tokens)} tokens${item.excluded ? " · left out next request" : ""}</span>${item.removable ? `<button class="btn sm" type="button" data-act="context-propose" data-call="${esc(item.callId)}" data-request="${esc(view.requestId)}">${item.excluded ? "Put back" : "Leave out"}</button>` : `<span class="hint">Protected</span>`}</li>`).join("");
  return `<ul>${groups}</ul><details><summary>Tool definitions (kept; ${view.definitions.length} of ${view.totalDefinitions})</summary><ul>${definitions}</ul></details><h4>Tool results (${view.items.length} of ${view.totalItems})</h4><ul>${items || "<li>No tool results in this request.</li>"}</ul>`;
}
function body(view) {
  if (!view?.available) return `<div class="context-audit"><b>Model context</b><p>${esc(error || (loading ? "Reading context…" : "Unknown: no actual model request snapshot is available for this task in this engine process."))}</p><button class="btn" type="button" data-act="context-refresh">Refresh</button></div>`;
  return `<div class="context-audit"><b>Last model request · ${esc(view.model)}</b><p>${view.reported === null ? "~" : ""}${number(used(view))} / ${number(view.limit)} tokens · ${view.reported === null ? "~" : ""}${percent(view)}%</p><p class="hint">${esc(view.basis)}. ${esc(view.limitBasis)}.</p><p>${view.compactions} compactions in this task. Sent ${esc(new Date(view.at).toLocaleTimeString())}.</p>${view.pending ? "<p>Exclusions changed. The sent request is unchanged; the next model request will use your choices.</p>" : ""}${rows(view)}<p class="hint">Category and per-tool counts are estimates of the actual request, not lifetime use. Stored conversation, receipts and approval/audit evidence are retained.</p><button class="btn" type="button" data-act="context-refresh">Refresh</button></div>`;
}
async function show(el) {
  const sid = current, token = generation;
  if (!sid || !same(sid, token)) return;
  if (el.getAttribute("aria-expanded") === "true") { closePop(); return; }
  panel?.close(); panel = authorityNow();
  openPop(el, body(state), { role: "dialog", label: "Model context" });
  const pop = document.querySelector("#app > .pop");
  if (pop) pop.dataset.contextAudit = String(token);
  await refresh(sid);
  repaintPanel(sid, token);
}
function repaintPanel(sid, token) {
  const pop = document.querySelector("#app > .pop"), anchor = document.querySelector('[data-act="context-audit"]');
  if (!same(sid, token) || !panel?.current(E.profiles) || !anchor || pop?.dataset.contextAudit !== String(token)) {
    if (ownPop() && !panel?.current(E.profiles)) forget();
    return;
  }
  closePop(); openPop(anchor, body(state), { role: "dialog", label: "Model context" });
  const next = document.querySelector("#app > .pop");
  if (next) next.dataset.contextAudit = String(token);
}
function propose(el) {
  const sid = current, token = generation, view = state;
  if (el.dataset.request !== view?.requestId) { closePop(); toast("The model request changed. Refresh the context audit."); return; }
  const item = view?.items?.find((entry) => entry.callId === el.dataset.call);
  if (!sid || !same(sid, token) || !panel?.current(E.profiles) || !view?.available || !item?.removable) return;
  closePop();
  openDlg({ title: item.excluded ? "Put this result back in context?" : "Leave this result out of future context?",
    body: `<p>${esc(item.name)} · call ${esc(item.callId)}</p><p>Only future model requests change. The current in-flight request, stored conversation and original tool receipt stay intact. Policy, system instructions, approvals and audit evidence stay protected.</p>`,
    foot: `<button class="btn" type="button" data-act="dlg-close">Cancel</button><button class="btn pri" type="button" data-act="context-confirm">${item.excluded ? "Put back" : "Leave out"}</button>` });
  proposal?.authority.close();
  proposal = { sid, token, view, item, node: dialog(), authority: authorityNow() };
}
async function confirm(el) {
  const p = proposal, owned = () => p.authority.current(E.profiles);
  if (!p || dialog() !== p.node || !same(p.sid, p.token) || !owned()) return;
  el.disabled = true;
  try {
    const live = await api(endpoint(p.sid), undefined, undefined, AbortSignal.timeout(5000));
    if (dialog() !== p.node || !same(p.sid, p.token) || !owned()) return;
    if (!live.available || live.requestId !== p.view.requestId || live.runId !== p.view.runId) throw new Error("The model request changed. Refresh and choose the result again.");
    const next = await api(endpoint(p.sid), { runId: live.runId, requestId: live.requestId, callId: p.item.callId,
      out: !p.item.excluded, confirmed: true });
    if (dialog() !== p.node || !same(p.sid, p.token) || !owned()) return;
    state = next; proposal = null; p.authority.close(); closeDlg(); renderNow(); toast("Future context updated; original receipt retained.");
  } catch (why) { if (dialog() === p.node && same(p.sid, p.token) && owned()) { el.disabled = false; toast(why.message); } }
}
on("context-audit", show); on("context-propose", propose); on("context-confirm", confirm);
on("context-refresh", async () => {
  const sid = current, token = generation;
  if (!sid) return;
  await refresh(sid);
  repaintPanel(sid, token);
});
markLive(["context-audit", "context-propose", "context-confirm", "context-refresh"]);
