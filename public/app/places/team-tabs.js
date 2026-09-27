/* Team's own tabs beyond Live now, People and Signing in (the prototype's groupsTab, sharedTab10, teamAgents, the
   Activity timeline, teamUsage and teamRules), each from the engine and each only the owner's:
   - Groups: the owner's sign-in card (GET /api/people/settings groups). A group is saved whole through POST
     /api/people/groups {id?, name, members, categories?, projects, dailySpendLimit} and removed through POST
     /api/people/groups/<id>/remove. Being in a group can only take things away (src/people/groups.ts narrow, which also
     refuses any widening), so a group never gives a person more than their own role.
   - Shared: the same card's shares (conversation, viewer or driver, a person or a group), each changed through POST
     /api/people/shares (the same conversation and subject replaced) or taken back with the exact tuple read through
     POST /api/people/shares/remove; and the copy links you made (GET /api/shares), stopped through POST
     /api/shares/<id>/revoke. "Shared with you" is not drawn: the engine answers it (GET /api/people/conversations)
     only to a person signed in from their own device, never at the window.
   - Teams of specialists: GET /api/teams, then each team's newest task (GET /api/teams/<id>/tasks, Q64's read-only view).
   - Activity: the record's household entries (GET /api/audit, action policy.changed and token.issued), newest first.
   - Usage: what each connection has left (GET /api/usage/glance), drawn as Settings › Data & usage draws it. How much of
     a keepoak.com workspace's accounts each person used is not drawn: the engine keeps no workspace.
   - Rules: the keepoak.com workspace's five rules, drawn greyed; the engine keeps none of them.
   Every route here is the owner's (src/people/api.ts requireOwner, the household and short-lived-key tables), so for
   anybody else nothing is read and nothing is drawn. Each tab is read once when it is switched to. */

import { $, esc, renderNow } from "../core/dom.js";
import { E, ownerHere, ownName, roleLabel, projectName, activeId } from "../core/state.js";
import { ic, openDlg, closeDlg, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ctl, ctlSeg } from "../settings/parts.js";
import { limitRow } from "../settings/pages/usage.js";
import { t, language } from "../../i18n.js";

const D = { card: null, links: [], teams: [], tasks: {}, audit: [], glance: null, projects: [] };
/* The owner's sign-in card, as Team last read it (places/team.js). */
export const setCard = (card) => { D.card = card; };
const KINDS = ["read", "browse", "files", "commands", "message", "spend", "settings"];
const kindWord = (k) => t(`people.admin.kind.${k}`);
const profiles = () => E.profiles?.profiles ?? [];
const nameOf = (id) => profiles().find((p) => p.id === id)?.name ?? "";
const money = (n) => `$${Number.isInteger(n) ? n : Number(n).toFixed(2)}`;
const when = (at) => (at ? new Date(at).toLocaleString(language(), { weekday: "short", hour: "numeric", minute: "2-digit" }) : "");

/* ---------- Groups ---------- */

/* What a group leaves its members: the kinds it allows (every kind when it narrows none), its projects, its allowance. */
function limits(g) {
  const kinds = g.categories ? g.categories.map(kindWord).join(", ") : "";
  const projects = (g.projects ?? []).map((id) => projectName(D.projects.find((p) => p.id === id)) || id).join(", ");
  const allowance = g.dailySpendLimit > 0 ? t("window.settings.people.amount-a-day", { amount: money(g.dailySpendLimit) }) : "";
  return [kinds, projects, allowance].filter(Boolean).join(" · ");
}
function groupsTab(card) {
  if (!card) return "";
  const rows = (card.groups ?? []).map((g) => `<div class="prow"><span class="ico-tile">${ic("users", "s")}</span><span class="grow"><b>${esc(g.name)}</b><small>${esc([g.members.map(nameOf).filter(Boolean).join(", "), limits(g)].filter(Boolean).join(" · "))}</small></span><button class="btn ghost sm" type="button" data-act="tgrp-edit" data-id="${esc(g.id)}">${t("prompts.action.edit")}</button></div>`).join("");
  return `<p class="hint" data-css="margin:0 0 10px">${t("window.places.team.being-in-a-group-can-only")}</p><div class="rows">${rows}</div>
    <div class="acts" data-css="margin-top:10px"><button class="btn sm" type="button" data-act="tgrp-new">${ic("plus", "s")}${t("window.places.team.new-group")}</button></div>`;
}

/* The group being edited, kept whole: the engine replaces the whole group on save. */
let G = null;
const chip = (k, v, label) => `<button type="button" class="chip6" data-act="tgrp-pick" data-k="${k}" data-v="${esc(v)}" aria-pressed="${G[k].includes(v)}">${esc(label)}</button>`;
function groupDlg() {
  const people = profiles().map((p) => chip("members", p.id, p.name)).join("");
  const kinds = KINDS.map((k) => chip("categories", k, kindWord(k))).join("");
  const projects = D.projects.map((p) => chip("projects", p.id, projectName(p))).join("");
  const remove = G.id ? `<button class="btn ghost" type="button" data-act="tgrp-rm" data-id="${esc(G.id)}">${t("people.admin.remove")}</button><span class="grow"></span>` : "";
  openDlg({ title: G.id ? G.name : t("window.places.team.new-group"), wide: true,
    body: `<label class="fld"><span>${t("people.admin.group.name")}</span><input class="inp" id="tgrp-name" maxlength="40" value="${esc(G.name)}" autocomplete="off"></label>
      <div class="fld"><span>${t("people.admin.group.members")}</span><span class="chips8">${people}</span></div>
      <div class="fld"><span>${t("people.admin.group.kinds")}</span><span class="chips8">${kinds}</span></div>
      ${projects ? `<div class="fld"><span>${t("memory.movein.kind.project")}</span><span class="chips8">${projects}</span></div>` : ""}
      <label class="fld"><span>${t("household.allowance")}</span><input class="inp" id="tgrp-spend" type="number" min="0" max="1000" step="0.5" value="${esc(String(G.dailySpendLimit))}"></label>
      <p class="hint">${t("people.admin.groups-note")}</p>`,
    foot: `${remove}<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="tgrp-save">${t("people.admin.group.add")}</button>` });
}
async function openGroup(id) {
  const g = (D.card?.groups ?? []).find((x) => x.id === id);
  try { D.projects = (await api("projects")).all ?? []; } catch (error) { toast(error.message); }
  G = g ? { id: g.id, name: g.name, members: [...g.members], categories: g.categories ? [...g.categories] : [...KINDS], projects: [...(g.projects ?? [])], dailySpendLimit: g.dailySpendLimit ?? 0 }
    : { id: null, name: "", members: [], categories: [...KINDS], projects: [], dailySpendLimit: 0 };
  groupDlg();
}
function pick(el) {
  G.name = $("#tgrp-name")?.value ?? G.name;
  G.dailySpendLimit = Number($("#tgrp-spend")?.value ?? G.dailySpendLimit) || 0;
  const { k, v } = el.dataset;
  G[k] = G[k].includes(v) ? G[k].filter((x) => x !== v) : [...G[k], v];
  groupDlg();
}
/* Every kind picked means the group narrows no kind, so categories is left out; fewer is sent as the kinds it allows,
   none at all included (which takes every kind away). */
async function saveGroup(reload) {
  const name = ($("#tgrp-name")?.value ?? "").trim();
  if (!name) { $("#tgrp-name")?.setAttribute("aria-invalid", "true"); return; }
  const spend = Number($("#tgrp-spend")?.value ?? 0) || 0;
  const categories = KINDS.every((k) => G.categories.includes(k)) ? {} : { categories: KINDS.filter((k) => G.categories.includes(k)) };
  try {
    await api("people/groups", { ...(G.id ? { id: G.id } : {}), name, members: G.members, ...categories, projects: G.projects, dailySpendLimit: spend });
    closeDlg();
    G = null;
  } catch (error) { toast(error.message); }
  await reload();
}
async function removeGroup(el, reload) {
  try { await api(`people/groups/${encodeURIComponent(el.dataset.id)}/remove`, {}); closeDlg(); G = null; } catch (error) { toast(error.message); }
  await reload();
}

/* ---------- Shared ---------- */

const conversationName = (id) => ownName(id) || (() => { const s = E.sessions.find((x) => (x.sessionId ?? x.id) === id); return s?.title || s?.opening || ""; })();
const subjectName = (subject, card) => {
  const [kind, rest] = String(subject).split(":");
  if (kind === "profile") return nameOf(rest);
  return (card?.groups ?? []).find((g) => `${g.id}#member` === rest)?.name ?? "";
};
const RELATION = { viewer: "people.admin.share.viewer", driver: "people.admin.share.driver" };
function sharedRows(card) {
  const by = new Map();
  for (const tuple of card?.shares ?? []) by.set(tuple.object, [...(by.get(tuple.object) ?? []), tuple]);
  return [...by].map(([object, tuples]) => {
    const id = object.slice("conversation:".length);
    const who = tuples.map((x) => `${subjectName(x.subject, card)}: ${t(RELATION[x.relation])}`).join(" · ");
    return `<div class="prow"><span class="ico-tile">${ic("chat", "s")}</span><span class="grow"><b>${esc(conversationName(id))} <span class="tag6">${t("people.admin.share.conversation")}</span></b><small>${esc(who)}</small></span><button class="btn ghost sm" type="button" data-act="tsh-manage" data-id="${esc(id)}">${t("window.places.library17.manage")}</button></div>`;
  }).join("");
}
const linkLive = (l) => !l.revokedAt && (!l.expiresAt || Date.parse(l.expiresAt) > Date.now());
function linkRows() {
  return D.links.filter(linkLive).map((l) => `<div class="prow"><span class="ico-tile">${ic("globe", "s")}</span><span class="grow"><b>${esc(l.title || conversationName(l.sessionId))} <span class="tag6">${t("window.places.team.a-copy")}</span></b><small>${l.expiresAt ? esc(t("window.places.team.link-stops-working-when", { when: new Date(l.expiresAt).toLocaleString(language(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) })) : ""}</small></span><button class="btn ghost sm" type="button" data-act="tsh-stop" data-id="${esc(l.id)}">${t("window.places.team.stop-this-link")}</button></div>`).join("");
}
function sharedTab(card) {
  if (!card) return "";
  return `<div class="rows">${sharedRows(card)}${linkRows()}</div>`;
}

/* Who has one conversation, a person or a group per row, as the prototype's Share dialog's With people tab. Also drawn by
   that dialog (flows/share.js), with its own act. */
const OPTS = [["no", "window.places.team.no"], ["viewer", RELATION.viewer], ["driver", RELATION.driver]];
export function peopleRows(id, card, act) {
  const object = `conversation:${id}`;
  const held = (subject) => (card?.shares ?? []).find((x) => x.object === object && x.subject === subject)?.relation ?? "no";
  const row = (subject, name, sub) => `<div class="prow"><span class="grow"><b>${esc(name)}</b><small>${esc(sub)}</small></span><span class="seg">${OPTS.map(([v, key]) => `<button type="button" data-act="${act}" data-id="${esc(id)}" data-subject="${esc(subject)}" data-v="${v}" aria-pressed="${held(subject) === v}">${t(key)}</button>`).join("")}</span></div>`;
  return [...profiles().filter((p) => p.id !== activeId()).map((p) => row(`profile:${p.id}`, p.name, roleLabel((E.profiles?.roles ?? []).find((r) => r.profileId === p.id)?.grant?.role ?? "adult"))),
    ...(card?.groups ?? []).map((g) => row(`group:${g.id}#member`, g.name, t("people.admin.groups")))].join("");
}
/* One person's or group's share of a conversation: replaced through POST /api/people/shares, or, for No, the exact tuple
   held taken back through POST /api/people/shares/remove. Answers the owner's card as the engine keeps it after. */
export async function relate(el, card) {
  const { id, subject, v } = el.dataset, object = `conversation:${id}`;
  const now = (card?.shares ?? []).find((x) => x.object === object && x.subject === subject);
  if (v === "no") return now ? api("people/shares/remove", now) : card;
  return api("people/shares", { object, relation: v, subject });
}
function manageDlg(id) {
  openDlg({ title: t("window.places.team.share-name", { name: conversationName(id) }), wide: true, body: `<div class="rows">${peopleRows(id, D.card, "tsh-rel")}</div>`,
    foot: `<button class="btn pri" type="button" data-act="dlg-close">${t("first-run-steps.done")}</button>` });
}
async function setRelation(el, reload) {
  try { await relate(el, D.card); } catch (error) { toast(error.message); }
  await reload();
  manageDlg(el.dataset.id);
}
async function stopLink(el, reload) {
  try { await api(`shares/${encodeURIComponent(el.dataset.id)}/revoke`, {}); toast(t("window.places.team.the-link-is-stopped")); } catch (error) { toast(error.message); }
  await reload();
}

/* ---------- Teams of specialists ---------- */

const specName = (id) => { const s = (E.state?.specialists ?? []).find((x) => x.id === id); return s?.data?.definition?.name ?? s?.data?.name ?? s?.name ?? ""; };
const WHO = { window: "teamTasks.who.window", branch: "teamTasks.who.branch", key: "teamTasks.who.key", unknown: "teamTasks.who.unknown" };
const party = (p) => (!p ? "" : p.name || t(WHO[p.kind] ?? "teamTasks.who.gone"));
/* A task's state in Q51's words, the same words the Activity pane reads. */
const WHY = { "handoff.offered": "task.blocked.handoff", "reconciliation.required": "task.blocked.reconcile", "nothing-done": "task.nothing-done" };
const STATE = { working: ["work", "task.working"], "waiting-owner": ["warn6", "task.owner"], "waiting-service": ["warn6", "task.service"], blocked: ["warn6", "task.blocked"], finished: ["done", "task.finished"], queued: ["idle", "task.queued"] };
const stateWords = (s) => t(WHY[s?.why] ?? STATE[s?.state]?.[1] ?? "task.queued");
const MEMBER = { working: ["work", "task.working"], "waiting-owner": ["warn6", "window.places.team.waiting"], "waiting-service": ["warn6", "window.places.team.waiting"], blocked: ["warn6", "window.places.team.waiting"], finished: ["done", "task.finished"] };
function memberRow(m, team) {
  const [cls, key] = m.task ? MEMBER[m.task.state] ?? ["idle", "window.places.team.not-yet"] : ["idle", "window.places.team.not-yet"];
  const seat = (team.members ?? []).find((x) => x.role === m.role);
  const label = [specName(seat?.specialistId), m.role].filter(Boolean).join(" · ") || t("teamTasks.member.unnamed");
  return `<div class="prow"><span class="ico-tile">${ic("bolt", "s")}</span><span class="grow"><b>${esc(label)}</b>${m.task?.reason ? `<small>${esc(m.task.reason)}</small>` : ""}</span><span class="pill ${cls}"><i></i>${t(key)}</span></div>`;
}
function handoffLine(task) {
  if (!task.handoff && !task.blocker) return "";
  const offered = task.handoff ? t("teamTasks.handoff", { who: party(task.handoff.to), time: when(task.handoff.since), reason: task.handoff.reason }) : "";
  const stops = task.blocker ? t("window.places.team.what-stops-it", { text: task.blocker }) : "";
  return `<div class="handoff">${ic("branch", "s")}<span><b>${esc(offered || stops)}</b>${offered && stops ? `<small>${esc(stops)}</small>` : ""}</span></div>`;
}
function teamCard(team, task) {
  const cls = STATE[task.task?.state]?.[0] ?? "idle";
  const who = [t("teamTasks.asked-by", { who: party(task.askedBy) }), task.heldBy ? t("teamTasks.held-by", { who: party(task.heldBy) }) : ""].filter(Boolean).join(" · ");
  return `<div class="tile"><div class="th"><b>${esc(team.name)}</b><span class="pill ${cls} ml"><i></i>${esc(stateWords(task.task))}</span></div><p>${esc(who)}</p>
    <div class="rows">${task.members.map((m) => memberRow(m, team)).join("")}</div>${handoffLine(task)}
    <p class="hint" data-css="margin:8px 0 0">${t("window.places.team.this-card-only-looks")}</p></div>`;
}
function teamsTab() {
  return `<div class="rows">${D.teams.map((team) => (D.tasks[team.id]?.[0] ? teamCard(team, D.tasks[team.id][0]) : "")).join("")}</div>`;
}

/* ---------- Activity ---------- */

/* The record names conversations, people and groups by id; each is named as the window knows it. */
function readable(subject, card) {
  return String(subject ?? "")
    .replace(/conversation:([a-f0-9-]{36})/g, (_, id) => conversationName(id) || _)
    .replace(/profile:([a-f0-9-]{36})/g, (_, id) => nameOf(id) || _)
    .replace(/group:([a-f0-9-]{36})#member/g, (_, id) => (card?.groups ?? []).find((g) => g.id === id)?.name || _);
}
function activityTab(card) {
  return `<ol class="tl">${D.audit.map((e) => `<li>${ic("info", "s")}<span>${esc(e.reason)}<small>${esc(readable(e.subject, card))}</small></span><time>${esc(when(e.at ?? e.createdAt))}</time></li>`).join("")}</ol>`;
}

/* ---------- Usage and Rules ---------- */

function usageTab() {
  return `<p class="hint" data-css="margin:0 0 10px">${t("window.places.team.each-persons-own-model-accounts")}</p><div class="lims flat" data-css="margin-top:14px">${(D.glance?.rows ?? []).map(limitRow).join("")}</div>`;
}
/* The workspace's rules live on keepoak.com, which the engine does not reach: drawn greyed, nothing pressed. */
function rulesTab() {
  return `${ctlSeg(t("window.places.team.spending-that-needs-an-admins-yes"), t("window.places.team.anything-a-trunk-would-buy"), [t("window.places.team.over-10"), t("window.places.team.over-25"), t("window.places.team.over-100")], null)}
    ${ctl("tr-models", t("window.places.team.only-these-services-for-shared"), t("window.places.team.chatgpt-and-claude-through"), false)}
    ${ctl("tr-skills", t("window.places.team.only-admins-install-skills"), t("window.places.team.members-can-ask"), false)}
    ${ctl("tr-sso", t("window.places.team.sign-in-with-keepoak"), t("window.places.team.everyone-signs-in-with-keepoak"), false)}
    ${ctlSeg(t("window.places.team.keep-team-conversations"), t("window.places.team.only-conversations-with-shared"), [t("window.places.team.30-days"), t("window.places.team.1-year"), t("window.places.team.forever")], null)}`;
}

export function tabBody(tab, card) {
  if (tab === "rules") return rulesTab();
  if (!ownerHere()) return "";
  if (tab === "groups") return groupsTab(card);
  if (tab === "shared") return sharedTab(card);
  if (tab === "agents") return teamsTab();
  if (tab === "activity") return activityTab(card);
  if (tab === "usage") return usageTab();
  return "";
}

/* ---------- reading ---------- */

async function readAudit() {
  const [a, b] = await Promise.all(["policy.changed", "token.issued"].map((action) => api(`audit?action=${action}&limit=50`)));
  const at = (e) => String(e.at ?? e.createdAt ?? "");
  return [...(a.entries ?? []), ...(b.entries ?? [])].sort((x, y) => at(y).localeCompare(at(x))).slice(0, 40);
}
async function readTeams() {
  const teams = (await api("teams")).teams ?? [];
  const tasks = Object.fromEntries(await Promise.all(teams.map(async (team) => [team.id, (await api(`teams/${encodeURIComponent(team.id)}/tasks`)).tasks ?? []])));
  return { teams, tasks };
}
/* A tab's own data, read when it is switched to; answers whether anything changed. Only the owner reads any of it. */
export async function readTab(tab) {
  if (!ownerHere()) return false;
  const before = JSON.stringify(D);
  try {
    if (tab === "shared") D.links = (await api("shares")).shares ?? [];
    else if (tab === "groups") D.projects = (await api("projects")).all ?? [];
    else if (tab === "agents") Object.assign(D, await readTeams());
    else if (tab === "activity") D.audit = await readAudit();
    else if (tab === "usage") D.glance = await api("usage/glance");
  } catch (error) { toast(error.message); }
  return JSON.stringify(D) !== before;
}

export function initTeamTabs(reload) {
  markLive(["tgrp-new", "tgrp-edit", "tgrp-pick", "tgrp-save", "tgrp-rm", "sw:tgrp-name", "sw:tgrp-spend", "tsh-manage", "tsh-rel", "tsh-stop"]);
  on("tgrp-new", () => openGroup(null));
  on("tgrp-edit", (el) => openGroup(el.dataset.id));
  on("tgrp-pick", (el) => pick(el));
  on("tgrp-save", () => saveGroup(reload));
  on("tgrp-rm", (el) => removeGroup(el, reload));
  on("tsh-manage", (el) => manageDlg(el.dataset.id));
  on("tsh-rel", (el) => setRelation(el, reload));
  on("tsh-stop", async (el) => { await stopLink(el, async () => { await readTab("shared"); renderNow(); }); });
}
