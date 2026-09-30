/**
 * PH-03: lending this phone to Branch from the app's own page. The native side (BranchLend) holds the socket and the
 * key and hands this page each ask while it is showing; this page takes the photo, records or speaks with what the web
 * view has (apps/mobile/web/phone-node.js serveLending checks each ask again first). It runs while the app is open on
 * its own page: the native side closes the socket while the app is off the screen and dials again when it is back,
 * and opening the owner's Branch ends it until this page is loaded again.
 */
import { serveLending } from "/phone-node.js";
import { plugin, say } from "/phone-common.js";

const L = { stop: null, starting: null, state: { connected: false, enabled: [] }, heard: () => undefined };

/** Waits for `event` on `target` at most `ms`, and says so when it never came. */
const within = (target, event, ms, why) => new Promise((done, failed) => {
  const timer = setTimeout(() => failed(new Error(why)), ms);
  target.addEventListener(event, () => { clearTimeout(timer); done(); }, { once: true });
});

/** One still from the camera, as a JPEG. */
async function frame(stream) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const ready = video.readyState >= 2 ? Promise.resolve() : within(video, "loadeddata", 10_000, say("phone.device.noCamera", "The camera could not be opened."));
  await video.play();
  await ready;
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
function record(stream, ms, signal) {
  return new Promise((done, failed) => {
    const recorder = new MediaRecorder(stream), chunks = [];
    let timer;
    const stop = () => {
      clearTimeout(timer);
      if (recorder.state !== "inactive") recorder.stop();
    };
    signal?.addEventListener("abort", stop, { once: true });
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    recorder.onerror = (event) => { clean(); failed(event.error ?? new Error("The recording stopped.")); };
    recorder.onstop = async () => {
      clean();
      if (signal?.aborted) { failed(new Error("Lending stopped.")); return; }
      const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "audio/webm" });
      done({ data: await blob.arrayBuffer(), mime: blob.type });
    };
    recorder.start();
    timer = setTimeout(stop, ms);
    if (signal?.aborted) stop();
  });
}

/** Says the text out loud, and answers only once the phone really started speaking (or says it could not). */
function speak(text) {
  if (!("speechSynthesis" in globalThis)) return Promise.reject(new Error("This phone cannot speak."));
  const utterance = new SpeechSynthesisUtterance(text);
  const started = within(utterance, "start", 5000, "The phone did not start speaking.");
  const failed = new Promise((_, refuse) => utterance.addEventListener("error", (event) => refuse(new Error(`The phone could not speak: ${event.error}`)), { once: true }));
  speechSynthesis.speak(utterance);
  return Promise.race([started, failed]);
}

/** What the page offers comes from the platform (phone-node.js APP_OFFERS); these are the abilities behind it. */
function environment() {
  const ios = globalThis.Capacitor?.getPlatform?.() === "ios";
  return {
    platform: ios ? "ios" : "android", now: Date.now, say,
    media: navigator.mediaDevices, frame, record, speak,
    geolocation: navigator.geolocation,
    notify: (args) => plugin.lendNotify(args),
    notifications: (args) => plugin.lendNotifications(args),
    open: (url, id) => plugin.lendOpen({ url, id }),
    stopOutput: () => globalThis.speechSynthesis?.cancel(),
    onHidden: (stop) => {
      const changed = () => { if (document.hidden) stop(); };
      document.addEventListener("visibilitychange", changed);
      return () => document.removeEventListener("visibilitychange", changed);
    },
  };
}

/**
 * Starts lending when this phone is lent (the native side knows); `heard` is told whenever the connection changes.
 * Called each time the app's page opens the app (after unlocking, after pairing), so a phone paired again lends again.
 */
export async function startLending(heard = () => undefined) {
  L.heard = heard;
  if (L.starting || !plugin?.lendStart) return;
  // Started before (and perhaps stopped since by "Stop lending", or paired again): begin afresh from what the phone
  // keeps now, its pairing and its own refusals.
  const before = L.stop;
  L.stop = null;
  L.starting = (async () => {
    await before?.();
    return serveLending(environment(), plugin, (state) => { L.state = state; L.heard(state); });
  })();
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

export const lendState = () => L.state;
