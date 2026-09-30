/* Inbox, pass 17 (patch17b.js, SHOWCASE17 rows 6, 113 and 114).
   - Needs you: each task that stopped for want of something (GET /api/adapt stops) as its own card. "What it needs" asks
     the engine what is missing, what would fix it and what that costs (POST /api/adapt/plan, which changes nothing) and
     shows the engine's own sentence. "Leave it stopped" keeps the stop but no longer offers it (POST /api/adapt/leave).
     "Fetch it and carry on" and the pick stay greyed: a yes installs a program through the one button and starts the task
     again, which is for the security review.
   - Later: every job a task handed over to finish later (GET /api/deferred), with its own words and one action for its
     kind, each through POST /api/deferred/settle, which carries its task on in its own conversation: a step you do by
     hand is answered Done; signing is confirmed with I've signed it; work explicitly set aside by user.later is
     continued with Finish now; an outside service can be given up with Stop waiting. The engine validates each action
     against the saved kind. Signing is the person's report, and Finish now queues work rather than claiming it finished.
   - History › Signed receipts: the engine's tamper-evident chain of what happened (GET /api/safety-extras/activity), each
     entry with its fingerprint and the one it links to, the break the engine's own check found (POST
     /api/safety-extras/activity/verify), and "Check this run" reads that run's signed receipts (GET
     /api/runs/<id>/receipts). "What a break looks like" would draw made-up entries, so it stays greyed. */

import { esc, renderNow } from "../core/dom.js";
import { E, activeId, ownerHere, chatFace, ownName } from "../core/state.js";
import { av, toast, openDlg, closeDlg, dialog } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { pill17, prow17, sec17, btn17, when17, short17 } from "./parts17.js";
import { t } from "../../i18n.js";
import { say } from "../core/words.js";

let stops = [];
let deferred = [];
const trunks = () => (Array.isArray(E.trunks) ? E.trunks : []);
/* The Trunk a conversation belongs to, or none. */
export function trunkOf(sessionId) {
  const s = E.sessions.find((x) => (x.sessionId ?? x.id) === sessionId);
  return trunks().find((t) => t.id === s?.trunkId || (t.chatSessionId && t.chatSessionId === sessionId)) ?? null;
}
/* The face and name a conversation is drawn with: its Trunk's, a room's (its stack of members, its name), else Branch's. */
export const faceOf = (sessionId, size) => av(trunkOf(sessionId) ?? chatFace(sessionId), size);
export const nameOf = (sessionId) => trunkOf(sessionId)?.name || ownName(sessionId) || E.state?.identity?.name || "";

/* ---------- Needs you: a stopped task says what it needs ---------- */
export function adaptCards() {
  return stops.map((s) => `<div class="adapt-b17">${faceOf(s.sessionId, 30)}<span class="grow"><b>${esc(s.what)}</b><small>${esc(s.blocker?.said ?? "")}</small></span><button class="btn pri sm" type="button" data-act="adaptb17" data-id="${esc(s.id)}">${t("window.places.inbox17.what-it-needs")}</button></div>`).join("");
}

async function openAdapt(id) {
  const stop = stops.find((s) => s.id === id);
  if (!stop) return;
  let view;
  try { view = await api("adapt/plan", { stopId: id }); } catch (error) { toast(error.message); return; }
  const fix = view.fix && !view.fix.instead ? view.fix : null;
  const facts = [[t("window.places.inbox17.stopped-at"), stop.nextStep], [t("window.places.inbox17.missing"), (view.blocker ?? stop.blocker)?.what ?? ""], [t("window.places.kept"), stop.done.join(", ")]];
  const picked = Boolean(fix);
  const option = fix ? `<div class="opts-b17"><button type="button" class="upd-o15" data-act="adaptpickb17" data-id="${esc(id)}" aria-pressed="${picked}"><b>${esc(fix.what)}</b><small>${esc([fix.from, fix.size].filter(Boolean).join(" · "))}</small></button></div>` : "";
  openDlg({
    title: t("window.places.inbox17.what-sessionid-needs-to-carry-on", { sessionId: nameOf(stop.sessionId) }),
    body: `<p class="lead-b17">${esc(view.message)}</p><div class="scope15 s3-b17">${facts.map(([a, b]) => `<div><small>${a}</small><b>${esc(b)}</b></div>`).join("")}</div>${option}`,
    foot: `<button class="btn ghost" type="button" data-act="adaptnob17" data-id="${esc(id)}">${t("window.places.inbox17.leave-it-stopped")}</button><button class="btn pri" type="button" data-act="adaptgob17" data-id="${esc(id)}" ${fix ? "" : "disabled"}>${t("window.places.inbox17.fetch-it-and-carry-on")}</button>`,
  });
}

async function leaveStopped(id) {
  try { await api("adapt/leave", { stopId: id }); } catch (error) { toast(error.message); return; }
  closeDlg();
  await readStops();
  renderNow();
}

/* ---------- Later: work handed over to finish later ---------- */
const KINDS = {
  service: { how: "Waiting on a service", action: "stop", label: "Stop waiting" },
  manual: { how: "A step you do by hand", action: "done", label: "Done" },
  signing: { how: "A signing step you do yourself", action: "signed", label: "I've signed it" },
  later: { how: "Unfinished work set aside for later", action: "finish", label: "Finish now" },
};
const kindOf = (d) => KINDS[d.kind] ?? KINDS[["user.task", "web.page", "web.crawl"].includes(d.tool) ? "manual" : "service"];
export const laterCount = () => ownerHere() ? deferred.filter((d) => !d.settledAt).length : 0;

function laterRow(d) {
  const settled = Boolean(d.settledAt);
  const line = settled ? d.outcome : when17(d.createdAt);
  const kind = kindOf(d);
  const act = btn17("laterb17", say(kind.label), `data-id="${esc(d.id)}" data-v="${kind.action}"`);
  const right = settled ? pill17("done", t("window.places.inbox17.settled")) : act;
  return `<div class="prow later-b17">${faceOf(d.sessionId, 34)}<span class="grow"><b>${esc(String(d.description ?? "").split("\n")[0])}</b><small>${esc(line)}</small><small class="how-b17">${esc(say(kind.how))}</small></span>${right}</div>`;
}
export function laterTab() {
  if (!ownerHere()) return `<p class="hint">${esc(say("Handed-over work is available to the owner."))}</p>`;
  return `<p class="hint" data-css="margin:4px 0 8px">${t("window.places.inbox17.work-that-finishes-later-by-a")}</p><div class="rows">${deferred.map(laterRow).join("")}</div>`;
}

async function settle(el) {
  const entry = deferred.find((d) => d.id === el.dataset.id && !d.settledAt);
  if (!ownerHere() || !entry || el.disabled || el.dataset.v !== kindOf(entry).action) return;
  const person = activeId();
  el.disabled = true;
  try { await api("deferred/settle", { id: entry.id, action: kindOf(entry).action }); }
  catch (error) { if (ownerHere() && activeId() === person) toast(error.message); }
  if (!ownerHere() || activeId() !== person) return;
  await readDeferred();
  renderNow();
}

/* ---------- History: signed receipts ---------- */
export const receiptsSection = () => sec17(t("window.places.inbox17.signed-receipts"), prow17("shield", t("window.places.inbox17.every-tool-call-leaves-a-signed"), t("window.places.inbox17.each-runs-receipts-link-to-the"), btn17("chainb17", t("window.places.inbox17.see-the-chain"))));

const CH = { entries: [], check: null, rc: {} };
const RECEIPT_BAD = ["forged", "modified", "unsigned"];

function chainItem(e) {
  const broken = CH.check && !CH.check.ok && CH.check.brokenAt === e.seq;
  const rc = e.runId ? CH.rc[e.runId] : null;
  let right = "";
  if (broken) right = pill17("no", t("window.places.inbox17.link-broken"));
  else if (rc) right = rc.ok ? pill17("ok", t("window.places.inbox17.signed-matches")) : pill17("no", rc.bad.join(", "));
  else if (e.runId) right = btn17("rcptb17", t("window.places.inbox17.check-this-run"), `data-id="${esc(e.runId)}"`);
  return `<li class="${broken ? "bad-b17" : ""}"><span class="grow"><b>${esc(e.detail || e.kind)}</b><small>${esc(when17(e.at))} · ${t("window.places.inbox17.hash-links-to-prev", { hash: `<code>${esc(short17(e.hash))}</code>`, prev: `<code>${esc(short17(e.prev))}</code>` })}</small></span>${right}</li>`;
}
function drawChain() {
  const scroll = dialog()?.querySelector(".dlg-b")?.scrollTop ?? 0;
  openDlg({ title: t("window.places.inbox17.the-chain-of-receipts"), wide: true,
    body: `<p class="lead-b17">${t("window.places.inbox17.newest-first-each-entry-carries-the")}</p><ol class="chain-b17">${CH.entries.map(chainItem).join("")}</ol><p class="hint">${CH.check && !CH.check.ok ? esc(CH.check.reason) : t("window.places.inbox17.checking-a-run-re-reads-its")}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="chaintamperb17">${t("window.places.inbox17.what-a-break-looks-like")}</button><button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
  const body = dialog()?.querySelector(".dlg-b");
  if (body) body.scrollTop = scroll;
}
async function openChain() {
  try {
    const [list, verified] = await Promise.all([api("safety-extras/activity?limit=50"), api("safety-extras/activity/verify", {})]);
    CH.entries = list.entries ?? [];
    CH.check = verified.check ?? null;
  } catch (error) { toast(error.message); return; }
  drawChain();
}
async function checkRun(el) {
  let answer;
  try { answer = await api(`runs/${encodeURIComponent(el.dataset.id)}/receipts`); } catch (error) { toast(error.message); return; }
  const bad = RECEIPT_BAD.filter((k) => (answer.counts?.[k] ?? 0) > 0);
  CH.rc[el.dataset.id] = { ok: bad.length === 0, bad };
  drawChain();
  if (!bad.length) toast(t("window.places.inbox17.receipts-for-this-run-match-the"));
}

/* ---------- reading and actions ---------- */
async function readStops() { stops = (await api("adapt")).stops ?? []; }
let deferredRead = 0;
async function readDeferred() {
  const reading = ++deferredRead, person = activeId();
  if (!ownerHere()) { deferred = []; return; }
  const answer = await api("deferred");
  if (reading === deferredRead && ownerHere() && activeId() === person) deferred = answer.deferred ?? [];
}

/* After the Inbox draws: the stops (Needs you) and the handed-over jobs (every tab, for the Later count). */
export async function readInbox17(tab) {
  const before = JSON.stringify([stops, deferred]);
  const tasks = [readDeferred()];
  if (tab === "needs") tasks.push(readStops());
  const failed = (await Promise.allSettled(tasks)).find((r) => r.status === "rejected");
  if (failed) return { changed: false, error: failed.reason };
  return { changed: JSON.stringify([stops, deferred]) !== before };
}

export function initInbox17() {
  markLive(["adaptb17", "adaptnob17", "laterb17", "chainb17", "rcptb17"]);
  on("adaptb17", (el) => openAdapt(el.dataset.id));
  on("adaptnob17", (el) => leaveStopped(el.dataset.id));
  on("laterb17", (el) => settle(el));
  on("chainb17", () => openChain());
  on("rcptb17", (el) => checkRun(el));
}
