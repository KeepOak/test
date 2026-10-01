/* Talk live, 1:1 with the prototype's voice mode: the composer's wave button (data-act="voice") and the conversation
   menu's "Talk out loud" (data-act="call") open the full-window "Talking live" view with the orb, what is being said,
   Mute and End. Nothing here touches the microphone until the person presses one of those two.

   The engine's live route: POST /api/voice/live { sessionId } makes the task a live conversation hangs off (or refuses in
   its own words: no connection that can talk live, no key, Lockdown, a Trunk's or a room's conversation, a household
   person), then the task's socket (/api/runs/<id>/ws) is opened and told { live: "start" }. Once the engine answers
   "voice.live.ready" the microphone opens and its sound goes up as it is spoken; the answer's sound comes back in
   numbered blocks and plays in order. Mute holds the sound back on this computer. End says { live: "stop" }.
   It ends cleanly when the person ends it, when the engine ends it (its limits, a problem), when the socket closes, and
   when the window switches person (the engine ends the socket with reason "profile"). A socket that never opens a
   conversation stops the task it made (POST /api/runs/<id>/cancel), so it holds no update or quit. */

import { esc, applyCss } from "../core/dom.js";
import { E, chatFace, ownName } from "../core/state.js";
import { api, token, isDesktop } from "../core/api.js";
import { on } from "../core/actions.js";
import { app, av, toast, closePop } from "../core/ui.js";
import { markLive, greyOut } from "../core/features.js";
import { toPcm16, readAudioFrame } from "./talksound.js";
import { t } from "../../i18n.js";
import { openPeer, openingSlot } from "./talkpeer.js";

/* phase: idle → starting (task made, socket opening) → listening ⇄ speaking → idle. `call` numbers each press, so
   whatever finishes after its call has ended (a microphone still opening) can tell it is no longer wanted. */
const L = { phase: "idle", el: null, socket: null, mic: null, player: null, call: 0 };
let calls = 0;
const current = (call) => L.call === call && L.phase !== "idle";
let hooks = { state: () => ({}), reopen: async () => {} };

const fresh = () => ({ runId: null, sessionId: null, service: null, note: "", ready: false, muted: false, seconds: 0,
  timer: null, caption: "", partial: { person: "", assistant: "" }, last: "", nextAt: 0, playing: 0,
  generation: 0, audioItem: null, sources: new Set(), heardItems: new Map(), playedMs: 0, transport: null, peer: null });
/* The closer of a Talk live setup still in progress (talkpeer.js openingSlot). */
const opening = openingSlot();
Object.assign(L, fresh());

/* ---------- the view ---------- */

const clock = () => `${Math.floor(L.seconds / 60)}:${String(L.seconds % 60).padStart(2, "0")}`;
function caption() {
  if (L.phase === "starting") return "";
  return L.caption || (L.phase === "listening" ? t("window.chat.voice.listening") : "");
}
function viewHtml() {
  const name = ownName(L.sessionId) || E.state?.identity?.name || "";
  const who = name ? `${esc(t("window.chat.voice.talking-with", { name }))} · ` : "";
  const still = L.muted || L.phase === "starting";
  return `<div class="vin"><div class="v-top">${av(chatFace(L.sessionId), 28)}<span>${who}<span id="v-t">${clock()}</span></span></div>
    <div class="orb${still ? " muted" : ""}" aria-hidden="true"></div><p class="v-cap" id="v-cap" aria-live="polite">${esc(caption())}</p>
    <div class="acts"><button class="btn" type="button" data-act="v-mute" aria-pressed="${L.muted}">${t(L.muted ? "voiceView.unmute" : "voiceView.mute")}</button><button class="btn" type="button" data-act="v-interrupt">${t("voiceView.cutIn")}</button><button class="btn bad" type="button" data-act="v-end">${t("voiceView.end")}</button></div>
    ${L.note ? `<p class="hint" data-css="margin:0">${esc(L.note)}</p>` : ""}</div>`;
}
/* Drawn once into the window when Talk live opens, drawn again in place as it changes, and taken away when it ends. */
function draw() {
  if (L.phase === "idle") { L.el?.remove(); L.el = null; return; }
  if (!L.el) {
    L.el = document.createElement("div");
    L.el.className = "voice";
    L.el.setAttribute("role", "dialog");
    L.el.setAttribute("aria-label", t("window.chat.voice.talking-live"));
    app().appendChild(L.el);
  }
  L.el.dataset.state = L.phase;
  L.el.innerHTML = viewHtml();
  applyCss(L.el);
  greyOut(L.el);
}
function setPhase(phase) { if (L.phase !== "idle") { L.phase = phase; draw(); } }

/* ---------- sound in and out ---------- */

/* The microphone, opened only once the engine has said the conversation is ready, for that one call and its socket.
   OpenAI takes 24 kHz sound, Gemini 16. The desktop app lets the microphone be asked for once per call, when it opens.
   A microphone that finishes opening after its call has ended is let go at once and never sends anything. */
async function openMic(call, socket) {
  const rate = L.service === "openai" ? 24000 : 16000;
  if (isDesktop) await window.branchDesktop?.talkLiveMic?.();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: rate } });
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
  if (!current(call)) { stopTracks(); return null; }
  const context = new AudioContext({ sampleRate: rate });
  const close = () => { stopTracks(); void context.close(); };
  try {
    await context.audioWorklet.addModule(new URL("./talkmic.js", import.meta.url));
    const node = new AudioWorkletNode(context, "branch-mic", { numberOfOutputs: 0 });
    node.port.onmessage = (event) => {
      if (current(call) && L.socket === socket && !L.muted && socket.readyState === 1) socket.send(toPcm16(event.data).buffer);
    };
    context.createMediaStreamSource(stream).connect(node);
    await context.resume();
  } catch (error) { close(); throw error; }
  if (!current(call)) { close(); return null; }
  return { stream, close };
}
/* Each block of the answer plays after the one before it; when the last has played, it is listening again. */
function play(pcm16) {
  if (!pcm16.length) return;
  const item = L.audioItem;
  if (item && item.generation < L.generation) return;
  const player = (L.player ??= new AudioContext({ sampleRate: 24000 }));
  void player.resume();
  const buffer = player.createBuffer(1, pcm16.length, 24000);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm16.length; i++) channel[i] = pcm16[i] / 0x8000;
  const source = player.createBufferSource();
  source.buffer = buffer;
  source.connect(player.destination);
  L.nextAt = Math.max(L.nextAt, player.currentTime);
  const generation = L.generation;
  if (!L.playing) L.playedMs = 0;
  const key = item?.itemId ? `${item.itemId}:${item.contentIndex}` : "";
  if (key && !L.heardItems.has(key)) {
    if (L.heardItems.size >= 32) L.heardItems.delete(L.heardItems.keys().next().value);
    L.heardItems.set(key, { itemId: item.itemId, contentIndex: item.contentIndex, audioEndMs: 0 });
  }
  const entry = { source, start: L.nextAt, duration: buffer.duration, key, generation };
  L.sources.add(entry);
  source.start(L.nextAt);
  L.nextAt += buffer.duration;
  L.playing += 1;
  source.onended = () => {
    source.disconnect();
    if (generation !== L.generation || !L.sources.delete(entry)) return;
    const heard = L.heardItems.get(key);
    if (heard) heard.audioEndMs += buffer.duration * 1000;
    L.playedMs += buffer.duration * 1000;
    L.playing -= 1;
    if (!L.playing && L.phase === "speaking") setPhase("listening");
  };
  if (L.phase === "listening") setPhase("speaking");
}

/* Adapted from OpenClaw's MIT playback sink: only elapsed sound counts, queued sound does not.
   The generation retires scheduled callbacks and drops old binary frames still in transit. */
function playbackSnapshot() {
  const items = new Map([...L.heardItems].map(([key, item]) => [key, { ...item }]));
  for (const entry of L.sources) {
    const item = items.get(entry.key);
    if (item) item.audioEndMs += Math.max(0, Math.min(entry.duration, (L.player?.currentTime ?? 0) - entry.start)) * 1000;
  }
  return [...items.values()].map((item) => ({ ...item, audioEndMs: Math.floor(item.audioEndMs) }));
}
function clearPlayback() {
  L.generation += 1;
  for (const { source } of L.sources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
  L.sources.clear(); L.heardItems.clear();
  L.playedMs = 0;
  L.playing = 0; L.nextAt = L.player?.currentTime ?? 0;
  L.partial.assistant = ""; L.caption = "";
  setPhase("listening");
}
function cutIn(force = false) {
  if (!L.ready || L.socket?.readyState !== 1) return;
  const playback = playbackSnapshot();
  // Echo guard follows upstream's minimum played prefix; a deliberate press always cuts in.
  const played = L.playedMs + [...L.sources].reduce((ms, entry) =>
    ms + Math.max(0, Math.min(entry.duration, (L.player?.currentTime ?? 0) - entry.start)) * 1000, 0);
  if (!force && (!L.playing || played < 250)) return;
  clearPlayback();
  L.socket.send(JSON.stringify({ live: "interrupt", playback }));
}

/* ---------- the conversation ---------- */

/* Set before the engine is asked, so a second press while the first is on its way makes no second task. */
let asking = false;
async function press() {
  closePop();
  if (L.phase !== "idle" || asking) return;
  asking = true;
  const asked = hooks.state().sessionId ?? null;
  let opened;
  try { opened = await api("voice/live", { sessionId: asked }); } catch (error) { toast(error.message); return; } finally { asking = false; }
  if (L.phase !== "idle") { api(`runs/${encodeURIComponent(opened.runId)}/cancel`, {}).catch((error) => toast(error.message)); return; }
  Object.assign(L, fresh(), { phase: "starting", call: ++calls, runId: opened.runId, sessionId: opened.sessionId,
    service: opened.plan?.service ?? null, note: opened.plan?.reason ?? "", transport: opened.plan?.transport ?? null });
  draw();
  connect();
}
function connect() {
  const url = new URL(`/api/runs/${encodeURIComponent(L.runId)}/ws`, location.href).href.replace(/^http/, "ws");
  let socket;
  /* The desktop app signs the socket's opening request with its own key, as it signs every /api/ request; the page
     holds none. In a browser the key travels as the socket's second protocol. */
  try { socket = new WebSocket(url, isDesktop ? ["bearer"] : ["bearer", token.get()]); } catch { end({ say: t("voiceLive.neverConnected") }); return; }
  socket.binaryType = "arraybuffer";
  L.socket = socket;
  socket.addEventListener("open", () => { if (L.socket === socket) void beginSocket(socket, L.call); });
  socket.addEventListener("message", (event) => { if (L.socket === socket) receive(event.data); });
  /* Closed before the conversation opened: the task it made is stopped and the person is told; after, it simply ends. */
  socket.addEventListener("close", () => { if (L.socket === socket) end(L.ready ? {} : { say: t("voiceLive.neverConnected") }); });
}
async function beginSocket(socket, call) {
  try {
    if (L.transport === "webrtc") {
      const mine = () => current(call) && L.socket === socket;
      let release = () => {};
      const peer = await openPeer({ current: mine, desktop: isDesktop,
        muted: () => L.muted, speaking: () => setPhase("speaking"), failed: sentence => stop(sentence),
        own: (close) => { release = opening.own(close, mine); } });
      release();
      if (!peer) return;
      if (!current(call) || L.socket !== socket) { peer.close(); return; }
      L.peer = peer;
    }
    if (current(call) && L.socket === socket && socket.readyState === 1)
      socket.send(JSON.stringify({ live: "start", ...(L.peer ? { offer: L.peer.offer } : {}) }));
  } catch (error) { if (current(call)) stop(error.message); }
}
function receive(data) {
  if (data instanceof ArrayBuffer) { if (L.ready) play(readAudioFrame(data).pcm16); return; }
  let message;
  try { message = JSON.parse(data); } catch { return; }
  const body = message?.data ?? {};
  if (message?.kind === "voice.live.ready") void ready(body);
  else if (message?.kind === "voice.live.refused" || message?.kind === "voice.live.problem") end({ say: String(body.message ?? "") });
  else if (message?.kind === "voice.live.transcript") heard(body);
  else if (message?.kind === "voice.live.audio") L.audioItem = body;
  else if (message?.kind === "voice.live.speech_started") cutIn();
  else if (message?.kind === "voice.live.interrupted") L.generation = Math.max(L.generation, Number(body.generation) || 0);
  else if (message?.kind === "voice.live.consultation" && body.waiting) { L.last = String(body.message ?? ""); toast(L.last); }
  else if (message?.kind === "voice.live.capped") { L.last = String(body.sentence ?? ""); toast(L.last); }
  else if (message?.kind === "voice.live.ended" || message?.kind === "end") end();
}
async function ready(body) {
  if (L.ready || L.phase === "idle") return;
  const { call, socket } = L;
  L.ready = true;
  L.timer = setInterval(() => { L.seconds += 1; const at = L.el?.querySelector("#v-t"); if (at) at.textContent = clock(); }, 1000);
  setPhase("listening");
  if (L.transport === "webrtc") {
    try {
      if (!L.peer || typeof body.answerSdp !== "string" || body.answerSdp.length > 256 * 1024) throw new Error("The live media answer was invalid.");
      await L.peer.answer(body.answerSdp);
    } catch { if (current(call)) stop("The live media connection could not be opened."); }
    return;
  }
  let mic;
  /* Refused or failed: that call ends with the reason, but only if it is still the one going. */
  try { mic = await openMic(call, socket); } catch (error) { if (current(call)) stop(error.message); return; }
  if (!mic) return;
  if (current(call)) L.mic = mic; else mic.close();
}
/* What either side is saying, as the engine hears it; whole sentences the engine itself writes into the conversation. */
function heard(part) {
  const who = part.who === "person" ? "person" : "assistant";
  const text = String(part.text ?? "");
  if (!text) return;
  const before = L.partial[who];
  L.caption = part.final ? (before && !text.startsWith(before) ? before + text : text) : before + text;
  L.partial[who] = part.final ? "" : L.caption;
  if (L.transport === "webrtc") L.phase = who === "assistant" && !part.final ? "speaking" : "listening";
  draw();
}
/* End, pressed: the engine is told to stop, then everything here is closed. Before it opened, nothing was said. */
function stop(say) {
  const said = L.ready;
  if (said && L.socket?.readyState === 1) L.socket.send(JSON.stringify({ live: "stop" }));
  end(say !== undefined ? { say } : said ? {} : { say: "" });
}
/* However it ends, once: the microphone and the sound let go, the socket closed, the view taken away. A task whose
   conversation never opened is stopped through the same route as Stop. After a conversation, it is opened again so
   what was said (written in by the engine) shows. */
function end({ say } = {}) {
  if (L.phase === "idle") return;
  const { runId, ready: opened, sessionId, socket, mic, player, timer, peer } = L;
  L.phase = "idle";
  L.socket = null; L.mic = null; L.player = null;
  clearInterval(timer);
  clearPlayback();
  mic?.close();
  peer?.close(); L.peer = null;
  opening.stop(); // a capture still being set up is stopped too
  if (player) void player.close();
  socket?.close();
  draw();
  if (!opened && runId) api(`runs/${encodeURIComponent(runId)}/cancel`, {}).catch((error) => toast(error.message));
  const words = say ?? (L.last || t("window.chat.voice.ended"));
  if (words) toast(words);
  if (opened && sessionId) hooks.reopen(sessionId).catch((error) => toast(error.message));
}

export function initTalkLive(given) {
  hooks = given;
  markLive(["voice", "call", "v-mute", "v-interrupt", "v-end"]);
  on("voice", () => press());
  on("call", () => press());
  on("v-mute", () => { L.muted = !L.muted; L.peer?.mute(L.muted); draw(); });
  on("v-end", () => stop());
  on("v-interrupt", () => cutIn(true));
}
