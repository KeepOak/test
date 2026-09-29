/* RES-709: push-to-talk and live captions with the window's own microphone, written out free on this computer.
   Used when the engine says dictation is "window-mic" (no streaming speech program, but faster-whisper is here). The
   microphone opens only on a press of Dictate: a quick press keeps it open until Done, holding it talks until let go.
   About every second what has been said so far goes to POST /api/voice/dictation/hear?partial=1 and the words come back
   as a caption; letting go sends all of it once more for the settled words. The microphone is let go of the moment the
   recording stops, and nothing is kept: the words go in the box, and the owner sends it or not. */

import { apiBytes, isDesktop } from "../core/api.js";

const slice = 1000; // how often the recorder hands over what it has, and so how often a caption is asked for
const most = 5 * 60_000; // a recording that is never stopped is stopped after five minutes

/* One recording. onWords(words) as captions come; resolves with the settled words (or null when nothing was said). */
export async function recordInWindow({ onWords, onFail }) {
  if (isDesktop) await window.branchDesktop?.talkLiveMic?.(); // the desktop app lets the microphone be asked for once, now
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"].find((one) => MediaRecorder.isTypeSupported?.(one)) || "";
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : {});
  const pieces = [];
  let asking = false, stopped = false, last = "";
  const whole = () => new Blob(pieces, { type: recorder.mimeType || "audio/webm" });
  const letGo = () => stream.getTracks().forEach((track) => track.stop());
  recorder.ondataavailable = (event) => {
    if (event.data?.size) pieces.push(event.data);
    if (stopped || asking || !pieces.length) return;
    asking = true; // one caption at a time; the next piece asks again with everything so far
    apiBytes("voice/dictation/hear?partial=1", whole())
      .then((said) => { if (!stopped && typeof said.text === "string" && said.text !== last) onWords((last = said.text)); })
      .catch((error) => { if (!stopped) onFail(error); })
      .finally(() => { asking = false; });
  };
  const settled = new Promise((resolve) => {
    recorder.onstop = () => {
      letGo();
      if (!pieces.length) { resolve(null); return; }
      apiBytes("voice/dictation/hear", whole()).then((said) => resolve(said.text ?? last), (error) => { onFail(error); resolve(last || null); });
    };
  });
  const timer = setTimeout(() => stop(), most);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (recorder.state !== "inactive") recorder.stop(); else letGo();
  }
  recorder.start(slice);
  return { stop, settled };
}
