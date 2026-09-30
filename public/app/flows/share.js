/* Share… (a conversation) and Share this Trunk… (the prototype's shareDlg), from the conversation menu.
   - A conversation, With people: each person on this computer and each group, No / May read it / May also write in it,
     read from the owner's sign-in card (GET /api/people/settings shares, groups) and changed as Team › Shared changes it
     (places/team-tabs.js relate: POST /api/people/shares, or the exact tuple through /api/people/shares/remove).
   - Hand off uses the gated /handoff command: one explicitly selected Telegram owner DM, a terminal command, or a
     named assistant's reported response. A copy and Carry on elsewhere retain their own controls.
   - A Trunk, As a file: the engine's own file of it (GET /api/trunks/<id>/export: who it is, never its conversations,
     memory, keys or reach; src/trunks/share.ts), saved as <name>.branch-trunk. With people stays greyed (the engine shares
     conversations only, src/people/groups.ts TupleSchema) and With the team needs keepoak.com, which the engine does not reach. */

import { esc } from "../core/dom.js";
import { openDlg, closePop, toast, mi, ic, dialog } from "../core/ui.js";
import { S, E, activeId, ownerHere } from "../core/state.js";
import { api } from "../core/api.js";
import { say } from "../core/words.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ctlSeg } from "../settings/parts.js";
import { logo } from "../core/logos.js";
import { peopleRows, relate } from "../places/team-tabs.js";
import { t } from "../../i18n.js";

const TABS = {
  conv: [["people", "window.flows.share.with-people"], ["copy", "window.flows.share.a-copy"], ["carry", "window.flows.share.carry-on"], ["handoff", "window.flows.share.hand-off"]],
  trunk: [["people", "window.flows.share.with-people"], ["file", "window.flows.share.as-a-file"], ["team", "window.flows.share.with-the-team"]],
};
const SH = { kind: "conv", id: null, tab: "people", card: null, targets: [], agent: "", result: "" };
const trunkOf = (sid) => E.trunks.find((tr) => tr.chatSessionId === sid);
const convName = (sid) => {
  const tr = trunkOf(sid), s = E.sessions.find((x) => (x.sessionId ?? x.id) === sid);
  return tr?.name ?? s?.title ?? s?.opening ?? "";
};

/* The conversation menu's two rows: only the owner shares, and only a conversation that exists. */
export function shareMenu() {
  if (!S.chat || !ownerHere()) return "";
  return mi("share10", "users", t("window.flows.share.share"), "", 'data-k="conv"') + (trunkOf(S.chat) ? mi("share10", "doc", t("window.flows.share.share-trunk"), "", 'data-k="trunk"') : "");
}

function peopleTab() {
  return `<div class="rows">${SH.kind === "trunk" ? peopleRows(SH.id, SH.card, "share-trunk-rel") : peopleRows(SH.id, SH.card, "share-rel")}</div>`;
}
const soonBtn = (act, words) => `<div class="acts"><button class="btn pri sm" type="button" data-act="${act}">${words}</button></div>`;
function body(name) {
  const tab = SH.tab;
  if (tab === "people") return peopleTab();
  if (tab === "copy") return `<p data-css="margin:0">${t("window.flows.share.copy-what")}</p>${ctlSeg(t("window.flows.share.link-works-for"), t("window.flows.share.link-network"), [t("window.flows.share.hour"), t("window.flows.share.day"), t("window.flows.share.week")])}${soonBtn("share-link", t("window.flows.share.make-link"))}`;
  if (tab === "carry") return `<p data-css="margin:0">${t("window.flows.share.carry-what")}</p>${ctlSeg(t("window.flows.share.key-lasts"), t("window.flows.share.then-stops"), [t("window.flows.share.quarter"), t("window.flows.share.hour"), t("window.flows.share.day")])}${soonBtn("share-key", t("window.flows.share.make-key"))}`;
  if (tab === "handoff") {
    const chats = SH.targets.map((chat, index) => `<button class="prov" type="button" data-act="share-handoff" data-v="chat" data-d="${index}">${logo("telegram", "Telegram", 28)}<b>${esc(chat.title)}</b><small>${esc(chat.channel)} · ${esc(chat.chatId)}</small></button>`).join("");
    return `<p class="hint">${esc(t("window.flows.share.handoff-exact"))}</p><div class="provs">${chats || `<p class="empty">${esc(t("window.flows.share.handoff-none"))}</p>`}<button class="prov" type="button" data-act="share-handoff" data-v="terminal"><span class="ico-tile">${ic("term", "s")}</span><b>${esc(t("window.flows.share.terminal"))}</b><small>${esc(t("window.flows.share.handoff-command"))}</small></button></div><label class="fld"><span>${esc(t("window.flows.share.handoff-agent"))}</span><input class="inp" data-sw="share-assistant" value="${esc(SH.agent)}" maxlength="200"></label><button class="btn" type="button" data-act="share-handoff" data-v="assistant">${esc(t("window.flows.share.hand-off"))}</button>${SH.result ? `<pre class="code">${esc(SH.result)}</pre>` : ""}`;
  }
  if (tab === "file") return `<p data-css="margin:0">${esc(t("window.flows.share.file-what", { name }))}</p><div class="acts"><button class="btn pri sm" type="button" data-act="share-file">${t("window.flows.share.save-file")}</button></div>`;
  return `<p data-css="margin:0">${esc(t("window.flows.share.team-what", { name }))}</p>${soonBtn("share-team", t("window.flows.share.share-team"))}`;
}
function draw() {
  const tr = SH.kind === "trunk" ? E.trunks.find((x) => x.id === SH.id) : null;
  const name = tr ? tr.name : convName(SH.id);
  const tabs = TABS[SH.kind].map(([v, key]) => `<button class="tab" type="button" role="tab" aria-selected="${SH.tab === v}" data-act="share-tab" data-v="${v}">${t(key)}</button>`).join("");
  openDlg({ title: t("window.places.team.share-name", { name }), wide: true, body: `<div class="tabs" role="tablist" data-css="margin:0">${tabs}</div>${body(name)}`,
    foot: `<button class="btn pri" type="button" data-act="dlg-close">${t("first-run-steps.done")}</button>` });
}

/* The window is not behind the App lock. */
const unlocked = () => !document.getElementById("app")?.classList.contains("locked-b17");
/* Share opens asked, and dialogs the owner closed (close button or Escape): a Share still being read must not open after
   a newer one, or over a dialog opened or closed meanwhile. */
let shareRequest = 0, dialogsClosed = 0;

async function open(kind) {
  closePop();
  if (!ownerHere() || !unlocked()) return;
  const profile = activeId(), source = S.chat, view = S.view, opened = dialog(), closed = dialogsClosed, request = ++shareRequest;
  const tr = kind === "trunk" ? trunkOf(S.chat) : null;
  if (!S.chat || (kind === "trunk" && !tr)) return;
  const id = tr ? tr.id : source;
  const still = () => request === shareRequest && ownerHere() && activeId() === profile && unlocked() && S.view === view
    && S.chat === source && SH.id === id && dialog() === opened && dialogsClosed === closed;
  Object.assign(SH, { kind, id, tab: "people", card: null, targets: [], agent: "", result: "" });
  try {
    const [card, chats] = await Promise.all([api("people/settings"), kind === "conv" ? api("channels") : Promise.resolve({})]);
    if (!still()) return;
    SH.card = card;
    SH.targets = Array.isArray(chats.handoffTargets) ? chats.handoffTargets : [];
  } catch (error) { if (still()) toast(error.message); return; }
  draw();
}

let handingOff = false;
async function handoff(el) {
  if (!ownerHere() || handingOff || SH.kind !== "conv" || SH.tab !== "handoff" || !SH.id) return;
  const source = SH.id, profile = activeId(), opened = dialog();
  const current = () => ownerHere() && activeId() === profile && unlocked() && dialog() === opened && opened?.isConnected
    && S.chat === source && SH.kind === "conv" && SH.id === source && SH.tab === "handoff";
  const to = el.dataset.v;
  let line = "";
  if (to === "chat") {
    const chat = SH.targets[Number(el.dataset.d)];
    if (!chat) return;
    line = "/handoff chat " + [chat.channel, chat.chatId, chat.sessionId, chat.updatedAt].map(encodeURIComponent).join(" ");
  } else if (to === "terminal") line = "/handoff terminal";
  else if (to === "assistant" && SH.agent.trim()) line = `/handoff assistant ${SH.agent.trim().replace(/\s+/g, " ")}`;
  if (!line || !current()) return;
  handingOff = true;
  el.disabled = true;
  try {
    const done = await api("commands/run", { surface: "window", line, sessionId: source });
    if (!current()) return;
    SH.result = done?.handled ? String(done.text ?? "") : t("window.flows.share.handoff-unavailable");
    draw();
  } catch (error) { if (current()) toast(error.message); }
  finally { handingOff = false; if (el.isConnected) el.disabled = false; }
}

async function setRelation(el) {
  try { SH.card = await relate(el, SH.card); } catch (error) { toast(error.message); }
  draw();
}

/* The engine's file of the Trunk, saved under its own name. */
let savingFile = false;
async function saveFile(el) {
  const tr = E.trunks.find((x) => x.id === SH.id);
  if (!tr || !ownerHere() || savingFile || SH.kind !== "trunk" || SH.tab !== "file") return;
  const person = activeId(), opened = dialog(), id = tr.id;
  const current = () => ownerHere() && activeId() === person && dialog() === opened && opened?.isConnected
    && SH.kind === "trunk" && SH.id === id && SH.tab === "file";
  savingFile = true;
  el.disabled = true;
  try {
    const file = await api(`trunks/${encodeURIComponent(tr.id)}/export`);
    if (!current()) return;
    const name = `${tr.name.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^\.+/, "").slice(0, 80) || "Trunk"}.branch-trunk`;
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" })), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`${say("File download started:")} ${name}`);
  } catch (error) { if (current()) toast(error.message); }
  finally { savingFile = false; if (el.isConnected) el.disabled = false; }
}

export function init() {
  document.addEventListener("click", (e) => { if (e.target.closest?.('[data-act="dlg-close"]')) dialogsClosed += 1; }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dialog()) dialogsClosed += 1; }, true); // main.js closes it on Escape
  markLive(["share-handoff", "sw:share-assistant"]);
  on("share-handoff", handoff);
  document.addEventListener("input", (event) => {
    if (event.target.dataset?.sw === "share-assistant" && ownerHere() && SH.kind === "conv" && SH.tab === "handoff")
      SH.agent = event.target.value.slice(0, 200);
  });
  /* protectWindow permits app-origin blob downloads through ownDownload; other desktop downloads stay refused. */
  markLive(["share10", "share-tab", "share-rel", "share-file"]);
  on("share10", (el) => open(el.dataset.k === "trunk" ? "trunk" : "conv"));
  on("share-tab", (el) => { SH.tab = el.dataset.v; draw(); });
  on("share-rel", (el) => setRelation(el));
  on("share-file", (el) => saveFile(el));
}
