/* The composer's + menu, 1:1 with the prototype's. Attach files reads the picked files in this window and sends them with
   the next message (POST /api/run attachments, within the engine's limits); Mention and Use a skill type @ or / into the box;
   Temporary conversation starts the next conversation as one the engine never keeps (POST /api/run temporary); Who
   answers in this conversation is Branch or one of the engine's Trunks (GET and POST /api/trunks/conversations/<id>; the
   Trunks only while the engine's "conversations" part is on),
   drawn for an ordinary or Trunk conversation once the engine has said who answers it. Folders, screenshots and asking
   questions first stay greyed until the engine can do them. */

import { $, esc, renderNow } from "../core/dom.js";
import { ic, openPop, closePop, mi, toast } from "../core/ui.js";
import { S, E, refresh, defaultTrunk } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { plusMore } from "./media.js";
import { t } from "../../i18n.js";
import { plus17d } from "./calls17d.js"; // pass 17 part D §2 (greyed)
import { asksFirst } from "./askfirst.js"; // parity B1: Ask me questions first
import { openSkills } from "./messages.js"; // parity B1: Use a skill opens the Skills list
import { attachedChips, initAttach, pickFiles, removeFile, readyUploads } from "./attach.js"; // attach-anything
import { initPractice, loadPractice, practiceMenu, practiceNext } from "./practice-next.js";
import { initOura } from "../flows/oura.js";

const Q = { temporary: false, who: null, whoFor: null, pending: null, error: null };

function menu() {
  return mi("attach", "clip", t("window.chat.plus.attach")) + mi("add-folder", "folder", t("window.chat.plus.folder")) + mi("shot", "camera", t("window.chat.plus.screenshot")) + "<hr>"
    + mi("insert", "at", t("rooms.mentionList"), "<kbd>@</kbd>", 'data-v="@"') + mi("skills15", "slash", t("window.chat.plus.skill"), "<kbd>/</kbd>") + "<hr>"
    + `<div class="row-in"><span class="ic-t">${ic("ghost", "s")}${t("window.chat.plus.temporary")}</span><input class="sw" type="checkbox" id="pm-temp" data-sw="temp" ${Q.temporary ? "checked" : ""} ${S.chat ? "disabled" : ""} aria-label="${t("window.chat.plus.temporary")}"></div><div class="row-in"><span class="ic-t">${ic("help", "s")}${t("more.askFirst")}</span><input class="sw" type="checkbox" id="pm-ask" data-sw="askqs" ${asksFirst() ? "checked" : ""} aria-label="${t("more.askFirst")}"></div>`
    + practiceMenu() + whoRows() + "<hr>" + mi("goal-fill", "target", t("window.chat.plus.goal"), "<kbd>/goal</kbd>") // handled in goal.js
    + mi("prompts-fill", "star", t("settings-kit.name.prompts"), "<kbd>/</kbd>") + mi("oura", "star", "Private Oura summaries", "Opt-in daily data"); // handled in messages.js
}

/* Who answers the open conversation, as the engine said when it was opened; a room is chosen through its members instead.
   The list is who may be chosen, as the prototype's is: while the engine's "conversations" part is off (GET /api/trunks
   modes.conversations) it refuses a Trunk, so only Branch is offered, and a Trunk already answering stays shown, greyed. */
const radio = (v, name, s, on, off = false) => `<button class="mi" type="button" role="menuitemradio" aria-checked="${on}" data-act="who" data-v="${esc(v)}"${off ? ' disabled aria-disabled="true"' : ""}><span class="tick">${ic("check", "s")}</span><span><span class="mi-t">${esc(name)}</span>${s ? `<span class="mi-s">${s}</span>` : ""}</span></button>`;
/* A room's "Who answers" (Whoever fits, or one member) is drawn as the prototype draws it and stays greyed: the engine's
   room rule (mention, lead or all: the members @named, the first member, or everyone) has no "whoever fits" and no
   member of the owner's choosing, so neither choice maps onto it. */
function roomWho(w) {
  const members = (w.room?.members ?? []).map((m) => E.trunks.find((tr) => tr.id === (m.id ?? m)) ?? m).filter((m) => m?.name);
  const row = (v, name, s, on) => `<button class="mi" type="button" role="menuitemradio" aria-checked="${on}" data-act="who-room" data-v="${esc(v)}"><span class="tick">${ic("check", "s")}</span><span><span class="mi-t">${esc(name)}</span>${s ? `<span class="mi-s">${s}</span>` : ""}</span></button>`;
  return `<hr><div class="ph">${t("window.chat.plus.who-room")}</div>` + row("", t("window.chat.plus.whoever"), t("window.chat.plus.whoever-hint"), true) + members.map((m) => row(m.id ?? "", m.name, "", false)).join("");
}
function whoRows() {
  const w = Q.whoFor === S.chat ? Q.who : null;
  if (S.chat && w?.kind === "room") return roomWho(w);
  if (!S.chat || !w || (w.kind !== "plain" && w.kind !== "trunk")) return "";
  const now = w.trunk?.id ?? "", off = (E.trunkModes?.conversations ?? "off") === "off";
  const home = defaultTrunk();
  return `<hr><div class="ph">${t("window.chat.plus.who")}</div>` + (home ? radio("", home.name, t("look.badge.default"), now === home.id || now === "") : "")
    + (w.trunks ?? []).filter((tr) => tr.id !== home?.id && (!off || now === tr.id)).map((tr) => radio(tr.id, tr.name, "", now === tr.id, off)).join("");
}

/** Whether the next new conversation starts as a temporary one (the box shows its Temporary flag). */
export const temporaryNext = () => Q.temporary && !S.chat;
/** What the engine said about the open conversation (GET /api/trunks/conversations/<id>), or null. */
export const whoHere = () => (Q.whoFor === (S.chat ?? null) ? Q.who : null);
/** Reads it again on the next loadWho (after a Trunk was chosen, or a room made). */
export function forgetWho() { Q.whoFor = undefined; }

/* After the conversation is drawn: ask the engine who answers it, once per conversation. With Trunks off it has no answer. */
export function loadWho() {
  const sid = S.chat ?? null;
  if (Q.whoFor === sid) return Q.pending ?? Promise.resolve();
  Q.whoFor = sid;
  Q.who = null;
  Q.error = null;
  if (!sid) { Q.pending = null; return Promise.resolve(); }
  const pending = (async () => {
    const controller = new AbortController();
    let timeout;
    const expired = new Promise((_, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error("Conversation lookup timed out")); }, 15_000);
    });
    try {
      const who = await Promise.race([api(`trunks/conversations/${encodeURIComponent(sid)}`, undefined, undefined, controller.signal), expired]);
      if (Q.pending !== pending) return;
      Q.who = who;
      if (who && S.view === "chat") renderNow();
    } catch (error) {
      if (Q.pending === pending) Q.error = error;
    } finally {
      clearTimeout(timeout);
      if (Q.pending === pending) Q.pending = null;
    }
  })();
  Q.pending = pending;
  return pending;
}

/** A send must know its destination; background drawing may still be reading it. */
export async function readyWho() {
  const sid = S.chat ?? null;
  if (Q.whoFor === sid && Q.error) forgetWho();
  await loadWho();
  if (S.chat !== sid) throw new Error("The conversation changed. Your message was not sent.");
  if (Q.error || (sid && !Q.who)) throw new Error("Couldn't load this conversation. Your message was not sent. Try sending again.");
  return Q.who;
}

async function chooseWho(el) {
  const sid = S.chat;
  closePop();
  if (!sid) return;
  try { Q.who = await api(`trunks/conversations/${encodeURIComponent(sid)}`, { trunkId: el.dataset.v || null }); } catch (error) { toast(error.message); return; }
  Q.whoFor = sid;
  await refresh().catch((error) => toast(error.message));
  renderNow();
  toast(t("window.chat.plus.answers", { name: Q.who.trunk?.name ?? defaultTrunk()?.name ?? "" }));
}

/* The files waiting to go with the next message (chat/attach.js: sent ahead as soon as they are added, each a chip with
   its own preview and progress); a chip's x takes it off. */
export const attached = () => attachedChips();

/* What the next message carries: the ids of the files sent ahead, once all of them have arrived. The chips stay until the
   message is sent (filesSent), so a message the engine never got keeps its files (chat.js keepForLater). */
export { filesSent, resendFiles, hasFiles } from "./attach.js";
export async function takePending(isNew) {
  const out = {};
  const uploads = await readyUploads();
  if (uploads.length) out.uploads = uploads;
  if (practiceNext()) out.dryRun = true;
  if (isNew && Q.temporary) out.temporary = true;
  Q.temporary = false;
  return out;
}

function insert(text) {
  closePop();
  const box = $("#prompt");
  if (!box) return;
  const at = box.selectionStart ?? box.value.length;
  box.value = box.value.slice(0, at) + text + box.value.slice(box.selectionEnd ?? at);
  box.focus();
  box.setSelectionRange(at + text.length, at + text.length);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

export function initPlus() {
  initOura();
  markLive(["plusmenu", "attach", "add-folder", "unattach", "insert", "sw:pm-temp", "who", "skills15"]);
  initAttach();
  initPractice();
  /* Use a skill: the Skills list over the box; with no skill switched on, "/" in the box as before (the engine's commands). */
  on("skills15", () => { closePop(); if (!openSkills()) insert("/"); });
  /* The menu opens (or closes, on its own button) at once; Practice's availability is refreshed behind it. */
  on("plusmenu", (el) => { openPop(el, menu() + plusMore() + plus17d()); void loadPractice(); });
  on("attach", () => { closePop(); pickFiles(false); });
  on("add-folder", () => { closePop(); pickFiles(true); });
  on("unattach", (el) => removeFile(el.dataset.k));
  on("insert", (el) => insert(el.dataset.v));
  on("who", (el) => chooseWho(el));
  document.addEventListener("change", (e) => { if (e.target.id === "pm-temp") { Q.temporary = e.target.checked; renderNow(); } });
}
