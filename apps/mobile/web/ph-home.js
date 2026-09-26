/**
 * Home (the prototype's phHome): what needs you, what is working, what is left, the quick actions, what finished,
 * and which Branch this is. Allow answers exactly the question shown (POST /api/policy/approve by session and
 * fingerprint, once, and the task carries on); a question without a fingerprint only offers Look first.
 */
import { E, P, attempt, av, big, esc, firstLine, go, ic, on, post, soon, time, w } from "/ph-core.js";
import { asks, exact, finished, loadGateway, loadGlance, loadReach, loadSessions, loadState, loadTrunks, loadWaiting, nameFor, working } from "/ph-data.js";
import { switchesNow } from "/ph-switches.js";

const who = (sessionId, fallback) => nameFor(sessionId) || fallback || "Branch";
/** Good morning, afternoon or evening, by this phone's clock. */
function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return w("phone8.home.morning", "Good morning");
  if (hour < 18) return w("phone8.home.afternoon", "Good afternoon");
  return w("phone8.home.evening", "Good evening");
}
function needCard(q) {
  const allow = exact(q) ? `<button type="button" class="p-pri" data-act="allow" data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint)}">${w("window.settings.permissions.rule-allow", "Allow")}</button>` : "";
  return `<div class="p-card8 need8">${av(who(q.sessionId), 34)}<span class="grow"><b>${esc(who(q.sessionId))}</b><span>${esc(q.question || q.label)}</span>
    <span class="pa">${allow}<button type="button" data-act="open" data-id="${esc(q.sessionId)}">${w("phone8.home.look", "Look first")}</button></span></span></div>`;
}
const calm = (key, english) => `<div class="p-card8 calm8">${ic("check", "s")}<span>${w(key, english)}</span></div>`;
function workCard(run) {
  const name = who(run.sessionId, firstLine(run.prompt, 40));
  return `<button type="button" class="p-card8 work8" data-act="open" data-id="${esc(run.sessionId)}"><span class="p-row8">${av(name, 30)}<span class="grow"><b>${esc(name)}</b><small>${esc(firstLine(run.prompt))}</small></span></span></button>`;
}
/** One ring per measured window of the connection used next (GET /api/usage/glance), as the prototype's ring8. */
function ring(pct, label, sub) {
  return `<div class="ring8"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.5" class="rb"/><circle cx="18" cy="18" r="15.5" class="rf" data-dash="${pct}"/></svg><b>${pct}%</b><span>${esc(label)}</span><small>${esc(sub)}</small></div>`;
}
function leftCard() {
  const rows = E.glance?.rows ?? [];
  const row = rows.find((r) => r.inUse && r.windows?.some((x) => x.limit && x.remaining != null)) ?? rows.find((r) => r.windows?.some((x) => x.limit && x.remaining != null));
  if (!row) return E.glance?.summary ? `<div class="p-card8 calm8"><span>${esc(E.glance.summary)}</span></div>` : "";
  const windows = row.windows.filter((x) => x.limit && x.remaining != null).slice(0, 2);
  const rings = windows.map((x) => ring(Math.max(0, Math.min(100, Math.round((x.remaining / x.limit) * 100))), row.connectionName, x.title)).join("");
  const note = row.inUse ? `<small class="p-note8">${w("phone8.home.usedNext", "{name} is used next. When it runs low, Branch moves to the next account.", { name: row.accountLabel || row.connectionName })}</small>` : "";
  return `<div class="p-card8 rings8">${rings}${note}</div>`;
}
function quick() {
  const talk = switchesNow().voice !== "off";
  const items = [["new", "plus", "phone8.home.new", "New chat", ""], ["voice", "wave", "phone8.home.talk", "Talk", talk ? "" : soon],
    ["scan", "camera", "phone8.home.scan", "Scan", ""], ["go", "clock", "place.automations", "Automations", 'data-v="automations"']];
  return `<div class="p-quick8">${items.map(([a, i, k, e, x]) => `<button type="button" data-act="${a}" ${x}>${ic(i)}<span>${w(k, e)}</span></button>`).join("")}</div>`;
}
function doneList() {
  const done = finished().slice(0, 3);
  if (!done.length) return "";
  return `<div class="p-list">${done.map((r) => `<button type="button" class="p-li" data-act="open" data-id="${esc(r.sessionId)}">${av(who(r.sessionId), 28)}<span class="grow"><b>${esc(who(r.sessionId, firstLine(r.prompt, 40)))}</b><small>${esc(firstLine(r.output))}</small></span><span class="p-val">${esc(time(r.updatedAt))}</span></button>`).join("")}</div>`;
}
function branchCard() {
  const name = E.reach?.machineName;
  const title = name ? w("phone8.home.branchOn", "Branch on {name}", { name }) : "Branch";
  const line = E.gateway ? (E.gateway.on ? w("phone8.home.gwOn", "Gateway on: reachable when the window is closed") : w("phone8.home.gwOff", "Gateway off: reachable while the app is open")) : "";
  return `<div class="p-card8 branch8"><span class="p-ok">●</span><span class="grow"><b>${title}</b><small>${line}</small></span></div>`;
}

export function drawHome() {
  const waiting = asks();
  const run = working();
  return big(greeting(), '<img class="p-sprite" src="/assets/keepoak-mark.png" alt="">') + `<div class="p-scroll">
    <div class="p-sec8"><span>${w("place.inbox.needs", "Needs you")}</span>${waiting.length ? `<em>${waiting.length}</em>` : ""}</div>
    ${waiting.length ? waiting.slice(0, 2).map(needCard).join("") : calm("phone8.home.calm", "Nothing needs you. Nice.")}
    <div class="p-sec8"><span>${w("panels.state.running", "Working now")}</span></div>
    ${run.length ? run.map(workCard).join("") : calm("phone8.home.idle", "Nothing is running.")}
    <div class="p-sec8"><span>${w("phone8.home.left", "What’s left")}</span><button type="button" class="p-link8" data-act="go" data-v="usage">${w("phone8.home.allAccounts", "All accounts")}</button></div>
    ${leftCard()}${quick()}
    <div class="p-sec8"><span>${w("place.inbox.finished", "Finished")}</span></div>${doneList()}${branchCard()}</div>`;
}
export const loadHome = () => Promise.all([loadState(), loadWaiting(), loadSessions(), loadTrunks(), loadGlance(), loadReach(), loadGateway()]);

/** Allow, once, for exactly the request shown; the task carries on by itself. */
export async function allow(sessionId, fingerprint, decision = "allow") {
  await attempt(async () => {
    await post("/api/policy/approve", { sessionId, decision, remember: "never", fingerprint, carryOn: true });
    await Promise.all([loadWaiting(), loadState()]);
  });
}
export function initHome() {
  on("allow", (el) => allow(el.dataset.sid, el.dataset.fp));
  on("deny", (el) => allow(el.dataset.sid, el.dataset.fp, "deny"));
  on("go", (el) => go(el.dataset.v));
  on("open", (el) => { if (!el.dataset.id) return; P.chat = el.dataset.id; go(el.dataset.to || "chat"); });
}
