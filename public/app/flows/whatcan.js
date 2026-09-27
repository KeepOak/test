/* What can Branch do: a gallery of what this Branch can do now, opened from Overview, the Guide menu and an empty
   conversation. Nothing in it is written here: every entry is read from the engine each time it opens.
     Tools      GET /api/tools tools[] (name, description), under the engine's own approval groups (GET /api/state
                approvalCategories: label, and the tools in each)
     Skills     the owner's own skills (GET /api/state skills[]) and the browser skills that ship with Branch
                (GET /api/skills/browser skills[]), each with its description
     Chat apps  GET /api/channel-setup channels[], those with the engine's plain line for them (data/channel-setup.json what)
     Prompts    the owner's saved prompts and the starter prompts (GET /api/prompts prompts[] and examples[], each with the
                words it asks), and the owner's saved flows (GET /api/flows flows[], those with a description)
   An entry's line is the engine's own description, its first line and sentence; an item the engine gives no description
   is left out. "Try it" opens a new conversation with a request in the box, not sent (the stress test's B003 way: the
   draft of the new conversation, then startConversation): a prompt's own words, else the request made the same way for
   every item of its kind from its name and line (window.what.ask-* in public/locales).
   Branch's face at the top acts out idle; once nobody has clicked or typed for a minute (the pet's nap rule,
   shell/scene.js) or the window is hidden, it plays its sleep loop and the gallery's own motion holds still, until the
   next click or key. */

import { esc, applyCss } from "../core/dom.js";
import { E, S } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, dialog, toast, ic } from "../core/ui.js";
import { figureFace } from "../core/figures.js";
import { look17 } from "../core/art17.js";
import { logo } from "../core/logos.js";
import { startConversation } from "../chat/chat.js";
import { t } from "../../i18n.js";

/* The tabs, in order, with the words each is named by. */
const TABS = [["tools", "dashboard.filter.tools"], ["skills", "nav.skills"], ["apps", "dashboard.links.chats"], ["prompts", "window.what.prompts"]];
const ICON = { tool: "puzzle", skill: "spark", prompt: "chat", flow: "bolt" };
export const IDLE_MS = 60_000;
const W = { tab: "tools", lists: null, asleep: false, timer: 0 };

/* An engine description as one line: its first line, up to the end of its first sentence. */
export function oneLine(text) {
  const first = String(text ?? "").trim().split(/\r?\n/)[0].trim();
  return /^(.+?[.!?])(?=\s|$)/.exec(first)?.[1] ?? first;
}
const entry = (kind, name, line, ask) => ({ kind, name: String(name ?? ""), line: oneLine(line), ask: ask ?? "" });
const asked = (key, e) => ({ ...e, ask: e.ask || t(key, { name: e.name, line: e.line }) });
const described = (e) => e.name && e.line && e.ask;
const byName = (list) => list.filter((e, i) => list.findIndex((o) => o.kind === e.kind && o.name === e.name) === i);

/* Every list, read from the engine now. A read the engine refuses is said in its own words and its entries are left out. */
async function readLists() {
  const reads = await Promise.allSettled([api("tools"), api("skills/browser"), api("channel-setup"), api("prompts"), api("flows")]);
  for (const r of reads) if (r.status === "rejected") toast(r.reason?.message ?? String(r.reason));
  const [tools, browser, apps, prompts, flows] = reads.map((r) => (r.status === "fulfilled" ? r.value : null));
  const saved = prompts?.prompts ?? [], commands = new Set(saved.map((p) => p.command));
  return {
    tools: byName((tools?.tools ?? []).map((x) => asked("window.what.ask-tool", entry("tool", x.name, x.description)))).filter(described),
    skills: byName([...(E.state?.skills ?? []), ...(browser?.skills ?? [])].map((x) => asked("window.what.ask-skill", entry("skill", x.name, x.description)))).filter(described),
    apps: (apps?.channels ?? []).map((x) => ({ ...asked("window.what.ask-app", entry("app", x.name, x.what)), id: String(x.id ?? "") })).filter(described),
    prompts: byName([...saved.map((p) => entry("prompt", p.title, p.description, p.body)),
      ...(prompts?.examples ?? []).filter((p) => !commands.has(p.command)).map((p) => entry("prompt", p.title, p.description, p.body)),
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
const card = (e) => `<div class="wc-card" data-k="${esc(e.kind)}">${mark(e)}<span class="grow"><b>${esc(e.name)}</b><small title="${esc(e.line)}">${esc(e.line)}</small></span><button class="btn ghost sm" type="button" data-act="whatcan-try" data-k="${esc(e.kind)}" data-v="${esc(e.name)}">${t("window.what.try")}</button></div>`;
const grid = (list) => `<div class="wc-grid">${list.map(card).join("")}</div>`;
const tabBody = () => (W.tab === "tools" ? toolGroups(W.lists.tools).map((g) => `${g.label ? `<h3 class="wc-h">${esc(g.label)}</h3>` : ""}${grid(g.list)}`).join("") : grid(W.lists[W.tab]));

/* Branch's own face: idle while someone is here, its sleep loop once the window is idle or hidden. */
function face() {
  const look = look17("branch");
  return look ? figureFace(look, W.asleep ? "sleep" : "idle", "--s:56px;--c:#2F6F5E", "", 56) : "";
}

function draw() {
  const tabs = TABS.filter(([k]) => W.lists[k].length);
  if (!tabs.some(([k]) => k === W.tab)) W.tab = tabs[0]?.[0] ?? "tools";
  const row = tabs.map(([k, words]) => `<button class="tab" type="button" role="tab" aria-selected="${k === W.tab}" data-act="whatcan-tab" data-v="${esc(k)}">${t(words)} <small>${W.lists[k].length}</small></button>`).join("");
  openDlg({ title: t("window.what.title"), wide: true,
    body: `<div class="wc-b${W.asleep ? " asleep-wc" : ""}" data-wc="1"><div class="wc-top"><span class="wc-face">${face()}</span><p class="hint">${t("window.what.lede")}</p></div><div class="tabs" role="tablist">${row}</div><div class="wc-list" data-tab="${esc(W.tab)}">${tabBody()}</div></div>` });
  watch();
}

async function open() {
  closeDlg();
  W.lists = await readLists();
  lastInput = Date.now();
  W.asleep = document.hidden;
  draw();
}

/* Try it: the request goes in a new conversation's box, not sent. */
function tryIt(el) {
  const list = W.lists ? Object.values(W.lists).flat() : [];
  const e = list.find((x) => x.kind === el.dataset.k && x.name === el.dataset.v);
  if (!e) return;
  closeDlg();
  S.drafts.new = e.ask;
  startConversation();
}

/* ---------- sleep when idle ---------- */
let lastInput = Date.now();
const box = () => dialog()?.querySelector("[data-wc]");
function rest() {
  const b = box();
  if (!b) { clearInterval(W.timer); W.timer = 0; return; }
  const asleep = document.hidden || Date.now() - lastInput >= IDLE_MS;
  if (asleep === W.asleep) return;
  W.asleep = asleep;
  b.classList.toggle("asleep-wc", asleep);
  const slot = b.querySelector(".wc-face");
  if (slot) { slot.innerHTML = face(); applyCss(slot); }
}
function watch() { if (!W.timer) W.timer = setInterval(rest, 1000); }
["pointerdown", "keydown"].forEach((ev) => addEventListener(ev, () => { lastInput = Date.now(); if (W.asleep) rest(); }, true));
document.addEventListener("visibilitychange", rest);

export function initWhatCan() {
  markLive(["whatcan", "whatcan-tab", "whatcan-try"]);
  on("whatcan", () => open());
  on("whatcan-tab", (el) => { if (!W.lists || !TABS.some(([k]) => k === el.dataset.v)) return; W.tab = el.dataset.v; draw(); });
  on("whatcan-try", (el) => tryIt(el));
}
