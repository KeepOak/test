/**
 * More and the places behind it (the prototype's phMore, phPlace and phProfile):
 *   Automations   the scheduled jobs (GET /api/state schedules); their on/off switch has no engine route and is drawn,
 *                 not live; check-ins from GET /api/heartbeat
 *   Library       Memory (GET /api/state memory; Forget is the engine's memory.delete through POST /api/action, as
 *                 the window's) and Documents (GET /api/documents)
 *   Trunks        GET /api/trunks; a Trunk's page pauses or resumes it (POST /api/trunks/<id>/pause|resume)
 *   What's left   GET /api/usage/glance, a bar only where the service gave a limit, else the engine's own sentence
 * Team (a keepoak.com team), the keepoak.com sign-in and New Trunk are drawn and not live.
 */
import { E, P, attempt, av, big, draw, esc, firstLine, get, ic, ios, nav, on, post, say, soon, time, w } from "/ph-core.js";
import { loadDocuments, loadGlance, loadHeartbeat, loadState, loadTrunks, trunkOf } from "/ph-data.js";

const li = (act, v, icon, key, english, value, extra = "") => `<button type="button" class="p-li" data-act="${act}" data-v="${v}" ${extra}><span class="p-ico8">${ic(icon, "s")}</span><span class="grow"><b>${w(key, english)}</b></span><span class="p-val">${value}</span>›</button>`;
export function drawMore() {
  const trunks = E.trunks?.trunks ?? [], schedules = E.state?.schedules ?? [];
  const account = `<div class="p-list"><button type="button" class="p-li" ${soon}><img class="p-ko" src="/assets/keepoak-mark.png" alt=""><span class="grow"><b>${w("phone8.more.signin", "Sign in with keepoak.com")}</b><small>${w("phone8.more.signinNote", "Your computers and your team, everywhere")}</small></span>›</button></div>`;
  const places = [li("go", "team", "users", "phone8.more.team", "Team", "", soon), li("go", "automations", "clock", "place.automations", "Automations", esc(String(schedules.length))),
    li("go", "library", "book", "place.library", "Library", w("phone8.more.libraryNote", "Memory and documents")), li("go", "trunks", "sliders", "phone8.chats.trunks", "Trunks", esc(String(trunks.length))),
    li("go", "usage", "spark", "phone8.home.left", "What’s left", w("phone8.more.leftNote", "5-hour and weekly limits"))].join("");
  const end = li("go", "settings", "gear", "nav.settings", "Settings", "") + li("go", "widgets", "layers", "phone8.more.widgets", "Home-screen widgets", "");
  return big(w("more.label", "More")) + `<div class="p-scroll">${account}<div class="p-list">${places}</div><div class="p-list">${end}</div></div>`;
}
export const loadMore = () => Promise.all([loadState(), loadTrunks()]);

function drawAutomations() {
  const rows = (E.state?.schedules ?? []).map((s) => `<div class="p-li">${av(firstLine(s.data?.prompt, 20), 26)}<span class="grow"><b>${esc(firstLine(s.data?.prompt, 80))}</b><small>${esc(time(s.data?.dueAt))}</small></span><input type="checkbox" class="p-sw8" ${soon} aria-label="${esc(firstLine(s.data?.prompt, 80))}"></div>`).join("");
  const every = E.heartbeat?.heartbeat?.settings?.everyMinutes, on = E.heartbeat?.switches?.checkIn && E.heartbeat.switches.checkIn !== "off";
  const check = E.heartbeat ? `<div class="p-group-h">${w("phone8.auto.checkins", "Check-ins")}</div><div class="p-list"><div class="p-li"><span class="grow"><b>${on && every ? w("ov.every", "Every {n} min", { n: every }) : "—"}</b><small>${w("phone8.auto.news", "Speaks up only with news")}</small></span></div></div>` : "";
  return nav(say("place.automations", "Automations"), say("more.label", "More")) + `<div class="p-scroll">${rows ? `<div class="p-list">${rows}</div>` : ""}${check}</div>`;
}
function drawLibrary() {
  const tabs = [["memory", "nav.memory", "Memory"], ["docs", "phone8.lib.docs", "Documents"]];
  const memory = (E.state?.memory ?? []).slice(0, 40).map((m) => `<div class="p-li"><span class="grow"><b>${esc(firstLine(m.text ?? m.content ?? m.fact ?? "", 120))}</b><small>${esc(m.category ?? m.kind ?? "")}</small></span><button type="button" class="p-x8" data-act="forget" data-id="${esc(m.id)}" aria-label="${w("window.places.library.forget", "Forget")}">${ic("x", "s")}</button></div>`).join("");
  const docs = (E.documents ?? []).map((d) => `<div class="p-li">${ic("doc", "s")}<span class="grow"><b>${esc(d.name ?? d.title ?? "")}</b><small>${esc(time(d.createdAt ?? d.addedAt))}</small></span></div>`).join("");
  const body = P.libTab === "docs" ? docs : memory;
  return nav(say("place.library", "Library"), say("more.label", "More")) + `<div class="p-scroll"><div class="p-seg8">${tabs.map(([v, k, e]) => `<button type="button" data-act="ph-lib" data-v="${v}" aria-pressed="${P.libTab === v}">${w(k, e)}</button>`).join("")}</div>${body ? `<div class="p-list">${body}</div>` : ""}</div>`;
}
function drawTrunks() {
  const rows = (E.trunks?.trunks ?? []).map((t) => `<button type="button" class="p-li" data-act="open" data-id="${esc(t.chatSessionId ?? "")}" data-to="profile" ${t.chatSessionId ? "" : soon}>${av(t.name, 32)}<span class="grow"><b>${esc(t.name)}${t.paused ? w("phone8.trunks.paused", " · paused") : ""}</b><small>${esc(t.title ?? "")}</small></span>›</button>`).join("");
  return nav(say("phone8.chats.trunks", "Trunks"), say("more.label", "More")) + `<div class="p-scroll">${rows ? `<div class="p-list">${rows}</div>` : ""}<button type="button" class="p-big" ${soon}>${w("studio.newName", "New Trunk")}</button></div>`;
}
function windowLine(x) {
  if (!x.limit || x.remaining == null) return "";
  const pct = Math.max(0, Math.min(100, Math.round((x.remaining / x.limit) * 100)));
  return `<small>${w("phone8.usage.left", "{title}: {pct}% left", { title: x.title, pct })}${x.resetAt ? ` · ${esc(time(x.resetAt))}` : ""}</small><span class="meter6"><u data-w="${pct}"></u></span>`;
}
function drawUsage() {
  const cards = (E.glance?.rows ?? []).map((r) => {
    const lines = (r.windows ?? []).map(windowLine).join("");
    return `<div class="p-card8 use8"><span class="grow"><b>${esc(r.connectionName)}${r.accountLabel ? ` · ${esc(r.accountLabel)}` : ""}</b>${lines || `<small>${esc(r.note || say("phone8.usage.none", "This service doesn’t publish what’s left."))}</small>`}</span></div>`;
  }).join("");
  return nav(say("phone8.home.left", "What’s left"), say("more.label", "More")) + `<div class="p-scroll">${cards || (E.glance?.summary ? `<p class="p-empty">${esc(E.glance.summary)}</p>` : "")}</div>`;
}
function drawProfile() {
  const t = trunkOf(P.chat);
  if (!t) return nav("", say("phone8.tab.chats", "Chats"));
  const rows = [["monitor", "phone8.profile.computer", "Its computer", "", soon], ["book", "phone8.profile.remembers", "What it remembers", say("place.library", "Library"), 'data-act="go" data-v="library"']]
    .map(([i, k, e, v, x]) => `<button type="button" class="p-li" ${x}>${ic(i, "s")}<span class="grow"><b>${w(k, e)}</b></span><span class="p-val">${esc(v)}</span>›</button>`).join("");
  const pause = `<button type="button" class="p-li" data-act="pausetrunk" data-id="${esc(t.id)}" data-v="${t.paused ? "resume" : "pause"}"><span class="grow"><b>${t.paused ? w("phone8.profile.resume", "Resume {name}", { name: t.name }) : w("window.chat.media.pause", "Pause {name}", { name: t.name })}</b></span></button>`;
  return nav("", t.name) + `<div class="p-scroll"><div class="p-prof8">${av(t.name, 88)}<b>${esc(t.name)}</b><small>${esc(t.title ?? "")}</small></div><div class="p-list">${rows}</div><div class="p-list">${pause}</div></div>`;
}
function drawWidgets() {
  return nav("Home-screen widgets", "More") + `<div class="p-scroll"><p>${ios() ? "Android home-screen widgets are available in the Android app. iOS widgets are not supported." : "On the Android home screen, touch and hold an empty area, choose Widgets, then Branch: one Trunk or Branch: several Trunks. Select one or up to four Trunks and explicitly allow their names, pebble faces and last-known status."}</p><p>No messages, task titles or secrets appear. Tap a face to open its actual Trunk after the phone and owner profile are unlocked. Refresh reads status only; it grants no notification or computer action permission.</p><p>Status is last-known, not live. Android refreshes periodically or when you tap Refresh. Data clears on refusal, unpair, phone screen-off while Branch is running, and a scheduled one-minute expiry. Android may delay expiry while idle; remove a widget to stop sharing its metadata.</p></div>`;
}
export const PLACES = { automations: drawAutomations, library: drawLibrary, trunks: drawTrunks, usage: drawUsage, profile: drawProfile, widgets: drawWidgets };
export const PLACE_LOADS = {
  automations: () => Promise.all([loadState(), loadHeartbeat()]), library: () => Promise.all([loadState(), loadDocuments()]),
  trunks: loadTrunks, usage: loadGlance, profile: loadTrunks,
};
export function initMore() {
  on("ph-lib", (el) => { P.libTab = el.dataset.v; draw(); });
  on("forget", (el) => attempt(async () => { await post("/api/action", { tool: "memory.delete", args: { id: el.dataset.id } }); await loadState(); }));
  on("pausetrunk", (el) => attempt(async () => {
    if (!/^[A-Za-z0-9_-]+$/.test(el.dataset.id)) return;
    await post(`/api/trunks/${el.dataset.id}/${el.dataset.v === "resume" ? "resume" : "pause"}`, {});
    await loadTrunks();
  }));
  void get;
}
