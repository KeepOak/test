import type { IncomingMessage } from "node:http";
import { dictationLockedRefusal, dictationOwnerOnlyRefusal, dictationRefusal } from "./voice-dictation.js";
import type { VoiceService } from "./voice-service.js";
import { whisperMostBytes } from "./voice-whisper.js";
import type { ProgramPresent } from "./mic-capture.js";
import type { Store } from "./store.js";

/**
 * RES-709: push-to-talk and live captions in the window, free and on this computer.
 *
 * While the owner holds Dictate the window records with its own microphone and sends what it has so far every
 * second or so (`partial`), then all of it once more when they let go. Each piece is written out here, by
 * faster-whisper on this computer (src/voice-whisper.ts), and only the words go back. Nothing is sent to any
 * service whatever the owner's voice route says, nothing is written to disk and nothing is kept: the words go
 * to the screen, and into the message box, which the owner sends or not.
 *
 * Refused, in the owner's words, when the dictation switch is off (it ships off: the microphone is not used
 * until the owner turns it on), under Lockdown, while Branch is locked, for anyone but the owner, and when
 * no free speech program is here.
 */
export class HearRefused extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface HearHost {
  store: Store;
  owner: string;
  isOwner: boolean;
  locked: boolean;
  /** Re-checked around awaited local inference, so the request's initial lock snapshot cannot authorize its result. */
  isLocked?: () => boolean;
  voice: VoiceService;
  platform?: string | undefined;
  /** Whether a program is on this computer; the listener's own answer, so a test's fake is the one used. */
  present?: ProgramPresent | undefined;
}

/** The words in one piece of the window's recording. `text` is null when a live caption was skipped as busy. */
export async function hearInWindow(host: HearHost, request: IncomingMessage): Promise<{ text: string | null; partial: boolean }> {
  const fresh = (): void => {
    if (!host.isOwner || !host.store.profiles.isOwner() || host.store.profiles.scope() !== host.owner)
      throw new HearRefused(403, dictationOwnerOnlyRefusal);
    if (host.isLocked?.() ?? host.locked) throw new HearRefused(409, dictationLockedRefusal);
    const refusal = dictationRefusal(host.store, host.owner, host.platform ?? process.platform, host.present, host.voice.localSpeech(host.owner));
    if (refusal) throw new HearRefused(409, refusal);
  };
  fresh();
  const local = host.voice.localSpeech(host.owner);
  const refusal = dictationRefusal(host.store, host.owner, host.platform ?? process.platform, host.present, local);
  if (refusal) throw new HearRefused(409, refusal);
  if (!local?.available) throw new HearRefused(409, local?.how ?? "There is no free speech program on this computer.");
  const type = String(request.headers["content-type"] ?? "");
  if (!/^audio\//.test(type)) throw new HearRefused(415, "Send the recording as audio.");
  const partial = new URL(request.url ?? "/", "http://local").searchParams.get("partial") === "1";
  const bytes = await readSound(request);
  fresh();
  const whisper = host.voice.transcription.whisper;
  if (!whisper) throw new HearRefused(409, local.how);
  const language = host.voice.settings(host.owner).language || null;
  const heard = await whisper.transcribe(local, bytes, { language, partial });
  fresh();
  return { text: heard ? heard.text : null, partial };
}

async function readSound(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > whisperMostBytes) throw new HearRefused(413, "That recording is too long to write out here. Keep it under ten minutes.");
    chunks.push(Buffer.from(chunk));
  }
  if (!size) throw new HearRefused(400, "That recording has no sound in it.");
  return new Uint8Array(Buffer.concat(chunks));
}
