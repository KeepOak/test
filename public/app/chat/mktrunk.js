/* "Have Branch make a Trunk" (prototype ACTS['mk-new'], ['mk-go'], mkCard). The + menu opens the prototype's dialog; Propose
   it starts a real task in a new conversation with the prototype's words, "Make me a Trunk: <what>" (POST /api/run through
   chat.js startWith). Branch answers with the engine's trunk.propose tool (src/trunks/propose.ts), which makes nothing: the
   card under that reply shows what it proposed, a name and a job, in the prototype's card. Make <name> is the owner's own
   create with exactly those fields (POST /api/trunks {name, title, description}); Change it first makes it the same way and
   opens its editor; No thanks puts the card away (window state). Once the engine's list has a Trunk of that name the card
   says it is made, with Open <name>. The prototype's Tools, Computer, May and Talks to rows are not drawn: a proposal holds
   none of them, so the dialog's hint keeps only "Nothing is made until you say so." */

import { $, esc, render } from "../core/dom.js";
import { E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on, run } from "../core/actions.js";
import { av, openDlg, closeDlg, closePop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { startWith } from "./chat.js";
import { t } from "../../i18n.js";

/* Proposals drawn so far by their call id, the calls being made now, and the ones put away. */
const MK = { seen: new Map(), busy: new Set(), no: new Set() };

/* The trunk.propose calls in one reply, each with its arguments; a call whose arguments are not JSON proposed nothing.
   A proposal is known by its reply and its call id together: some connections number calls afresh each turn (Ollama). */
function proposals(m) {
  return (m.toolCalls ?? []).filter((call) => call.name === "trunk.propose").map((call) => {
    let args;
    try { args = JSON.parse(call.arguments || "{}"); } catch { return null; } // not JSON: nothing was proposed
    const name = typeof args?.name === "string" ? args.name.trim() : "";
    return name ? { id: `${m.messageId ?? ""}:${call.id}`, name, title: String(args.title ?? ""), description: String(args.description ?? "") } : null;
  }).filter(Boolean);
}

function card(p) {
  const made = E.trunks.find((tr) => tr.name === p.name), name = esc(p.name);
  if (made) return `<div class="card"><div class="card-h"><b>${t("window.chat.mktrunk.made", { name })}</b><span class="pill done ml"><i></i>${t("window.chat.mktrunk.ready")}</span></div><p data-css="margin:0">${t("window.chat.mktrunk.made-body")}</p><div class="acts"><button class="btn sm" type="button" data-act="chat" data-id="${esc(made.chatSessionId)}">${t("window.chat.mktrunk.open", { name })}</button></div></div>`;
  const off = MK.busy.has(p.id) ? " disabled" : "", job = p.description || p.title, id = `data-id="${esc(p.id)}"`;
  return `<div class="card mk10"><div class="card-h"><b>${t("window.chat.mktrunk.proposed")}</b><span class="pill work ml"><i></i>${t("window.chat.mktrunk.needs-you")}</span></div><div class="mk10-b">${av({ name: p.name }, 56)}<dl class="kv"><dt>${t("window.chat.mktrunk.name")}</dt><dd>${name}</dd>${job ? `<dt>${t("window.chat.mktrunk.job")}</dt><dd>${esc(job)}</dd>` : ""}</dl></div>
    <div class="acts"><button class="btn pri sm" type="button" data-act="mk-create" ${id}${off}>${t("window.chat.mktrunk.make", { name })}</button><button class="btn sm" type="button" data-act="mk-change" ${id}${off}>${t("window.chat.mktrunk.change")}</button><button class="btn ghost sm" type="button" data-act="mk-no" ${id}>${t("window.chat.mktrunk.no")}</button></div></div>`;
}

/* The cards under a reply that called trunk.propose; none once the owner said No thanks. */
export function mkCard(m) {
  const list = proposals(m).filter((p) => !MK.no.has(p.id));
  for (const p of list) MK.seen.set(p.id, p);
  return list.map((p) => `<div class="b"><div class="gut"></div><div>${card(p)}</div></div>`).join("");
}

function newDlg() {
  closePop();
  openDlg({ title: t("window.chat.mktrunk.title"), body: `<label class="fld"><span>${t("window.chat.mktrunk.what")}</span><textarea class="inp" id="mk-what" rows="3" placeholder="${esc(t("window.chat.mktrunk.what-hint"))}"></textarea></label><p class="hint">${t("window.chat.mktrunk.nothing-made")}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("window.chat.mktrunk.cancel")}</button><button class="btn pri" type="button" data-act="mk-go">${t("window.chat.mktrunk.propose")}</button>` });
}

/* The owner's words only: an empty box sends nothing (the placeholder is a hint, never the ask). */
async function propose() {
  const what = ($("#mk-what")?.value ?? "").trim();
  if (!what) { $("#mk-what")?.focus(); return; }
  closeDlg();
  await startWith(t("window.chat.mktrunk.ask", { what }));
}

async function make(id, thenEdit) {
  const p = MK.seen.get(id);
  if (!p || MK.busy.has(id)) return;
  MK.busy.add(id);
  render();
  try {
    const { trunk } = await api("trunks", { name: p.name, title: p.title, description: p.description });
    await refresh();
    toast(t("window.flows.trunk.ready", { name: trunk.name }));
    /* Hook (PARITY.md setup-delight-031, B4's leaf bursts): a Trunk made here is announced as the event "branch-made". */
    document.dispatchEvent(new CustomEvent("branch-made", { detail: { kind: "trunk", id: trunk.id, name: trunk.name } }));
    if (thenEdit) { const b = document.createElement("button"); b.dataset.id = trunk.id; run("edit", b); }
  } catch (error) { toast(error.message); }
  MK.busy.delete(id);
  render();
}

export function initMkTrunk() {
  on("mk-new", () => newDlg());
  on("mk-go", () => propose());
  on("mk-create", (el) => make(el.dataset.id, false));
  on("mk-change", (el) => make(el.dataset.id, true));
  on("mk-no", (el) => { MK.no.add(el.dataset.id); render(); });
  markLive(["mk-new", "mk-go", "mk-create", "mk-change", "mk-no", "sw:mk-what"]);
}
