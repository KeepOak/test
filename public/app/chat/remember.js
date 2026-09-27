/* "Remember this?" in the conversation (design doc 4.2): a fact a task in this conversation suggested remembering, which
   the engine keeps as a suggestion until the owner answers (state.memoryProposals, kind "put", the task's run in
   state.runs). Remember accepts it into memory and Don't turns it down: POST /api/memory/proposals/<id>/accept|reject.
   An answer given here stays shown as the engine answered it. */

import { esc, renderNow } from "../core/dom.js";
import { E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const decided = new Map();
const wrap = (inner) => `<div class="b"><div class="gut"></div><div>${inner}</div></div>`;

function card(p) {
  return wrap(`<div class="card" data-css="padding:12px 14px"><div class="card-h"><b>${t("window.chat.mem.remember-this")}</b><span class="pill idle ml">${t("memory.movein.kind.memory")}</span></div><div class="sub">${esc(p.text)}</div><div class="acts"><button class="btn pri sm" type="button" data-act="mem" data-id="${esc(p.id)}" data-v="kept">${t("window.chat.mem.remember")}</button><button class="btn ghost sm" type="button" data-act="mem" data-id="${esc(p.id)}" data-v="forgot">${t("window.chat.mem.dont")}</button></div></div>`);
}
function answered(d) {
  const kept = d.status === "accepted";
  return wrap(`<div class="decided"><span class="pill ${kept ? "done" : "idle"}"><i></i>${kept ? t("window.chat.mem.remembered") : t("window.chat.mem.not-remembered")}</span><span>${esc(d.text)}</span></div>`);
}

/* Every suggestion made by a task of this conversation: waiting ones as cards, answered ones as the engine answered. */
export function rememberCards(sessionId) {
  if (!sessionId || !E.state) return "";
  const mine = new Set((E.state.runs ?? []).filter((r) => r.sessionId === sessionId).map((r) => r.id));
  const waiting = (E.state.memoryProposals ?? []).filter((p) => p.kind === "put" && p.status === "pending" && mine.has(p.runId) && !decided.has(p.id));
  const done = [...decided.values()].filter((d) => d.sessionId === sessionId);
  return done.map(answered).join("") + waiting.map(card).join("");
}

export function initRemember() {
  markLive(["mem"]);
  on("mem", async (el) => {
    const proposal = (E.state?.memoryProposals ?? []).find((p) => p.id === el.dataset.id);
    const run = (E.state?.runs ?? []).find((r) => r.id === proposal?.runId);
    let result;
    try { result = await api(`memory/proposals/${encodeURIComponent(el.dataset.id)}/${el.dataset.v === "kept" ? "accept" : "reject"}`, {}); } catch (error) { toast(error.message); return; }
    decided.set(el.dataset.id, { status: result.proposal?.status, text: proposal?.text ?? result.proposal?.text ?? "", sessionId: run?.sessionId });
    await refresh().catch((error) => toast(error.message));
    renderNow();
  });
}
