import { settingsRow, dropdownRow, segmentedRow, switchRow } from "../row-kit.js";
/* Settings › Voice, 1:1 with the prototype's page, from the engine:
   the voice settings (GET /api/voice/settings), the push-to-talk key (the comfort card
   "voice", POST /api/comfort { card, values }, merged), dictation in the message box and how long a quiet room ends it
   (GET/POST /api/voice/dictation { mode, silenceSeconds }), the wake word switch (GET/POST /api/voice/wake { mode }) and
   the computer's own voices (GET /api/voice/voices). "Answer aloud" is the read-aloud setting (POST /api/voice/settings
   { autoReadAloud }, merged). The spoken morning brief is the engine's personal part "spoken-brief" (GET /api/personal
   modes, POST /api/personal/switch { part, mode }), on unless "off", turned on as "when-needed"; it is the owner's alone.
   "Voice" reads replies aloud in one of the computer's voices (POST /api/voice/settings { voiceId,
   autoReadAloud }, merged; the voice the speech routes use), or Off (autoReadAloud false). "Listening" and Answer aloud's "When I talk" have no single engine setting behind them, so they are drawn
   greyed. */
import { esc, render } from "../../core/dom.js";
import { level, E, S, activeId } from "../../core/state.js";
import { api, token } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { toast } from "../../core/ui.js";
import { ctlSeg } from "../parts.js";
import { voice17 } from "../p17-more.js";
import { t } from "../../../i18n.js";
import { calls17d } from "../../chat/calls17d.js"; // pass 17 part D §2 (greyed)

const V = { settings: null, comfort: null, dictation: null, dictationHow: "", wake: null, voices: [], brief: null };
let epoch = 0, writing = false, displayed = null;
const locked = () => ["locked", "locked-b17"].some(name => document.getElementById("app")?.classList.contains(name));
const scope = () => ({profile:E.profiles, id:activeId(), key:token.get(), epoch});
const valid = state => S.signedIn && !locked() && state.epoch === epoch && state.profile === E.profiles && state.id === activeId() && state.key === token.get();
const owner = () => E.profiles?.isOwner === true && S.signedIn && !locked();
function clearStaleVoice() {
  if (displayed && (!S.signedIn || locked() || displayed.id !== activeId() || displayed.key !== token.get() || displayed.profile?.isOwner !== E.profiles?.isOwner)) {
    Object.assign(V, {settings:null, comfort:null, dictation:null, dictationHow:"", wake:null, voices:[], brief:null});
    displayed = null;
    stopCapture();
  }
}
const ctl = (id, title, description, checked) => switchRow({id, title, description, checked, attributes:`data-sw="set"${owner() ? "" : ' disabled data-why="knobs-owner-only"'}`});
async function writeVoice(path, part, accept) {
  const state = scope(); if (!valid(state) || !owner() || writing) return;
  writing = true;
  try {
    const profiles = await api("profiles");
    if (!valid(state) || !profiles.isOwner || (profiles.active?.id ?? null) !== state.id) return;
    const got = await api(path, part); if (valid(state) && owner()) { accept(got); render(); }
  } catch (error) { if (valid(state)) toast(error.message); }
  finally { writing = false; if (valid(state)) render(); }
}

async function loadVoice() {
  const state = scope(); if (!valid(state)) return;
  if (E.profiles?.isOwner !== false && !owner()) return;
  /* Q261: the speech settings, the push-to-talk key and the voices are the owner's; a household person reads only
     their own thinned dictation and wake word cards. */
  if (E.profiles?.isOwner === false) {
    Object.assign(V, {settings:null, comfort:null, voices:[], brief:null, dictation:null, wake:null, dictationHow:""});
    try {
      const [dictation, wake] = await Promise.all([api("voice/dictation"), api("voice/wake")]);
      if (!valid(state)) return;
      displayed = state;
      V.dictation = dictation.settings ?? null;
      V.wake = wake.mode ?? wake.settings?.mode ?? null;
    } catch (error) { toast(error.message); }
    render();
    return;
  }
  try {
    const [settings, comfort, dictation, wake, voices, personal] = await Promise.all([
      api("voice/settings"), api("comfort"), api("voice/dictation"), api("voice/wake"), api("voice/voices"),
      api("personal").catch((error) => { toast(error.message); return null; }),
    ]);
    if (!valid(state) || !owner()) return;
    displayed = state;
    V.settings = settings;
    V.comfort = comfort.values?.voice ?? null;
    V.dictation = dictation.settings ?? null;
    V.dictationHow = dictation.engine?.how ?? ""; // RES-709: what the microphone button would really use here
    V.wake = wake.mode ?? wake.settings?.mode ?? null;
    V.brief = personal?.modes?.["spoken-brief"] ?? null;
    V.voices = [...new Set([...(voices.windows ?? []), ...(voices.system ?? [])].filter((n) => typeof n === "string"))];
  } catch (error) { toast(error.message); }
  render();
}

/* Each save sends only the part it changes; the engine merges it and answers what is now in force. */
async function saveDictation(part) {
  return writeVoice("voice/dictation", part, r => { V.dictation = r.settings; V.dictationHow = r.state?.engine?.how ?? V.dictationHow; });
}
async function saveWake(mode) {
  return writeVoice("voice/wake", {mode}, r => { V.wake = r.state?.mode ?? r.settings?.mode ?? mode; });
}
async function saveBrief(on) {
  return writeVoice("personal/switch", {part:"spoken-brief", mode:on ? "when-needed" : "off"}, r => { V.brief = r.mode ?? V.brief; });
}
async function saveKey(pushToTalkKey) {
  return writeVoice("comfort", {card:"voice", values:{pushToTalkKey}}, r => { V.comfort = r.values?.voice ?? V.comfort; });
}

/* The next key pressed, written the way the engine's keyCombo reads it ("Ctrl+K", "F8"); Escape leaves it as it was. */
const MODS = ["Control", "Alt", "Shift", "Meta"];
function comboOf(e) {
  const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", key].filter(Boolean).join("+");
}
/* One capture at a time; opening the page again drops one still waiting. */
let waiting = null;
function stopCapture() { if (waiting) window.removeEventListener("keydown", waiting, true); waiting = null; }
function captureKey() {
  const state = scope(); if (!owner() || !valid(state)) return;
  stopCapture();
  toast(t("window.settings.voice.press-the-key-you-want-to"));
  waiting = (e) => {
    if (MODS.includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    stopCapture();
    if (e.key !== "Escape" && valid(state)) saveKey(comboOf(e));
  };
  window.addEventListener("keydown", waiting, true);
}

const num = (id, title, sub, value, unit, attrs = "") => settingsRow({title, description:sub, control:`<span class="num15"><input class="inp" id="${id}" value="${esc(value ?? "")}" aria-label="${esc(title)}" data-sw="set" ${attrs}${owner() ? "" : " disabled"}>${unit ? `<small>${esc(unit)}</small>` : ""}</span>`});

function talking() {
  const key = V.comfort?.pushToTalkKey ?? "";
  const listening = !V.settings ? "" : V.wake && V.wake !== "off" ? t("window.settings.voice.wake-word") : key ? t("window.settings.voice.push-to-talk") : t("accounts.switch.off");
  return `<div class="sec"><h2>${t("window.settings.voice.talking")}</h2>${ctlSeg(t("dictation.listening"), t("window.settings.voice.push-to-talk-holds-the-key"), [t("accounts.switch.off"), t("window.settings.voice.push-to-talk"), t("window.settings.voice.wake-word")], listening, "f15-listening")}
    ${settingsRow({title:t("comfort.field.pushToTalkKey"), description:t("settings.voice.key-help"), control:`${key ? `<kbd>${esc(key)}</kbd>` : ""}<button class="btn sm" type="button" data-act="ptt-key"${owner() ? "" : " disabled"}>${esc(t("window.settings.voice.change"))}</button>`})}</div>`;
}

function speakingBack() {
  const s = V.settings ?? {}, reads = !!s.autoReadAloud;
  const voices = [...V.voices.map(n => [n,n]), ...(s.voiceId && !V.voices.includes(s.voiceId) ? [[s.voiceId,t("settings.voice.saved", {name:s.voiceId})]] : []), ["off",t("accounts.switch.off")]];
  const dict = !!V.dictation && V.dictation.mode !== "off";
  return `<div class="sec"><h2>${t("window.settings.voice.speaking-back")}</h2>${dropdownRow({title:t("field.voice"), description:t("settings.voice.picker-help"), dropdown:{id:"v-voice-choice", options:V.settings ? voices : [["",t("settings.voice.unavailable")]], value:reads ? s.voiceId : "off", attrs:owner() && V.settings ? "" : "disabled"}})}
    ${ctl("v-dict", t("window.settings.voice.dictation-in-the-message-box"), [t("window.settings.voice.the-microphone-button-turns-speech-into"), V.dictationHow].filter(Boolean).join(" "), dict)}</div>`;
}

function listeningMore() {
  const wake = !!V.wake && V.wake !== "off";
  return `<div class="sec x15-sec"><h2>${t("window.settings.voice.listening-more")}</h2>${ctl("f15-wake-word", t("window.settings.voice.wake-word"), t("window.settings.voice.hey-branch-heard-on-this-computer"), wake)}
    ${num("f15-silence", t("window.settings.voice.stop-listening-after-silence"), t("settings.help.dictation-silence"), V.dictation?.silenceSeconds, "s", 'type="number" min="1" max="30" step="0.5"')}
    ${answerAloud()}
    ${ctl("f15-spoken-morning-brief", t("window.settings.voice.spoken-morning-brief"), t("window.settings.voice.the-written-brief-read-out"), !!V.brief && V.brief !== "off")}</div>`;
}

/* Answer aloud is the engine's read-aloud setting (autoReadAloud, readAloudWhen), which chat/aloud.js acts on: Always
   reads each new reply aloud, When I talk only a reply to a message dictated in the window, Never none. */
function answerAloud() {
  const cur = !V.settings ? null : !V.settings.autoReadAloud ? "never" : V.settings.readAloudWhen === "spoken" ? "talk" : "always";
  return segmentedRow({title:t("personal.voice.answer"), description:t("settings.help.voice-aloud"), options:[["never",t("window.settings.advanced.never")],["talk",t("window.settings.voice.when-i-talk")],["always",t("window.places.automations.always")]], current:cur, action:"aloud15", attributes:()=>owner() ? "" : "disabled"});
}
/* Voice: a computer voice reads replies aloud in that voice; Off stops reading aloud. */
async function saveVoice(v) {
  if (v !== "off" && !V.voices.includes(v) && v !== V.settings?.voiceId) return;
  return writeVoice("voice/settings", v === "off" ? {autoReadAloud:false} : {voiceId:v, autoReadAloud:true}, r => { V.settings = r; });
}
async function saveAloud(v) {
  if (!["never", "talk", "always"].includes(v)) return;
  const change = v === "never" ? { autoReadAloud: false } : { autoReadAloud: true, readAloudWhen: v === "talk" ? "spoken" : "always" };
  return writeVoice("voice/settings", change, r => { V.settings = r; });
}

export function draw() {
  clearStaleVoice();
  const lv = level();
  return `<h1>${t("field.voice")}</h1><p class="lede">${t("window.settings.voice.talking-to-branch-voice-stays-on")}</p>${talking()}${speakingBack()}${lv >= 1 ? listeningMore() : ""}${voice17(lv)}${lv >= 1 ? calls17d() : ""}`;
}

export function init() {
  const app = document.getElementById("app");
  if (app) new MutationObserver(() => { if (locked()) { epoch++; stopCapture(); Object.assign(V, {settings:null, comfort:null, dictation:null, dictationHow:"", wake:null, voices:[], brief:null}); } }).observe(app, {attributes:true, attributeFilter:["class"]});
  loadVoice();
  on("ptt-key", () => captureKey());
  on("aloud15", (el) => saveAloud(el.dataset.v));
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "v-voice-choice") saveVoice(t.value);
    else if (t.id === "v-dict") saveDictation({ mode: t.checked ? "when-needed" : "off" });
    else if (t.id === "f15-wake-word") saveWake(t.checked ? "on" : "off");
    else if (t.id === "f15-spoken-morning-brief") saveBrief(t.checked);
    else if (t.id === "f15-silence") {
      const n = Number(t.value);
      if (t.value.trim() && Number.isFinite(n)) saveDictation({ silenceSeconds: n }); else render();
    }
  });
  markLive(["ptt-key", "aloud15", "sw:v-voice-choice", "sw:v-dict", "sw:f15-wake-word", "sw:f15-silence", "sw:f15-spoken-morning-brief"]);
}

export function load() { stopCapture(); return loadVoice(); }

export const live = { "ptt-key": true, aloud15: true, "sw:v-voice-choice": true, "sw:v-dict": true, "sw:f15-wake-word": true, "sw:f15-silence": true, "sw:f15-spoken-morning-brief": true };
