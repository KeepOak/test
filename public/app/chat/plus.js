/* The composer's + menu, 1:1 with the prototype's. Attach files reads the picked files in this window and sends them with
   the next message (POST /api/run attachments, within the engine's limits); Mention and Use a skill type @ or / into the box;
   Temporary conversation starts the next conversation as one the engine never keeps (POST /api/run temporary); Who
   answers in this conversation is Branch or one of the engine's Trunks (GET and POST /api/trunks/conversations/<id>; the
   Trunks only while the engine's "conversations" part is on),
   drawn for an ordinary or Trunk conversation once the engine has said who answers it. Folders, screenshots and asking
   questions first stay greyed until the engine can do them. */

import { $, esc, applyCss, renderNow } from "../core/dom.js";
import { ic, openPop, closePop, mi, toast } from "../core/ui.js";
import { S, E, refresh } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { plusMore } from "./media.js";
import { t } from "../../i18n.js";
import { plus17d } from "./calls17d.js"; // pass 17 part D §2 (greyed)

const MAX_FILES = 6, MAX_BYTES = 32 * 1024 * 1024;
const Q = { files: [], temporary: false, who: null, whoFor: null };

function menu() {
  return mi("attach", "clip", t("window.chat.plus.attach")) + mi("add-folder", "folder", t("window.chat.plus.folder")) + mi("shot", "camera", t("window.chat.plus.screenshot")) + "<hr>"
    + mi("insert", "at", t("rooms.mentionList"), "<kbd>@</kbd>", 'data-v="@"') + mi("insert", "slash", t("window.chat.plus.skill"), "<kbd>/</kbd>", 'data-v="/"') + "<hr>"
    + `<div class="row-in"><span class="ic-t">${ic("ghost", "s")}${t("window.chat.plus.temporary")}</span><input class="sw" type="checkbox" id="pm-temp" data-sw="temp" ${Q.temporary ? "checked" : ""} ${S.chat ? "disabled" : ""} aria-label="${t("window.chat.plus.temporary")}"></div><div class="row-in"><span class="ic-t">${ic("help", "s")}${t("more.askFirst")}</span><input class="sw" type="checkbox" id="pm-ask" data-sw="askqs" aria-label="${t("more.askFirst")}"></div>`
    + whoRows() + "<hr>" + mi("goal-fill", "target", t("window.chat.plus.goal"), "<kbd>/goal</kbd>") // handled in goal.js
    + mi("prompts-fill", "star", t("settings-kit.name.prompts"), "<kbd>/</kbd>"); // handled in messages.js
}

/* Who answers the open conversation, as the engine said when it was opened; a room is chosen through its members instead.
   The list is who may be chosen, as the prototype's is: while the engine's "conversations" part is off (GET /api/trunks
   modes.conversations) it refuses a Trunk, so only Branch is offered, and a Trunk already answering stays shown, greyed. */
const radio = (v, name, s, on, off = false) => `<button class="mi" type="button" role="menuitemradio" aria-checked="${on}" data-act="who" data-v="${esc(v)}"${off ? ' disabled aria-disabled="true"' : ""}><span class="tick">${ic("check", "s")}</span><span><span class="mi-t">${esc(name)}</span>${s ? `<span class="mi-s">${s}</span>` : ""}</span></button>`;
function whoRows() {
  const w = Q.whoFor === S.chat ? Q.who : null;
  if (!S.chat || !w || (w.kind !== "plain" && w.kind !== "trunk")) return "";
  const now = w.trunk?.id ?? "", off = (E.trunkModes?.conversations ?? "off") === "off";
  return `<hr><div class="ph">${t("window.chat.plus.who")}</div>` + radio("", "Branch", t("window.chat.plus.assistant"), now === "")
    + (w.trunks ?? []).filter((tr) => !off || now === tr.id).map((tr) => radio(tr.id, tr.name, "", now === tr.id, off)).join("");
}

/** What the engine said about the open conversation (GET /api/trunks/conversations/<id>), or null. */
export const whoHere = () => (Q.whoFor === (S.chat ?? null) ? Q.who : null);
/** Reads it again on the next loadWho (after a Trunk was chosen, or a room made). */
export function forgetWho() { Q.whoFor = undefined; }

/* After the conversation is drawn: ask the engine who answers it, once per conversation. With Trunks off it has no answer. */
export async function loadWho() {
  const sid = S.chat ?? null;
  if (Q.whoFor === sid) return;
  Q.whoFor = sid;
  Q.who = null;
  const who = sid ? await api(`trunks/conversations/${encodeURIComponent(sid)}`).catch(() => null) : null;
  if (Q.whoFor !== sid) return;
  Q.who = who;
  /* The replies are signed from it, so the conversation is drawn again once it is known. */
  if (who && S.view === "chat") renderNow();
}

async function chooseWho(el) {
  const sid = S.chat;
  closePop();
  if (!sid) return;
  try { Q.who = await api(`trunks/conversations/${encodeURIComponent(sid)}`, { trunkId: el.dataset.v || null }); } catch (error) { toast(error.message); return; }
  Q.whoFor = sid;
  await refresh().catch((error) => toast(error.message));
  renderNow();
  toast(t("window.chat.plus.answers", { name: Q.who.trunk?.name ?? "Branch" }));
}

/* The files waiting to go with the next message, in the design's file chip; clicking one takes it off. */
export function attached() {
  if (!Q.files.length) return "";
  return `<div class="acts" data-css="margin:0 0 6px;flex-wrap:wrap">${Q.files.map((f, i) => `<button class="file" type="button" data-act="unattach" data-i="${i}" aria-label="${t("window.chat.media.remove", { name: esc(f.name) })}"><span class="fi">${esc(f.name.split(".").pop())}</span><span><b>${esc(f.name)}</b><small>${t("window.chat.plus.kb", { n: Math.max(1, Math.round(f.size / 1024)) })}</small></span></button>`).join("")}</div>`;
}

/* What the next message carries; handed over once, then cleared. */
export function takePending(isNew) {
  const out = {};
  if (Q.files.length) out.attachments = Q.files.map(({ mediaType, name, data }) => ({ mediaType, name, data }));
  if (isNew && Q.temporary) out.temporary = true;
  Q.files = [];
  Q.temporary = false;
  return out;
}

const read = (file) => new Promise((done, fail) => {
  const r = new FileReader();
  r.onload = () => done(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => fail(r.error);
  r.readAsDataURL(file);
});

async function pick() {
  closePop();
  const input = Object.assign(document.createElement("input"), { type: "file", multiple: true });
  input.addEventListener("change", async () => {
    for (const file of input.files) {
      const total = Q.files.reduce((n, f) => n + f.size, 0) + file.size;
      if (Q.files.length >= MAX_FILES || total > MAX_BYTES) { toast(t("window.chat.plus.too-many", { files: MAX_FILES, mb: MAX_BYTES / 1048576 })); break; }
      Q.files.push({ name: file.name, size: file.size, mediaType: file.type || "application/octet-stream", data: await read(file) });
    }
    redraw();
  });
  input.click();
}

function redraw() {
  const box = $("#attached");
  if (!box) return;
  box.innerHTML = attached();
  applyCss(box);
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
  markLive(["plusmenu", "attach", "unattach", "insert", "sw:pm-temp", "who"]);
  on("plusmenu", (el) => openPop(el, menu() + plusMore() + plus17d()));
  on("attach", () => pick());
  on("unattach", (el) => { Q.files.splice(+el.dataset.i, 1); redraw(); });
  on("insert", (el) => insert(el.dataset.v));
  on("who", (el) => chooseWho(el));
  document.addEventListener("change", (e) => { if (e.target.id === "pm-temp") Q.temporary = e.target.checked; });
}
