/* Dictate into the box with the engine's own dictation (mac7/live-voice), drawn 1:1 with the prototype's composer:
   the mic (data-act="dict") starts it with POST /api/voice/dictation/listen { on: true }, which opens the microphone on
   this computer; while it listens the box gives way to "Listening… speak naturally" and Done. Done stops it
   ({ on: false }) and the words GET /api/voice/dictation settled on go in the box; the engine stopping by itself after a
   silence ends it the same way. Where the engine says it cannot dictate (canDictate false), the mic is greyed and
   carries the engine's own words for why. */

import { $, esc, renderNow } from "../core/dom.js";
import { E } from "../core/state.js";
import { toast, ic } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";
import { recordInWindow } from "./dictate-window.js";
import { heardSpeech } from "./aloud.js";

const D = { state: null, reading: false, on: false, timer: null, base: "", heard: "", rec: null, pressAt: 0, pointer: false };
/* RES-709: no streaming speech program, but a free one is here, so the window records with its own microphone. */
const inWindow = () => D.state?.engine?.kind === "window-mic";

/* The engine's picture of dictation, read once the window is signed in (and again on each press). */
async function read() {
  try { D.state = await api("voice/dictation"); } catch (error) { toast(error.message); }
  return D.state;
}
export function loadDictation() {
  if (D.state || D.reading || !E.loaded) return;
  D.reading = true;
  read().finally(() => { D.reading = false; redrawMic(); });
}
/* Only the mic changes with what the engine said, so only the mic is drawn again (the rest of the view is left as is). */
function redrawMic() {
  const mic = document.querySelector(`.composer button[aria-label="${t("window.chat.dict.label")}"]`);
  if (!mic) return;
  mic.outerHTML = micButton();
}

export const dictating = () => D.on;

export function micButton() {
  if (D.state?.canDictate === false) {
    const why = D.state.refusal || D.state.engine?.how || "";
    return `<button class="c-btn soon" type="button" aria-label="${t("window.chat.dict.label")}" aria-disabled="true" tabindex="-1" data-tip="${esc(why)}">${ic("mic")}</button>`;
  }
  return `<button class="c-btn" type="button" aria-label="${t("window.chat.dict.label")}" data-act="dict">${ic("mic")}</button>`;
}

export const dictRow = () => `<div class="dict"><span class="wave" aria-hidden="true">${"<i></i>".repeat(9)}</span><span class="dict-cap" aria-live="polite">${D.heard ? esc(D.heard) : t("window.chat.dict.listening")}</span><span class="tb-grow"></span><button class="btn sm" type="button" data-act="dict-done">${t("first-run-steps.done")}</button></div>`;

/* The words go after what was in the box when Dictate was pressed, as typed words would, and follow the engine's words
   as they come (the box stays in the composer, hidden behind the listening row, so a redraw keeps them); the box tells
   the conversation it changed, which keeps the draft. */
function put(words) {
  const box = $("#prompt");
  if (!box) return;
  box.value = D.base + words;
  if (words) heardSpeech(); // the message is spoken, for Answer aloud › When I talk (chat/aloud.js)
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

/* The live caption over the box, drawn in place so the recording is not disturbed by a redraw. */
function caption(words) {
  D.heard = words;
  put(words);
  const cap = document.querySelector(".composer .dict-cap");
  if (cap) cap.textContent = words || t("window.chat.dict.listening");
}

/* RES-709: the window's own microphone, opened on this press and let go of when the recording stops. */
async function startInWindow(state) {
  if (state.refusal) { toast(state.refusal); return; }
  const typed = $("#prompt")?.value ?? "";
  Object.assign(D, { on: true, heard: "", base: typed.trim() ? typed.replace(/\s*$/, " ") : "" });
  renderNow();
  try {
    D.rec = await recordInWindow({ onWords: caption, onFail: (error) => toast(error.message) });
  } catch (error) {
    D.rec = null;
    toast(error.name === "NotAllowedError" ? t("window.chat.dict.mic-refused") : error.message);
    finish("");
    return;
  }
  if (!D.on) D.rec.stop(); // let go before the microphone finished opening
}

/* The engine's settled words when it gave them, else the last words it heard. */
function finish(words) {
  clearInterval(D.timer);
  D.timer = null;
  D.on = false;
  D.rec = null;
  countDictation();
  renderNow();
  put(typeof words === "string" ? words.trim() : D.heard);
  const box = $("#prompt");
  box?.focus();
  box?.setSelectionRange(box.value.length, box.value.length);
}

async function start() {
  const state = await read();
  if (!state || state.canDictate === false) { renderNow(); return; }
  if (inWindow()) { await startInWindow(state); return; }
  let said;
  try { said = await api("voice/dictation/listen", { on: true }); } catch (error) { toast(error.message); return; }
  if (said.state) D.state = said.state;
  if (said.refusal) toast(said.refusal);
  if (!said.open) { renderNow(); return; }
  const typed = $("#prompt")?.value ?? "";
  Object.assign(D, { on: true, heard: "", base: typed.trim() ? typed.replace(/\s*$/, " ") : "" });
  renderNow();
  D.timer = setInterval(async () => {
    let now;
    try { now = await api("voice/dictation"); } catch (error) { toast(error.message); finish(); return; }
    if (!D.on) return;
    if (!now.open) { finish(now.words); return; }
    const words = String(now.words ?? "").trim();
    if (words !== D.heard) { D.heard = words; put(words); }
  }, 500);
}

async function done() {
  if (!D.on) return;
  if (D.rec || inWindow()) {
    const rec = D.rec;
    D.on = false;
    if (!rec) { finish(""); return; }
    rec.stop();
    finish(await rec.settled);
    return;
  }
  clearInterval(D.timer);
  try { await api("voice/dictation/listen", { on: false }); } catch (error) { toast(error.message); }
  let now = null;
  try { now = await api("voice/dictation"); } catch (error) { toast(error.message); }
  finish(now?.words);
}

/* ---------- pass 16: the wake word, offered once dictation has been used three times ---------- */
/* The count of finished dictations is this window's own (per computer, in its storage); the offer shows only while the
   engine's wake word is off and this computer can listen for one (GET /api/voice/wake). Turn on switches the engine's
   wake word on (POST /api/voice/wake), with the prototype's "Hey Branch" when no word was chosen; Not now puts it away. */
const W = { view: null, asked: false };
const stored = (key, value) => { try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { return null; } return value; }; // storage refused: the offer just waits
function countDictation() {
  const n = Number(stored("branch-dict-n16") ?? 0) + 1;
  stored("branch-dict-n16", String(n));
  if (n >= 3) readWake();
}
function readWake() {
  if (W.asked) return;
  W.asked = true;
  api("voice/wake").then((v) => { W.view = v; renderNow(); }, (error) => toast(error.message));
}
export function wakeOffer() {
  if (Number(stored("branch-dict-n16") ?? 0) < 3 || stored("branch-wake16") === "no") return "";
  readWake();
  if (!W.view || W.view.mode !== "off" || !W.view.canListen) return "";
  return `<div class="offer16" role="note">${ic("mic", "s")}<span class="grow"><b>${t("window.chat.wake.title")}</b><small>${t("window.chat.wake.body")}</small></span><button class="btn ghost sm" type="button" data-act="wake16" data-v="no">${t("updates.busy.cancel")}</button><button class="btn pri sm" type="button" data-act="wake16" data-v="yes">${t("window.chat.wake.on")}</button></div>`;
}
async function answerWake(yes) {
  if (!yes) { stored("branch-wake16", "no"); renderNow(); return; }
  let view;
  try { view = await api("voice/wake", { mode: "on", ...(W.view?.wordChosen ? {} : { word: "Hey Branch" }) }); } catch (error) { toast(error.message); return; }
  W.view = await api("voice/wake").catch(() => view);
  renderNow();
  toast(W.view?.refusal || t("window.chat.wake.done"));
}

export function initDictate() {
  markLive(["dict", "dict-done", "wake16"]);
  on("dict", () => {
    if (D.pointer) { D.pointer = false; return; } // a press of the pointer was handled where it went down
    if (!D.on) start(); else if (inWindow()) done();
  });
  // RES-709: hold Dictate to talk. Pressed and let go quickly it stays open until Done; held, letting go ends it.
  document.addEventListener("pointerdown", (event) => {
    if (!inWindow() || !event.target.closest?.('.composer [data-act="dict"]')) return;
    D.pointer = true;
    D.pressAt = Date.now();
    if (!D.on) start();
  });
  document.addEventListener("pointerup", () => {
    if (D.on && D.pressAt && inWindow() && Date.now() - D.pressAt > 450) done();
    D.pressAt = 0;
    setTimeout(() => { D.pointer = false; }); // after the click this press makes, if it makes one
  });
  on("dict-done", () => done());
  on("wake16", (el) => answerWake(el.dataset.v === "yes"));
}
