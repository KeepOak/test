/* What can Branch do: a gallery of what this Branch can do now, opened from Overview, the Guide menu and an empty
   conversation. Nothing in it is written here: every entry is read from the engine each time it opens.
     Tools      GET /api/tools tools[] (name, description), under the engine's own approval groups (GET /api/state
                approvalCategories: label, and the tools in each)
     Skills     the owner's skills that are switched on (GET /api/state skills[] with an activeVersion), each named and
                described by that version: a newer draft's words come from GET /api/skills/<id> versions[] instead
     Chat apps  GET /api/channel-setup channels[], those with the engine's plain line for them (data/channel-setup.json what)
     Prompts    the owner's saved prompts and the starter prompts (GET /api/prompts prompts[] and examples[], each with the
                words it asks), and the owner's saved flows (GET /api/flows flows[], those with a description)
   An entry's line is the engine's own description, its first line and sentence; an item the engine gives no description
   is left out. "Try it" opens a new conversation with a request in the box, not sent (the stress test's B003 way: the
   draft of the new conversation, then startConversation): a prompt's own words, else the request made the same way for
   every item of its kind from its name and line (window.what.ask-* in public/locales). */

import { esc } from "../core/dom.js";
import { E, S } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, dialog, toast, ic } from "../core/ui.js";
import { logo } from "../core/logos.js";
import { startConversation } from "../chat/chat.js";
import { t } from "../../i18n.js";

/* The tabs, in order, with the words each is named by. */
const TABS = [["tools", "dashboard.filter.tools"], ["skills", "nav.skills"], ["apps", "dashboard.links.chats"], ["prompts", "window.what.prompts"]];
const ICON = { tool: "puzzle", skill: "spark", prompt: "chat", flow: "bolt" };
const W = { tab: "tools", lists: null, opening: 0, using: null, fields: [] };

/* An engine description as one line: its first line, up to the end of its first sentence. */
export function oneLine(text) {
  const first = String(text ?? "").trim().split(/\r?\n/)[0].trim();
  return /^(.+?[.!?])(?=\s|$)/.exec(first)?.[1] ?? first;
}
const entry = (kind, name, line, ask) => ({ kind, name: String(name ?? ""), line: oneLine(line), ask: ask ?? "" });
const asked = (key, e) => ({ ...e, ask: e.ask || t(key, { name: e.name, line: e.line }) });
const described = (e) => e.name && e.line && e.ask;
const byName = (list) => list.filter((e, i) => list.findIndex((o) => o.kind === e.kind && o.name === e.name) === i);

/* The skills that are switched on, in the words of the version that is on (a newer draft's are not what runs). */
async function skillsOn() {
  const live = (E.state?.skills ?? []).filter((s) => s.activeVersion !== null && s.activeVersion !== undefined);
  const reads = await Promise.allSettled(live.map((s) => (s.activeVersion === s.headVersion ? s
    : api(`skills/${encodeURIComponent(s.id)}`).then((v) => (v.versions ?? []).find((x) => x.version === s.activeVersion) ?? {}))));
  for (const r of reads) if (r.status === "rejected") toast(r.reason?.message ?? String(r.reason));
  return reads.filter((r) => r.status === "fulfilled").map((r) => r.value);
}

/* Every list, read from the engine now. A read the engine refuses is said in its own words and its entries are left out. */
async function readLists() {
  const [reads, skills] = await Promise.all([Promise.allSettled([api("tools"), api("channel-setup"), api("prompts"), api("flows")]), skillsOn()]);
  for (const r of reads) if (r.status === "rejected") toast(r.reason?.message ?? String(r.reason));
  const [tools, apps, prompts, flows] = reads.map((r) => (r.status === "fulfilled" ? r.value : null));
  const saved = prompts?.prompts ?? [], commands = new Set(saved.map((p) => p.command));
  const promptEntry = (p) => ({ ...entry("prompt", p.title, p.description, p.body),
    config: p.command === "notes-example" ? prompts?.exampleServer : null });
  return {
    tools: byName((tools?.tools ?? []).map((x) => asked("window.what.ask-tool", entry("tool", x.name, x.description)))).filter(described),
    skills: byName(skills.map((x) => asked("window.what.ask-skill", entry("skill", x.name, x.description)))).filter(described),
    apps: (apps?.channels ?? []).map((x) => ({ ...asked("window.what.ask-app", entry("app", x.name, x.what)), id: String(x.id ?? "") })).filter(described),
    prompts: byName([...saved.map(promptEntry),
      ...(prompts?.examples ?? []).filter((p) => !commands.has(p.command)).map(promptEntry),
      ...(flows?.flows ?? []).map((f) => asked("window.what.ask-flow", entry("flow", f.name, f.description)))]).filter(described),
  };
}

/* The tools under the engine's approval groups, in its order; any tool in none of them comes last, unheaded. */
function toolGroups(tools) {
  const cats = Array.isArray(E.state?.approvalCategories) ? E.state.approvalCategories : [];
  const groups = cats.map((c) => { const names = new Set((c.tools ?? []).map((x) => x.name)); return { label: c.label, list: tools.filter((x) => names.has(x.name)) }; });
  const placed = new Set(groups.flatMap((g) => g.list.map((x) => x.name)));
  return [...groups, { label: "", list: tools.filter((x) => !placed.has(x.name)) }].filter((g) => g.list.length);
}

const mark = (e) => (e.kind === "app" ? logo(e.id, e.name, 34) : `<span class="ico-tile">${ic(ICON[e.kind], "s")}</span>`);
const snippet = (e) => e.config ? `<details><summary>${t("window.what.server-config")}</summary><p class="hint">${t("window.what.server-config-hint")}</p><pre><code>${esc(JSON.stringify(e.config, null, 2))}</code></pre></details>` : "";
const card = (e) => `<div class="wc-card" data-k="${esc(e.kind)}">${mark(e)}<span class="grow"><b>${esc(e.name)}</b><small title="${esc(e.line)}">${esc(e.line)}</small>${snippet(e)}</span><button class="btn ghost sm" type="button" data-act="whatcan-try" data-k="${esc(e.kind)}" data-v="${esc(e.name)}">${t("window.what.try")}</button></div>`;
const grid = (list) => `<div class="wc-grid">${list.map(card).join("")}</div>`;
const tabBody = () => (W.tab === "tools" ? toolGroups(W.lists.tools).map((g) => `${g.label ? `<h3 class="wc-h">${esc(g.label)}</h3>` : ""}${grid(g.list)}`).join("") : grid(W.lists[W.tab]));

function draw() {
  const tabs = TABS.filter(([k]) => W.lists[k].length);
  if (!tabs.some(([k]) => k === W.tab)) W.tab = tabs[0]?.[0] ?? "tools";
  const row = tabs.map(([k, words]) => `<button class="tab" type="button" role="tab" aria-selected="${k === W.tab}" data-act="whatcan-tab" data-v="${esc(k)}">${t(words)} <small>${W.lists[k].length}</small></button>`).join("");
  openDlg({ title: t("window.what.title"), wide: true,
    body: `<div class="wc-b" data-wc="1"><div class="wc-top"><p class="hint">${t("window.what.lede")}</p></div><div class="tabs" role="tablist">${row}</div><div class="wc-list" data-tab="${esc(W.tab)}">${tabBody()}</div></div>` });
}

/* Opens once its lists are read. An answer that comes back after another open, or once another dialog is showing, is
   not drawn over it. */
async function open() {
  const opening = ++W.opening;
  closeDlg();
  const lists = await readLists();
  if (opening !== W.opening || (dialog() && !dialog().querySelector("[data-wc]"))) return;
  W.lists = lists;
  draw();
}

/* Try it: the request goes in a new conversation's box, not sent. */
function tryIt(el) {
  const list = W.lists ? Object.values(W.lists).flat() : [];
  const e = list.find((x) => x.kind === el.dataset.k && x.name === el.dataset.v);
  if (!e) return;
  withBlanksFilled(e.name, e.ask, openDraft);
}

/**
 * A prompt's blanks ({{input}}, {{address}}…) asked for in labelled boxes, then `then` is handed the filled text; with no
 * blank it is handed at once. {{today}} is filled by itself. QA retest 2026-09-28 (m16): shared by What can Branch do's
 * Try it and a saved prompt's Use (chat/messages.js), which used to put the raw {{input}} in the box.
 */
export function withBlanksFilled(title, body, then) {
  const fields = [...new Set([...body.matchAll(/\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g)].map((match) => match[1]))].filter((name) => name !== "today");
  if (fields.length) {
    W.using = { body, then }; W.fields = fields;
    markLive(fields.map((name) => `sw:wc-field-${name}`));
    openDlg({ title, body: `<p class="hint">${t("window.what.fill-blanks")}</p>${fields.map((name) => `<label class="fld"><span>${esc(name === "input" ? t("window.what.your-text") : name)}</span><textarea class="inp" id="wc-field-${name}" maxlength="4000" rows="3" required></textarea></label>`).join("")}`,
      foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("updates.busy.cancel")}</button><button class="btn pri" type="button" data-act="whatcan-prepare">${t("window.what.prepare-draft")}</button>` });
    return;
  }
  then(body.replace(/\{\{\s*today\s*\}\}/g, new Date().toLocaleDateString("en-CA")));
}

function openDraft(text) {
  closeDlg();
  S.drafts.new = text;
  startConversation();
}

function prepareDraft() {
  if (!W.using) return;
  const values = Object.fromEntries(W.fields.map((name) => [name, document.getElementById(`wc-field-${name}`)?.value ?? ""]));
  const missing = W.fields.find((name) => !values[name].trim());
  if (missing) { document.getElementById(`wc-field-${missing}`)?.focus(); toast(t("window.what.fill-required")); return; }
  values.today = new Date().toLocaleDateString("en-CA");
  const text = W.using.body.replace(/\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g, (whole, name) => values[name] ?? whole);
  const then = W.using.then;
  W.using = null;
  closeDlg();
  then(text);
}

export function initWhatCan() {
  markLive(["whatcan", "whatcan-tab", "whatcan-try", "whatcan-prepare"]);
  on("whatcan", () => open());
  on("whatcan-tab", (el) => { if (!W.lists || !TABS.some(([k]) => k === el.dataset.v)) return; W.tab = el.dataset.v; draw(); });
  on("whatcan-try", (el) => tryIt(el));
  on("whatcan-prepare", () => prepareDraft());
}
