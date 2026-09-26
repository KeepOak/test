/**
 * Voice (the prototype's phVoice) and the other ways in from the phone: Scan and what other apps shared.
 *   Voice   hold the microphone and speak; let go and the recording is written out on the computer
 *           (POST /api/voice/transcribe), then sent as a message (POST /api/run, in the open chat when there is
 *           one). What you said and Branch's answer are the captions. Only with the Talk button switch not off.
 *   Scan    a photo from the camera, sent as a picture from the phone (rules.js planShare, POST /api/run)
 *   Shared  what the share sheet brought in, sent with a note (the "share" switch decides whether it may be)
 */
import { E, P, draw, esc, go, ic, on, say, toast, w } from "/ph-core.js";
import { nameFor } from "/ph-data.js";
import { describe, phone, plugin } from "/phone-common.js";
import { planShare, refusal } from "/rules.js";
import { switchesNow } from "/ph-switches.js";

const V = { me: "", answer: "", said: "", bad: false, recorder: null, started: 0, note: "" };
const readBlob = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

export function drawVoice() {
  const name = (P.chat && nameFor(P.chat)) || "Branch";
  return `<div class="p-voice8"><div class="pv-top"><button type="button" data-act="back" aria-label="${w("window.chat.play.close", "Close")}">${ic("down", "s")}</button><span>${w("phone8.voice.title", "{name} · voice", { name })}</span><span>${ic("lock", "s")}${w("phone.settings.title", "On this phone")}</span></div>
    <div class="pv-orb ${V.recorder ? "on" : ""}"><i></i><i></i><i></i><img class="mark" src="/assets/keepoak-mark.png" alt=""></div>
    <div class="pv-cap">${V.me ? `<p class="pv-me">${esc(V.me)}</p>` : ""}${V.answer ? `<p>${esc(V.answer)}</p>` : ""}<p class="subtle ${V.bad ? "bad" : ""}" role="status">${esc(V.said)}</p></div>
    <div class="pv-ctl"><button type="button" id="talk" class="${V.recorder ? "recording" : ""}" aria-label="${w("phone8.home.talk", "Talk")}">${ic("mic", "s")}</button><button type="button" class="end" data-act="back" aria-label="${w("voiceView.end", "End")}">${ic("x")}</button><button type="button" data-act="back" aria-label="${w("window.settings.general.keyboard", "Keyboard")}">${ic("keyboard", "s")}</button></div></div>`;
}
const setSaid = (text, bad = false) => { Object.assign(V, { said: text, bad }); draw(); };

async function startTalking() {
  if (V.recorder) return;
  if (switchesNow().voice === "off") { setSaid(say("phone.talk.off", "The talk button is off. Turn it on below, under On this phone."), true); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = () => { for (const track of stream.getTracks()) track.stop(); void finish(new Blob(chunks, { type: recorder.mimeType })); };
    recorder.start();
    Object.assign(V, { recorder, started: Date.now() });
    setSaid(say("phone.talk.listening", "Listening… let go to send."));
  } catch {
    V.recorder = null;
    setSaid(say("phone.talk.noMicrophone", "The microphone could not be opened."), true);
  }
}
const stopTalking = () => { if (V.recorder?.state === "recording") V.recorder.stop(); };
async function finish(blob) {
  V.recorder = null;
  const seconds = Math.max(1, Math.round((Date.now() - V.started) / 1000));
  setSaid(say("phone.talk.writing", "Writing it out on your computer…"));
  try {
    const base64 = await readBlob(blob);
    const contentType = (blob.type || "audio/mp4").split(";")[0];
    const written = await phone.vault.request("POST", "/api/voice/transcribe", null, { base64, contentType, query: `seconds=${seconds}` });
    const words = String(written?.text ?? "").trim();
    if (!words) throw refusal("phone.talk.empty", "Nothing was heard. Try again.");
    V.me = words.slice(0, 400);
    setSaid("");
    const run = await phone.vault.request("POST", "/api/run", { prompt: words.slice(0, 16000), ...(P.chat ? { sessionId: P.chat } : {}) });
    if (run?.sessionId) P.chat = run.sessionId;
    V.answer = String(run?.output ?? "").slice(0, 600);
    draw();
  } catch (error) {
    setSaid(describe(error), true);
  }
}

/* ---------- Scan and Send to Branch ---------- */
async function sendItems(items, note) {
  const { requests, refused } = planShare(items, note);
  if (!requests.length) { toast(say("phone.send.nothing", "Add some words, a picture or a file first.")); return false; }
  for (const request of requests) {
    const answer = await phone.vault.request(request.method, request.path, request.body);
    if (answer?.sessionId && request.path === "/api/run") P.chat = answer.sessionId;
  }
  if (refused.length) toast(say("phone.send.skipped", "{count} could not be sent (too big or unreadable).", { count: refused.length }));
  return true;
}
export async function scanPicture(file) {
  if (!file) return;
  try {
    const data = await readBlob(file);
    if (await sendItems([{ kind: "file", name: file.name || "scan.jpg", type: file.type || "image/jpeg", data }], "")) go("chat");
  } catch (error) { toast(describe(error)); }
}
/** The share sheet: what came in, a note, and Send to Branch (the prototype's "Send to Branch" sheet). */
export function shareSheet() {
  const items = phone.shared.map((item) => `<li>${esc(item.kind === "file" ? item.name : item.text)}</li>`).join("");
  return `<b>${w("phone.send.title", "Send to Branch")}</b><ul class="phone-list">${items}</ul><label class="p-fld"><span>${w("phone.send.note", "A note to go with it")}</span><input id="send-note" autocomplete="off"></label><button type="button" class="p-big" data-act="share-send">${w("phone.send.send", "Send to Branch")}</button>`;
}
async function sendShared() {
  if (switchesNow().share === "off") { toast(say("phone.share.off", "Sending from the share sheet is off. Turn it on in Branch, under On this phone.")); return; }
  const note = document.getElementById("send-note")?.value ?? "";
  try {
    if (!(await sendItems(phone.shared, note))) return;
    phone.shared = [];
    await plugin.clearShared?.();
    P.sheet = null;
    toast(say("phone.send.sent", "Sent. It is waiting in your Branch."));
    go("chat");
  } catch (error) { toast(describe(error)); }
}
export function initVoice() {
  on("voice", () => go("voice"));
  on("share-send", () => sendShared());
  document.addEventListener("pointerdown", (event) => { if (event.target.closest?.("#talk")) void startTalking(); });
  for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, () => stopTalking());
  void E;
}
