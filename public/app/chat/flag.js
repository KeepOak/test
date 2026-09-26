/* Flag this reply (FEATURE-AUDIT `flag`, the prototype's pass 17): one or more reasons and a note, kept by the engine on
   this computer against that one reply (POST /api/reply-flags; the engine reads the reply's words itself). A flagged
   reply shows its flag under it with Remove (POST /api/reply-flags/{id}/remove), and its flag button is pressed; both are
   read from GET /api/reply-flags. Sending a flag to the Branch team has no engine route, so "Also send to the Branch
   team" and "Open that setting" stay greyed: nothing leaves this computer. */

import { $, esc, render } from "../core/dom.js";
import { openDlg, closeDlg, toast, ic } from "../core/ui.js";
import { api } from "../core/api.js";
import { E } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

/* The six reasons, each worded through t() when it is drawn (the language may change after this module loads). */
const REASONS = ["wrong", "ignored", "unasked", "unsafe", "unclear", "other"];
const reason = (k) => (REASONS.includes(k) ? t(`window.chat.flag.reason.${k}`) : k);
const F = { list: [], reply: null, pick: new Set() };
const words = (keys) => keys.map(reason).join(", ");

export const flagOf = (sessionId, messageId) => F.list.find((f) => f.sessionId === sessionId && f.messageId === messageId);

/* The line under a flagged reply. */
export function flagBadge(sessionId, m) {
  const f = m.messageId ? flagOf(sessionId, m.messageId) : null;
  return f ? `<div class="flb17c">${ic("flag", "s")}<span>${t("window.chat.flag.flagged", { reasons: esc(words(f.reasons)) })}</span><button type="button" data-act="flrm17c" data-v="${esc(f.id)}">${t("accounts.action.remove")}</button></div>` : "";
}

export async function loadFlags() {
  /* Q261: the flags are one list for every conversation, the owner's included, so a household person reads none
     (flagging is the owner's too). E.profiles is read with E.state. */
  if (E.profiles?.isOwner === false) return;
  let list;
  try { list = (await api("reply-flags")).flags ?? []; } catch (error) { toast(error.message); return; }
  const changed = JSON.stringify(list) !== JSON.stringify(F.list);
  F.list = list;
  if (changed) render();
}

const sendRow = () => `<div class="flsend17c off17c"><input type="checkbox" class="sw" id="fl-send17c" aria-label="${esc(t("window.chat.flag.send"))}"><span class="grow"><b>${esc(t("window.chat.flag.send"))}</b><small>${esc(t("window.chat.flag.send-off"))}</small></span><button class="link" type="button" data-act="flgo17c">${esc(t("window.chat.flag.open-setting"))}</button></div>`;

function openFlag(el) {
  F.reply = { sessionId: el.dataset.sid, messageId: Number(el.dataset.mid) };
  F.pick = new Set();
  const said = (el.closest("[data-i15]")?.querySelector(".txt")?.textContent ?? "").trim().slice(0, 70);
  const chips = REASONS.map((k) => `<button type="button" class="chip6" data-act="flr17c" data-v="${k}" aria-pressed="false">${esc(reason(k))}</button>`).join("");
  openDlg({ title: t("window.chat.flag.title"),
    body: `<p class="lede" data-css="margin:0 0 10px">${t("window.chat.flag.lede", { reply: esc(said) })}</p><div class="flr17c" role="group" aria-label="${esc(t("window.chat.flag.what-went-wrong"))}">${chips}</div><div class="field"><label for="fl-note17c">${esc(t("window.chat.flag.note"))}</label><textarea class="inp" id="fl-note17c" rows="3" placeholder="${esc(t("window.chat.flag.note-hint"))}"></textarea></div>${sendRow()}`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="flsave17c">${esc(t("window.chat.flag.keep"))}</button>` });
}

function pick(el) {
  const k = el.dataset.v, had = F.pick.has(k);
  if (had) F.pick.delete(k); else F.pick.add(k);
  el.setAttribute("aria-pressed", String(!had));
}

async function save() {
  if (!F.pick.size) { toast(t("window.chat.flag.pick")); return; }
  try {
    const kept = await api("reply-flags", { ...F.reply, reasons: [...F.pick], note: $("#fl-note17c")?.value ?? "" });
    closeDlg();
    toast(kept.said);
  } catch (error) { toast(error.message); }
  await loadFlags();
}

async function remove(el) {
  try { toast((await api(`reply-flags/${encodeURIComponent(el.dataset.v)}/remove`, {})).said); } catch (error) { toast(error.message); }
  await loadFlags();
}

export function initFlag() {
  markLive(["flag", "flr17c", "flsave17c", "flrm17c", "sw:fl-note17c"]);
  on("flag", (el) => openFlag(el));
  on("flr17c", (el) => pick(el));
  on("flsave17c", () => save());
  on("flrm17c", (el) => remove(el));
}
