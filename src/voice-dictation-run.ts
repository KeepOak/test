import type { ProgramPresent, RecorderCommand } from "./mic-capture.js";
import type { Store } from "./store.js";
import {
  cleanWords, dictationCapture, dictationEngine, dictationLockedRefusal, dictationRefusal,
  frameBytes, mostWords, RoomFloor, dictationSettings,
} from "./voice-dictation.js";
import { voiceSettings } from "./voice.js";
import { DictationPreroll } from "./voice-dictation-preroll.js";

/**
 * mac7/live-voice: the microphone open, and let go of again. This is the whole of the hard part.
 *
 * The word that starts a turn takes one window at a time, and letting go of the microphone is a
 * consequence of the recorder ending by itself. Nothing here ends by itself, so every one of those
 * ways out has to be built rather than inherited:
 *
 *   • **the person stops** — pressing Dictate again, or Escape;
 *   • **a quiet room** — nobody has spoken for the seconds the owner chose, so the phrase is ended
 *     and so is the program that holds the microphone;
 *   • **Lockdown coming on, or the switch going off** — asked about before every piece of sound,
 *     and on a tick besides, so a silent microphone is asked about too;
 *   • **Branch being locked** — a state, asked about on the same two beats, so a settings file, a
 *     preset or another window cannot reopen the microphone underneath the lock;
 *   • **the app closing**;
 *   • **the speech program dying** — which is a stop, not something to paper over: the microphone
 *     is let go of, the words are settled, and it is not started again by itself.
 *
 * Nothing here opens a microphone without a press, whatever the switch says. And nothing here is
 * ever written to disk: what is held is the current phrase's words and, on the one path where
 * Branch is handed sound at all, twenty milliseconds of it at a time, overwritten in place.
 */

/** A speech program that is running. Words come out; sound may go in; it can be ended. */
export interface SpeechStream {
  /** Hands it a piece of sound. False when it is not keeping up, and the piece was dropped. */
  hear(sound: Uint8Array): boolean;
  /** Ends it, and with it the microphone if it was the one holding it. */
  stop(): void;
}

/**
 * Starts a speech program. Always a parameter, so every test hands in a fake and no microphone is
 * ever opened by one; the real one is in src/voice-dictation-host.ts.
 */
export type SpeechStreamRunner = (
  command: RecorderCommand,
  onWords: (written: string) => void,
  /** Called once when it ends, with why it ended when Branch knows, or null when it simply stopped. */
  onEnded: (why: string | null) => void,
) => SpeechStream;

/** A recorder held open. Also always a parameter, for the same reason. */
export type SoundStreamRunner = (
  command: RecorderCommand,
  onSound: (piece: Uint8Array) => void,
  onEnded: (why: string | null) => void,
) => { stop(): void };

/** What the screen is told, every time it changes. The words are screen state and nothing else. */
export interface DictationHeard {
  /** The words so far. Provisional until `settled`: they may be replaced as it hears more. */
  words: string;
  /** True once a quiet room, or a stop, has ended the phrase and these words are final. */
  settled: boolean;
}

export interface DictationDeps {
  store: Store;
  owner: string;
  speech: SpeechStreamRunner;
  sound: SoundStreamRunner;
  platform?: string;
  present?: ProgramPresent;
  /** Whether Branch is locked this moment. A state, asked about rather than pushed. */
  locked?: () => boolean;
  /** The words, for the message box. They are never written down, traced or sent anywhere. */
  onHeard: (heard: DictationHeard) => void;
  /** How often the reasons to stop are asked about while nothing at all is arriving. */
  tickMs?: number;
}

/** How often Lockdown, the lock and the switch are asked about while the room is silent. */
export const dictationTickMs = 500;

/**
 * How many times a speech program may die the instant it is started before dictation gives up on
 * it. Integration review, taken from the word that starts a turn: a program that fails at once
 * paces nothing, so without a cap the press-to-start would restart it as fast as the loop turns.
 * Dictation is a press rather than a loop, so it stops and says so instead of backing off for ever.
 */
export const mostCrashes = 3;
/** A program that ends sooner than this after starting is one that failed, not one that finished. */
export const failedWithinMs = 1500;

export interface LiveDictation {
  /** Whether the microphone is open this moment. From the program's own liveness, never the switch. */
  readonly open: boolean;
  /**
   * The words of the phrase being spoken right now, for the window that is dictating. They live
   * here, in memory, and nowhere else: never written to disk, never traced, never sent, and dropped
   * the moment the phrase ends. Provisional until `settled`.
   */
  readonly words: string;
  /** True once a quiet room, or a stop, has settled the words above. */
  readonly settled: boolean;
  /** Start listening. Refused, with a sentence, when anything says it must not be. */
  start(): string | null;
  /** Stop listening and let go of the microphone. The words so far are settled. */
  stop(): void;
  /** Re-ask every reason to stop, and stop if one of them now says so. */
  refresh(): void;
  /** Hand in a piece of sound, for the path where Branch holds the recorder. Tests use it directly. */
  hear(piece: Uint8Array): void;
  /**
   * merge-queue review: the system and the program check this listener was built with, so the card
   * describes the same computer the Dictate press will be refused or allowed on.
   */
  readonly platform: string;
  readonly present: ProgramPresent | undefined;
}

/**
 * The listener the app owns. One at a time: pressing Dictate while it is already open is a stop,
 * not a second microphone.
 */
export function startDictation(deps: DictationDeps): LiveDictation {
  const platform = deps.platform ?? process.platform;
  const present = deps.present;
  const room = new RoomFloor();
  const preroll = new DictationPreroll();
  let speech: SpeechStream | null = null;
  let recorder: { stop(): void } | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let words = "";
  let lastSpeechAt = 0;
  let startedAt = 0;
  let crashes = 0;
  /** The one piece of sound ever held, overwritten in place rather than added to. */
  let leftOver: Uint8Array = new Uint8Array(0);

  /** The last thing said, kept only until the next press, so the screen can collect the final words. */
  let last: DictationHeard = { words: "", settled: true };

  const now = () => Date.now();
  const tell = (settled: boolean) => { last = { words, settled }; deps.onHeard(last); };

  /**
   * Everything that holds anything is let go of here, and nowhere else.
   *
   * Integration review: ending the speech program is what tells Branch the program has ended, so
   * this is re-entered by its own `stop()` — and the first version of it settled the phrase twice,
   * the second time with nothing in it, which on the screen is the words appearing and then being
   * wiped. So what is held is let go of *before* anything is ended, and a second call through the
   * door finds nothing left to release and does nothing at all.
   */
  const release = (settle: boolean): void => {
    const going = speech, recording = recorder;
    if (!going) return;
    speech = null; recorder = null;
    if (ticker) { clearInterval(ticker); ticker = null; }
    recording?.stop();
    if (settle) for (const frame of preroll.flush()) going.hear(frame);
    going.stop();
    room.forget();
    preroll.forget();
    leftOver = new Uint8Array(0);
    if (settle) tell(true);
    words = ""; // nothing is kept past the phrase it belongs to
  };

  /** Why it must not be listening this moment, or null. Asked before every piece and on the tick. */
  const mustStop = (): string | null =>
    (deps.locked?.() ? dictationLockedRefusal : null)
    ?? dictationRefusal(deps.store, deps.owner, platform, present);

  const quietFor = (): number => dictationSettings(deps.store, deps.owner).silenceSeconds * 1000;

  /** The tick: a silent microphone is asked about too, and a quiet room lets go of it. */
  const tick = (): void => {
    if (!speech) return;
    // merge-queue review: this runs on a timer, where a throw is an uncaught exception that takes
    // Branch down. Anything that cannot be read (a store already closed) lets go of the microphone.
    try {
      if (mustStop()) { release(true); return; }
      if (now() - lastSpeechAt >= quietFor()) release(true);
    } catch { release(false); }
  };

  const ended = (): void => {
    if (!speech) return;
    // A program that dies the instant it starts is not one that finished. It is counted, the
    // microphone is let go of, and it is not started again by itself — a press starts it, and
    // after a few of these the press is refused with a sentence rather than trying for ever. What
    // it wrote on its way out is not put in the message box: an error is not something a person said.
    if (now() - startedAt < failedWithinMs) crashes += 1; else crashes = 0;
    release(true);
  };

  const heardWords = (written: string): void => {
    const clean = cleanWords(written);
    if (!clean) return;
    lastSpeechAt = now();
    // Replaced rather than grown past the cap: a program that will not stop writing is cut off
    // where it arrives, never queued and never allowed to grow without end.
    words = `${words} ${clean}`.trim().slice(-mostWords);
    tell(false);
  };

  const listener: LiveDictation = {
    platform, present,
    get open() { return speech !== null; },
    // What the screen reads. `last` holds the settled phrase for a moment after the microphone has
    // closed, so the window that asked can still collect the final words; `words` is what is being
    // said right now. Neither is ever written down.
    get words() { return speech ? words : last.words; },
    get settled() { return speech ? false : last.settled; },
    start() {
      if (speech) { listener.stop(); return null; }
      const refusal = mustStop();
      if (refusal) return refusal;
      if (crashes >= mostCrashes)
        return "The speech program on this computer stopped as soon as it was started, three times over. Dictation has let go of the microphone and will not keep trying. Check the program and the model under Settings, Voice.";
      const engine = dictationEngine(voiceSettings(deps.store, deps.owner), platform, present);
      if (!engine.available || !engine.command) return engine.how;
      startedAt = now();
      lastSpeechAt = now();
      words = "";
      last = { words: "", settled: false };
      speech = deps.speech(engine.command, heardWords, ended);
      const capture = dictationCapture(engine, platform, present);
      if (capture) recorder = deps.sound(capture, listener.hear, ended);
      ticker = setInterval(tick, deps.tickMs ?? dictationTickMs);
      ticker.unref?.();
      tell(false);
      return null;
    },
    stop() { if (speech) release(true); },
    refresh() { if (speech && mustStop()) release(true); },
    hear(piece) {
      if (!speech) return;
      if (mustStop()) { release(true); return; }
      leftOver = leftOver.length === 0 ? Uint8Array.from(piece) : join(leftOver, piece);
      // Twenty milliseconds at a time, and what is left over is the only sound ever held: it is
      // overwritten in place each time rather than pushed into anything that could grow.
      let at = 0;
      for (; at + frameBytes <= leftOver.length; at += frameBytes) {
        const frame = leftOver.subarray(at, at + frameBytes);
        const speaking = room.speech(frame);
        if (speaking) lastSpeechAt = now();
        // A program that is not keeping up is not waited for and its sound is not piled up behind
        // it: the piece is dropped where it arrives, which is what keeps this from growing.
        for (const sound of preroll.push(frame, speaking)) speech.hear(sound);
      }
      leftOver = Uint8Array.from(leftOver.subarray(at));
      if (now() - lastSpeechAt >= quietFor()) release(true);
    },
  };
  return listener;
}

/** Two pieces of sound, one after the other. The only place anything is ever joined. */
function join(first: Uint8Array, second: Uint8Array): Uint8Array {
  const both = new Uint8Array(first.length + second.length);
  both.set(first);
  both.set(second, first.length);
  return both;
}

