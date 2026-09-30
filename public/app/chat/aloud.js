/* Answer aloud (Settings › Voice, the engine's autoReadAloud). When a task the person is watching in the open
   conversation finishes with a new reply, and the engine's setting is on (read afresh each time, GET
   /api/voice/settings), the reply is read out: POST /api/voice/speak answers the sound in the voice the owner chose, at
   the speed they chose, and the window plays it. One at a time: a newer reply stops the one playing. Replies that were
   already there when a conversation opened are never read; only a reply that arrives after the person's own send or
   answer: to Branch, to a Trunk named with @, or in a room (each member's reply as it arrives). The engine's refusal (no voice set up, sound kept on this computer) is shown in its own words. */

import { api, apiBlob } from "../core/api.js";
import { toast } from "../core/ui.js";
import { openReplyStream, stopReplyStream } from "./replyspeech.js";

const A = { audio: null, url: "", finish: null, spoken: false, lastSpoken: false };

/* "When I talk" (Settings › Voice, readAloudWhen "spoken"): a message the person said rather than typed. Dictation marks
   the words it put in the box (heardSpeech); the next send takes that mark with it (sentMessage), a fix typed into the
   words included, and clears it for the message after. */
export function heardSpeech() { A.spoken = true; }
export function sentMessage() { A.lastSpoken = A.spoken; A.spoken = false; }

const replies = (messages) => (messages ?? []).filter((m) => m.role === "assistant" && m.from !== "branch" && typeof m.content === "string" && m.content.trim());

/** Which reply is newest right now, as a key a later read can be compared with. */
export function replyMark(messages) {
  const all = replies(messages), last = all.at(-1);
  return last ? `${all.length}\n${last.messageId ?? ""}\n${last.content}` : "";
}

function stop() {
  if (A.audio) { A.audio.onended = null; A.audio.onerror = null; }
  A.audio?.pause();
  if (A.url) URL.revokeObjectURL(A.url);
  const finish = A.finish;
  Object.assign(A, { audio: null, url: "", finish: null });
  finish?.();
}

/* Each read takes a turn; one that comes back after a newer one started is dropped, so an older reply never plays over
   a newer one. */
let turn = 0;

export async function startReplyStream(options) {
  stopReplyStream();
  const mine = ++turn;
  stop();
  let settings;
  try { settings = await api("voice/settings"); } catch { return null; }
  if (mine !== turn || !settings.autoReadAloud || (settings.readAloudWhen === "spoken" && !A.lastSpoken)) return null;
  return openReplyStream({ ...options, speed: settings.speechRate });
}

/** Reads the newest reply aloud when it is newer than `before` and the engine's Answer aloud is Always. `words` gives
    the words the window shows for a reply (a room's reply without its "@name:" prefix). */
export async function readNewReply(before, messages, words = (m) => m.content, voiceOf = () => "") {
  if (replyMark(messages) === before || !replies(messages).length) return;
  const mine = ++turn;
  stopReplyStream();
  stop();
  const reply = replies(messages).at(-1);
  const text = String(words(reply) ?? "").trim();
  const voice = String(voiceOf(reply) ?? "");
  if (!text) return;
  let settings;
  try { settings = await api("voice/settings"); } catch (error) { toast(error.message); return; }
  if (!settings.autoReadAloud || mine !== turn) return;
  if (settings.readAloudWhen === "spoken" && !A.lastSpoken) return;
  stop();
  try {
    const prepared = await api("voice/sentences", { text });
    if (mine !== turn) return;
    await readSentences(prepared.sentences ?? [], { voice, speed: settings.speechRate }, mine);
  } catch (error) { if (mine === turn) toast(error.message); }
}

/* At most one sentence ahead: sentence one starts before the rest is synthesized. A newer reply
   retires both the playing sentence and requests in flight, retaining #938's author voice callback. */
async function readSentences(sentences, options, mine) {
  let pending = null;
  for (let at = 0; at < sentences.length; at++) {
    if (mine !== turn) return;
    const sound = await (pending ?? apiBlob("voice/speak", { text: sentences[at], ...options }));
    if (mine !== turn) return;
    pending = at + 1 < sentences.length ? apiBlob("voice/speak", { text: sentences[at + 1], ...options }) : null;
    // Attach rejection handling immediately while this sentence is playing.
    pending?.catch(() => undefined);
    await playSentence(sound);
  }
}
function playSentence(sound) {
  stop();
  A.url = URL.createObjectURL(sound);
  const audio = A.audio = new Audio(A.url);
  return new Promise((resolve, reject) => {
    A.finish = resolve;
    audio.onended = () => { if (A.audio === audio) stop(); };
    audio.onerror = () => { if (A.audio === audio) stop(); reject(new Error("The spoken sentence could not be played.")); };
    audio.play().catch((error) => { if (A.audio === audio) stop(); reject(error); });
  });
}
