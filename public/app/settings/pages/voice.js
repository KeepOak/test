/* Settings › Voice, 1:1 with the prototype's page, from the engine:
   the voice settings (GET /api/voice/settings), the push-to-talk key (the comfort card
   "voice", POST /api/comfort { card, values }, merged), dictation in the message box and how long a quiet room ends it
   (GET/POST /api/voice/dictation { mode, silenceSeconds }), the wake word switch (GET/POST /api/voice/wake { mode }) and
   the computer's own voices (GET /api/voice/voices). "Answer aloud" is the read-aloud setting (POST /api/voice/settings
   { autoReadAloud }, merged). "Listening", "Voice", Answer aloud's "When I talk" and the spoken morning brief have no
   single engine setting behind them, so they are drawn greyed. */
import { esc, render } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { toast } from "../../core/ui.js";
import { ctl, ctlSeg } from "../parts.js";
import { voice17 } from "../p17-more.js";
import { t } from "../../../i18n.js";
import { calls17d } from "../../chat/calls17d.js"; // pass 17 part D §2 (greyed)

const V = { settings: null, comfort: null, dictation: null, wake: null, voices: [] };

async function loadVoice() {
  /* Q261: the speech settings, the push-to-talk key and the voices are the owner's; a household person reads only
     their own thinned dictation and wake word cards. */
  if (E.profiles?.isOwner === false) {
    try {
      const [dictation, wake] = await Promise.all([api("voice/dictation"), api("voice/wake")]);
      V.dictation = dictation.settings ?? null;
      V.wake = wake.mode ?? wake.settings?.mode ?? null;
    } catch (error) { toast(error.message); }
    render();
    return;
  }
  try {
    const [settings, comfort, dictation, wake, voices] = await Promise.all([
      api("voice/settings"), api("comfort"), api("voice/dictation"), api("voice/wake"), api("voice/voices"),
    ]);
    V.settings = settings;
    V.comfort = comfort.values?.voice ?? null;
    V.dictation = dictation.settings ?? null;
    V.wake = wake.mode ?? wake.settings?.mode ?? null;
    V.voices = [...new Set([...(voices.windows ?? []), ...(voices.system ?? [])].filter((n) => typeof n === "string"))];
  } catch (error) { toast(error.message); }
  render();
}

/* Each save sends only the part it changes; the engine merges it and answers what is now in force. */
async function saveDictation(part) {
  try { V.dictation = (await api("voice/dictation", part)).settings; } catch (error) { toast(error.message); }
  render();
}
async function saveWake(mode) {
  try { const r = await api("voice/wake", { mode }); V.wake = r.state?.mode ?? r.settings?.mode ?? mode; } catch (error) { toast(error.message); }
  render();
}
async function saveKey(pushToTalkKey) {
  try { V.comfort = (await api("comfort", { card: "voice", values: { pushToTalkKey } })).values?.voice ?? V.comfort; } catch (error) { toast(error.message); }
  render();
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
  stopCapture();
  toast(t("window.settings.voice.press-the-key-you-want-to"));
  waiting = (e) => {
    if (MODS.includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    stopCapture();
    if (e.key !== "Escape") saveKey(comboOf(e));
  };
  window.addEventListener("keydown", waiting, true);
}

const num = (id, title, sub, value, unit, attrs = "") => `<div class="ctl"><b>${esc(title)}</b><span class="right num15"><input class="inp" id="${id}" value="${esc(value ?? "")}" aria-label="${esc(title)}" data-sw="set" ${attrs}>${unit ? `<small>${esc(unit)}</small>` : ""}</span><small>${esc(sub)}</small></div>`;

function talking() {
  const key = V.comfort?.pushToTalkKey ?? "";
  const listening = !V.settings ? "" : V.wake && V.wake !== "off" ? t("window.settings.voice.wake-word") : key ? t("window.settings.voice.push-to-talk") : t("accounts.switch.off");
  return `<div class="sec"><h2>${t("window.settings.voice.talking")}</h2>${ctlSeg(t("dictation.listening"), t("window.settings.voice.push-to-talk-holds-the-key"), [t("accounts.switch.off"), t("window.settings.voice.push-to-talk"), t("window.settings.voice.wake-word")], listening)}
    <div class="ctl"><b>${t("comfort.field.pushToTalkKey")}</b><span class="right">${key ? `<kbd data-css="font-size:12px;padding:4px 8px">${esc(key)}</kbd>` : ""}<button class="btn sm" type="button" data-act="ptt-key">${t("window.settings.voice.change")}</button></span><small>${t("window.settings.voice.hold-it-anywhere-in-windows")}</small></div></div>`;
}

function speakingBack() {
  const s = V.settings ?? {}, reads = !!s.autoReadAloud;
  const voices = [...V.voices.map((n) => [n, n, reads && s.voiceId === n]), ["off", t("accounts.switch.off"), !!V.settings && !reads]];
  const dict = !!V.dictation && V.dictation.mode !== "off";
  return `<div class="sec"><h2>${t("window.settings.voice.speaking-back")}</h2><div class="ctl"><b>${t("field.voice")}</b><span class="right"><span class="seg" role="group" aria-label="${t("field.voice")}">${voices.map(([, l, p]) => `<button type="button" aria-pressed="${p}" data-act="seg">${esc(l)}</button>`).join("")}</span></span><small>${t("window.settings.voice.read-replies-out-loud-in-this")}</small></div>
    ${ctl("v-dict", t("window.settings.voice.dictation-in-the-message-box"), t("window.settings.voice.the-microphone-button-turns-speech-into"), dict)}</div>`;
}

function listeningMore() {
  const wake = !!V.wake && V.wake !== "off";
  return `<div class="sec x15-sec"><h2>${t("window.settings.voice.listening-more")}</h2>${ctl("f15-wake-word", t("window.settings.voice.wake-word"), t("window.settings.voice.hey-branch-heard-on-this-computer"), wake)}
    ${num("f15-silence", t("window.settings.voice.stop-listening-after-silence"), t("window.settings.voice.for-live-dictation"), V.dictation?.silenceSeconds, "s", 'type="number" min="1" max="30" step="0.5"')}
    ${answerAloud()}
    ${ctl("f15-spoken-morning-brief", t("window.settings.voice.spoken-morning-brief"), t("window.settings.voice.the-written-brief-read-out"), false)}</div>`;
}

/* Answer aloud is the engine's read-aloud setting (autoReadAloud), which chat/aloud.js acts on: Always reads each new
   reply aloud, Never none. The engine cannot tell a spoken message from a typed one, so "When I talk" has no setting
   behind it (greyed). */
function answerAloud() {
  const cur = !V.settings ? null : V.settings.autoReadAloud ? "always" : "never";
  const opt = (v, l, act) => `<button type="button" aria-pressed="${cur === v}" data-act="${act}" data-v="${v}">${esc(l)}</button>`;
  return `<div class="ctl"><b>${t("personal.voice.answer")}</b><span class="right"><span class="seg" role="group" aria-label="${t("personal.voice.answer")}">${opt("never", t("window.settings.advanced.never"), "aloud15")}${opt("talk", t("window.settings.voice.when-i-talk"), "seg")}${opt("always", t("window.places.automations.always"), "aloud15")}</span></span><small></small></div>`;
}
async function saveAloud(on) {
  try { V.settings = await api("voice/settings", { autoReadAloud: on }); } catch (error) { toast(error.message); }
  render();
}

export function draw() {
  const lv = level();
  return `<h1>${t("field.voice")}</h1><p class="lede">${t("window.settings.voice.talking-to-branch-voice-stays-on")}</p>${talking()}${speakingBack()}${lv >= 1 ? listeningMore() : ""}${voice17(lv)}${lv >= 1 ? calls17d() : ""}`;
}

export function init() {
  loadVoice();
  on("ptt-key", () => captureKey());
  on("aloud15", (el) => saveAloud(el.dataset.v === "always"));
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "v-dict") saveDictation({ mode: t.checked ? "when-needed" : "off" });
    else if (t.id === "f15-wake-word") saveWake(t.checked ? "on" : "off");
    else if (t.id === "f15-silence") {
      const n = Number(t.value);
      if (t.value.trim() && Number.isFinite(n)) saveDictation({ silenceSeconds: n }); else render();
    }
  });
  markLive(["ptt-key", "aloud15", "sw:v-dict", "sw:f15-wake-word", "sw:f15-silence"]);
}

export function load() { stopCapture(); return loadVoice(); }

export const live = { "ptt-key": true, aloud15: true, "sw:v-dict": true, "sw:f15-wake-word": true, "sw:f15-silence": true };
