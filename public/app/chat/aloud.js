/* Answer aloud (Settings › Voice, the engine's autoReadAloud). When a task the person is watching in the open
   conversation finishes with a new reply, and the engine's setting is on (read afresh each time, GET
   /api/voice/settings), the reply is read out: POST /api/voice/speak answers the sound in the voice the owner chose, at
   the speed they chose, and the window plays it. One at a time: a newer reply stops the one playing. Replies that were
   already there when a conversation opened are never read; only a reply that arrives after the person's own send or
   answer: to Branch, to a Trunk named with @, or in a room (each member's reply as it arrives). The engine's refusal (no voice set up, sound kept on this computer) is shown in its own words. */

import { api, apiBlob } from "../core/api.js";
import { toast } from "../core/ui.js";

const A = { audio: null, url: "" };

const replies = (messages) => (messages ?? []).filter((m) => m.role === "assistant" && m.from !== "branch" && typeof m.content === "string" && m.content.trim());

/** Which reply is newest right now, as a key a later read can be compared with. */
export function replyMark(messages) {
  const all = replies(messages), last = all.at(-1);
  return last ? `${all.length}\n${last.messageId ?? ""}\n${last.content}` : "";
}

function stop() {
  A.audio?.pause();
  if (A.url) URL.revokeObjectURL(A.url);
  Object.assign(A, { audio: null, url: "" });
}

/* Each read takes a turn; one that comes back after a newer one started is dropped, so an older reply never plays over
   a newer one. */
let turn = 0;

/** Reads the newest reply aloud when it is newer than `before` and the engine's Answer aloud is Always. `words` gives
    the words the window shows for a reply (a room's reply without its "@name:" prefix). */
export async function readNewReply(before, messages, words = (m) => m.content) {
  if (replyMark(messages) === before || !replies(messages).length) return;
  const mine = ++turn;
  const text = String(words(replies(messages).at(-1)) ?? "").trim().slice(0, 4000);
  if (!text) return;
  let settings, sound;
  try { settings = await api("voice/settings"); } catch (error) { toast(error.message); return; }
  if (!settings.autoReadAloud || mine !== turn) return;
  try { sound = await apiBlob("voice/speak", { text, speed: settings.speechRate }); } catch (error) { toast(error.message); return; }
  if (mine !== turn) return;
  stop();
  A.url = URL.createObjectURL(sound);
  A.audio = new Audio(A.url);
  A.audio.addEventListener("ended", stop, { once: true });
  A.audio.play().catch((error) => toast(error.message));
}
