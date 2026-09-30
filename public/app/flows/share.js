/* Share… (a conversation) and Share this Trunk… (the prototype's shareDlg), from the conversation menu.
   - A conversation, With people: each person on this computer and each group, No / May read it / May also write in it,
     read from the owner's sign-in card (GET /api/people/settings shares, groups) and changed as Team › Shared changes it
     (places/team-tabs.js relate: POST /api/people/shares, or the exact tuple through /api/people/shares/remove).
   - A copy, Carry on elsewhere and Hand off stay greyed: a copy link and a carry-on key are secrets handed out (held for
     the security review), and the engine has no hand-off of a conversation to a chat app, the terminal or an agent.
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
const SH = { kind: "conv", id: null, tab: "people", card: null };
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
    const to = [["telegram", t("window.flows.share.telegram")], ["term", t("window.flows.share.terminal")]];
    return `<div class="provs">${to.map(([i, l]) => `<button class="prov" type="button" data-act="share-handoff" data-v="${i}">${i === "telegram" ? logo(i, l, 28) : `<span class="ico-tile">${ic(i, "s")}</span>`}<b>${esc(l)}</b><small>/handoff</small></button>`).join("")}</div>`;
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

async function open(kind) {
  closePop();
  const tr = kind === "trunk" ? trunkOf(S.chat) : null;
  if (!S.chat || (kind === "trunk" && !tr)) return;
  Object.assign(SH, { kind, id: tr ? tr.id : S.chat, tab: "people", card: null });
  try { SH.card = await api("people/settings"); } catch (error) { toast(error.message); return; }
  draw();
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
  /* protectWindow permits app-origin blob downloads through ownDownload; other desktop downloads stay refused. */
  markLive(["share10", "share-tab", "share-rel", "share-file"]);
  on("share10", (el) => open(el.dataset.k === "trunk" ? "trunk" : "conv"));
  on("share-tab", (el) => { SH.tab = el.dataset.v; draw(); });
  on("share-rel", (el) => setRelation(el));
  on("share-file", (el) => saveFile(el));
}
