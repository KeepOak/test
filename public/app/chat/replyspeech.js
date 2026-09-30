import { apiBlob, stream } from "../core/api.js";
import { toast } from "../core/ui.js";

let active = null;
export function stopReplyStream() { active?.stop(true); }
export function checkReplyStream() { if (active && !active.current(active.sessionId)) active.stop(true); }
window.addEventListener("pagehide", stopReplyStream);

/** Opens the scoped event stream before sending, so a quick first sentence is retained. */
export async function openReplyStream(options) {
  stopReplyStream();
  const state = new ReplySpeech(options);
  active = state;
  const ready = await state.open();
  if (!ready || !state.current(state.sessionId)) { state.stop(); return null; }
  return state;
}

class ReplySpeech {
  constructor({ current, voice, speed, sessionId }) {
    Object.assign(this, { current, voice, speed, sessionId, requestId: crypto.randomUUID(), generation: -1,
      sequence: 0, queue: [], bytes: 0, playing: false, heard: false, ended: false, stopped: false, connection: null,
      audio: null, url: "", doneAudio: null, abort: null, timer: null });
  }
  async open() {
    let resolve;
    const ready = new Promise((done) => { resolve = done; });
    const timeout = setTimeout(() => resolve(false), 2500);
    this.connection = stream(["voice.reply.reset", "voice.reply.sentence", "voice.reply.ended", "voice.reply.stopped"],
      (kind, event) => this.event(kind, event.data), (end) => { if (end?.reason === "profile") this.stop(true); }, () => resolve(true));
    this.timer = setInterval(() => { if (!this.current(this.sessionId)) this.stop(true); }, 200);
    this.connection.done.finally(() => resolve(false));
    const value = await ready;
    clearTimeout(timeout);
    return value;
  }
  event(kind, data) {
    if (data?.requestId !== this.requestId || this.stopped) return;
    if (!this.current(data.sessionId)) { this.stop(true); return; }
    this.sessionId = data.sessionId;
    if (kind === "voice.reply.stopped") { this.stop(true); return; }
    if (kind === "voice.reply.reset" && data.generation > this.generation) {
      this.clearPlayback(); this.queue = []; this.bytes = 0; this.sequence = 0;
      this.generation = data.generation; this.ended = false;
      return;
    }
    if (data.generation !== this.generation || this.ended) return;
    if (kind === "voice.reply.ended") {
      this.ended = true; this.complete = data.complete && data.sentences === this.sequence;
      this.connection.stop(); return;
    }
    if (kind !== "voice.reply.sentence") return;
    if (data.sequence < this.sequence) return; // a reconnect may replay an already queued sentence
    if (data.sequence !== this.sequence || typeof data.text !== "string" || data.text.length > 3500 ||
      this.queue.length >= 32 || this.bytes + data.text.length > 64_000) { this.stop(); return; }
    this.sequence++; this.bytes += data.text.length; this.queue.push(data.text);
    void this.pump();
  }
  async pump() {
    if (this.playing || this.stopped) return;
    this.playing = true;
    const generation = this.generation;
    try {
      while (this.queue.length && !this.stopped && generation === this.generation) {
        const text = this.queue.shift(); this.bytes -= text.length;
        const voice = await this.voice();
        if (this.stopped || generation !== this.generation) break;
        if (!this.current(this.sessionId)) { this.stop(true); break; }
        this.abort = new AbortController();
        const sound = await apiBlob("voice/speak", { text, voice, speed: this.speed }, this.abort.signal);
        if (this.stopped || generation !== this.generation) break;
        if (!this.current(this.sessionId)) { this.stop(true); break; }
        await this.play(sound);
      }
    } catch (error) { if (!this.stopped && generation === this.generation && error.name !== "AbortError") { toast(error.message); this.stop(); } }
    finally {
      this.playing = false;
      if (this.queue.length && !this.stopped) void this.pump();
      else if (this.ended) this.retire();
    }
  }
  play(sound) {
    this.url = URL.createObjectURL(sound);
    const audio = this.audio = new Audio(this.url);
    return new Promise((resolve, reject) => {
      this.doneAudio = resolve;
      audio.onended = () => { if (this.audio === audio) this.clearPlayback(); };
      audio.onerror = () => { if (this.audio === audio) this.clearPlayback(); reject(new Error("The spoken sentence could not be played.")); };
      audio.play().then(() => { if (this.audio === audio && !this.stopped) this.heard = true; },
        (error) => { if (this.audio === audio) this.clearPlayback(); reject(error); });
    });
  }
  async finish(run) {
    const deadline = Date.now() + 2500;
    while (!this.ended && !this.stopped && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 50));
    const result = run.speechStream;
    const matching = result?.requestId === this.requestId && result.generation === this.generation &&
      result.complete && this.complete && result.sentences === this.sequence;
    if (!matching) this.stop();
    // Heard audio cannot be undone or safely repeated after an attempt changed or events were lost.
    return !!matching || this.heard || this.retired;
  }
  clearPlayback() {
    this.abort?.abort(); this.abort = null;
    if (this.audio) { this.audio.onended = null; this.audio.onerror = null; this.audio.pause(); }
    if (this.url) URL.revokeObjectURL(this.url);
    const done = this.doneAudio;
    this.audio = null; this.url = ""; this.doneAudio = null;
    done?.();
  }
  retire() { clearInterval(this.timer); this.connection?.stop(); if (active === this) active = null; }
  stop(retired = false) { this.retired ||= retired; this.stopped = true; this.queue = []; this.clearPlayback(); this.retire(); }
}
