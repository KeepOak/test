/**
 * PH-03: lending this phone to Branch from the app's own page. The native side (BranchLend) holds the socket and the
 * key and hands this page each ask while it is showing; this page takes the photo, records or speaks with what the web
 * view has (apps/mobile/web/phone-node.js serveLending checks each ask again first). It runs while the app is open on
 * its own page: going to the background, or opening the owner's Branch, ends it until the page is back.
 */
import { serveLending } from "/phone-node.js";
import { plugin, say } from "/phone-common.js";

const L = { stop: null, starting: null, state: { connected: false, enabled: [] }, heard: () => undefined };

/** One still from the camera, as a JPEG. */
async function frame(stream) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) await new Promise((done) => video.addEventListener("loadeddata", done, { once: true }));
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  video.srcObject = null;
  const blob = await new Promise((done) => canvas.toBlob(done, "image/jpeg", 0.85));
  if (!blob) throw new Error(say("phone.device.noCamera", "The camera could not be opened."));
  return blob.arrayBuffer();
}

/** A few seconds from the microphone, in the kind this web view records (iOS: audio/mp4). */
function record(stream, ms) {
  return new Promise((done, failed) => {
    const recorder = new MediaRecorder(stream), chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = (event) => failed(event.error ?? new Error("The recording stopped."));
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "audio/webm" });
      done({ data: await blob.arrayBuffer(), mime: blob.type });
    };
    recorder.start();
    setTimeout(() => recorder.state !== "inactive" && recorder.stop(), ms);
  });
}

function speak(text) {
  if (!("speechSynthesis" in globalThis)) throw new Error("This phone cannot speak.");
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

/** What the page offers comes from the platform (phone-node.js APP_OFFERS); these are the abilities behind it. */
function environment() {
  const ios = globalThis.Capacitor?.getPlatform?.() === "ios";
  return {
    platform: ios ? "ios" : "android", now: Date.now, say,
    media: navigator.mediaDevices, frame, record, speak,
  };
}

/** Starts lending when this phone is lent (the native side knows); `heard` is told whenever the connection changes. */
export async function startLending(heard = () => undefined) {
  L.heard = heard;
  if (L.stop || L.starting || !plugin?.lendStart) return;
  L.starting = serveLending(environment(), plugin, (state) => { L.state = state; L.heard(state); });
  try {
    L.stop = await L.starting;
  } catch (error) {
    // Not lending now: the Lend page says why, in the native side's or Branch's own words.
    L.state = { connected: false, enabled: [], error: String(error?.message ?? error) };
    L.heard(L.state);
  } finally {
    L.starting = null;
  }
}

export async function stopLending() {
  const stop = L.stop;
  L.stop = null;
  L.state = { connected: false, enabled: [] };
  await stop?.();
}

export const lendState = () => L.state;
