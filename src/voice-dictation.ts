import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";
import { lockdownOverrides } from "./lockdown.js";
import { bytesPerSecond, onThisComputer, recorderFor, recorderName,
  type ProgramPresent, type RecorderCommand } from "./mic-capture.js";
import type { Store } from "./store.js";
import { voiceSettings, type VoiceSettings } from "./voice.js";

/**
 * mac7/live-voice: speak, and see the words as you say them. On this computer, for nothing, and
 * nothing is sent anywhere.
 *
 * Four things are true of it and are checked by the tests rather than promised here:
 *
 *   • **It holds the microphone open while it is listening, and says so before you switch it on.**
 *     That is the whole feature, and it is the one place this differs from the word that starts a
 *     turn, which takes one window at a time and lets go every window. The card says it in those
 *     words, above the switch, and docs/configuration.md says it too.
 *   • **A quiet room lets go of it.** Nobody speaking for a few seconds ends the phrase and ends
 *     the program that holds the microphone. Nothing here keeps a microphone open for a room that
 *     has gone quiet, whatever the switch says.
 *   • **Nothing is written down.** No file is written, no file name is ever an argument, the sound
 *     is never kept past the piece being written out, and the words go to the screen rather than
 *     into a record. Nothing is fetched and nothing is sent.
 *   • **It fills the message box; it does not send.** The words land where typed words land and a
 *     person presses send. Hearing something grants nothing.
 *
 * It ships **off**. With no streaming speech program on this computer it says which one to install
 * and stays off; Branch installs none of its own, and downloads none.
 */
export const dictationKey = "live-dictation";

export const DictationSettingsSchema = z.object({
  /**
   * off — the Dictate control is not there and nothing can open the microphone; when needed — the
   * control is there while a conversation is open; on — the control is always there. **On never
   * means the microphone is open**: nothing here opens one without a press, whatever this says.
   */
  mode: FeatureModeSchema.default("off"),
  /** How long a quiet room ends the phrase and lets go of the microphone, in seconds. */
  silenceSeconds: z.number().min(1).max(30).default(4),
}).strict();
export type DictationSettings = z.infer<typeof DictationSettingsSchema>;

/** The saved settings, with Lockdown winning over a saved mode exactly as every other switch does. */
export function dictationSettings(store: Pick<Store, "get">, owner: string): DictationSettings {
  const settings = ownDictationSettings(store, owner);
  return lockdownOverrides(store, owner, dictationKey) ? { ...settings, mode: "off" } : settings;
}
/** The owner's own choice as the app would run it, before Lockdown's override: what a change is saved onto. */
function ownDictationSettings(store: Pick<Store, "get">, owner: string): DictationSettings {
  const saved = DictationSettingsSchema.safeParse(store.get("settings", owner, dictationKey)?.data ?? {});
  return saved.success ? saved.data : DictationSettingsSchema.parse({});
}

export function saveDictationSettings(store: Store, owner: string, input: unknown): DictationSettings {
  const given = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  // Saved onto the owner's own choice, never onto Lockdown's view, so a change made while locked keeps their switch.
  const next = DictationSettingsSchema.parse({ ...ownDictationSettings(store, owner), ...given });
  store.save("settings", owner, dictationKey, next);
  return next;
}

/* ---------- what writes the words, on this computer ---------- */

/**
 * How the speech program gets its sound.
 *
 *   • "own-microphone" — the program opens the microphone itself and writes words out as it hears
 *     them. `whisper-stream` and sherpa-onnx's microphone build are both this: they are built
 *     around their own sound capture, which is why whisper.cpp asks for SDL2. **No sound reaches
 *     Branch at all on this path** — only the words, and only while the program runs.
 *   • "reads-sound" — the program is handed sound on its standard input. Branch holds one recorder
 *     open, counts how loud the room is, and feeds it only what carries speech.
 *   • "window-mic" — RES-709: no streaming program, but faster-whisper is here. The window records while the
 *     owner holds Dictate, and each piece is written out on this computer (src/voice-whisper.ts).
 *   • "none" — there is nothing here that can do this, whatever the switch says.
 */
export type DictationEngineKind = "own-microphone" | "reads-sound" | "window-mic" | "none";

export interface DictationEngine {
  available: boolean;
  kind: DictationEngineKind;
  /** What it would use, or why it cannot and what to install, in the owner's words. */
  how: string;
  /** The program and its arguments, or null when there is nothing to run. */
  command: RecorderCommand | null;
}

/**
 * The streaming speech programs Branch looks for, best first, and how each is asked to keep going
 * rather than to write out one recording. **Branch installs none of these and downloads none**: it
 * looks on the owner's own search path for one they put there, exactly as the word that starts a
 * turn does, and says which to install when there is none.
 *
 * These are the flags each program's own command line documents. Nothing here has been run against
 * a real installation on this machine, so a build that names them differently fails plainly when it
 * is started rather than quietly writing nothing out.
 */
const streamingPrograms = [
  {
    file: "whisper-stream", kind: "own-microphone" as const,
    // The pair whisper.cpp's own streaming example documents: look at the last five seconds, and
    // say what you have every half second. That half second is why words appear a little behind.
    args: (model: string, language: string) =>
      ["-m", model, "--step", "500", "--length", "5000", ...(language ? ["-l", language] : [])],
    label: "whisper.cpp's streaming build (whisper-stream)",
  },
  {
    file: "sherpa-onnx-microphone", kind: "own-microphone" as const,
    args: (model: string) => [`--tokens=${model}/tokens.txt`, `--encoder=${model}/encoder.onnx`,
      `--decoder=${model}/decoder.onnx`, `--joiner=${model}/joiner.onnx`],
    label: "sherpa-onnx's microphone build",
  },
  {
    file: "sherpa-onnx-alsa", kind: "own-microphone" as const,
    args: (model: string) => [`--tokens=${model}/tokens.txt`, `--encoder=${model}/encoder.onnx`,
      `--decoder=${model}/decoder.onnx`, `--joiner=${model}/joiner.onnx`, "default"],
    label: "sherpa-onnx's ALSA build",
  },
  {
    // A streaming recogniser the owner points Branch at that is handed sound rather than opening
    // the microphone: this is the path where Branch holds the recorder, counts how loud the room is
    // and feeds it only what carries speech. It is the owner's own program, named under Voice.
    file: "", kind: "reads-sound" as const,
    args: (model: string, language: string) =>
      [...(model ? ["--model", model] : []), ...(language ? ["--language", language] : []), "-"],
    label: "the streaming speech program you named",
  },
] as const;

/** Which of them this computer has, and what Branch would run. Pure: nothing is started here. */
export function dictationEngine(
  voice: VoiceSettings, platform: string = process.platform, present: ProgramPresent = onThisComputer,
): DictationEngine {
  // A program the owner named themselves wins over one merely found on the search path: they chose
  // it, and silently running something else because it happened to be on the path is the kind of
  // substitution a person would never find out about.
  const named = voice.localSpeechStream ? streamingPrograms[3] : undefined;
  const found = named ?? streamingPrograms.filter((program) => program.file).find((program) => present(program.file));
  const vad = vadDictationEngine(voice, present);
  if (!named && vad) return vad;
  if (!found) return { available: false, kind: "none", command: null, how: missingProgram(platform) };
  const file = found.file || voice.localSpeechStream;
  if (!voice.localSpeechModel)
    return { available: false, kind: "none", command: null,
      how: `${found.label} is on this computer, but no speech model is set up for it. Point Branch at one under Settings, Voice — Branch does not download one for you — and dictation can use it; until then the switch stays off.` };
  return {
    available: true, kind: found.kind,
    command: { file, args: [...found.args(voice.localSpeechModel, voice.language)] },
    how: found.kind === "own-microphone"
      ? `${found.label}, which you installed yourself, kept running for as long as you are dictating and ended the moment you stop. It opens the microphone itself, so no sound ever reaches Branch at all — only the words, and only while it runs. Branch runs the first program called ${file} on your search path and does not check what it is, so keep that path yours; it is given its arguments one by one, never a line for a shell to read, and none of this computer's own environment. Words appear about a second behind you and may change as it hears more.`
      : `${found.label}, handed sound on its standard input by a recorder Branch holds open beside it. Branch counts how loud the room is and feeds it only what carries speech, so a quiet room costs it nothing. No file is written and no file name is ever an argument; it is given its arguments one by one, never a line for a shell to read, and none of this computer's own environment. Words appear about a second behind you and may change as it hears more.`,
  };
}

/** Upstream Apache-2.0 sherpa-onnx VAD microphone CLI, 040afe360a38. External program only.
 * Prefer finished segments when the owner supplied a complete transducer/Whisper + Silero bundle. */
function vadDictationEngine(voice: VoiceSettings, present: ProgramPresent): DictationEngine | null {
  const file = "sherpa-onnx-vad-microphone-offline-asr", model = voice.localSpeechModel;
  if (!model || !present(file)) return null;
  const vad = join(model, "silero_vad.onnx");
  if (!existsSync(vad)) return null;
  const asr = sherpaVadAsr(model, voice.language);
  if (!asr) return null;
  return { available: true, kind: "own-microphone", command: { file, args: [
    `--silero-vad-model=${vad}`, ...asr,
  ] }, how: "Your installed sherpa-onnx VAD microphone program stays loaded while you dictate and writes each finished speech segment once. It uses the Silero and complete speech models you supplied, opens the microphone itself, and stops when you stop dictating. Branch downloads nothing." };
}

/** Flags/layouts in the pinned sherpa VAD microphone and offline Whisper CLI sources. */
function sherpaVadAsr(model: string, language: string): string[] | null {
  const files = ["tokens.txt", "encoder.onnx", "decoder.onnx", "joiner.onnx"];
  if (files.every(file => existsSync(join(model, file))))
    return files.map((file, index) => `--${["tokens", "encoder", "decoder", "joiner"][index]}=${join(model, file)}`);
  const names = ["tiny.en", "base.en", "tiny", "base", "small.en", "small", "medium.en", "medium", "large"];
  for (const name of names) for (const precision of [".int8", ""]) {
    const encoder = join(model, `${name}-encoder${precision}.onnx`), decoder = join(model, `${name}-decoder${precision}.onnx`);
    const tokens = join(model, `${name}-tokens.txt`);
    if ([encoder, decoder, tokens].every(file => existsSync(file))) return [
      `--whisper-encoder=${encoder}`, `--whisper-decoder=${decoder}`, `--tokens=${tokens}`, "--num-threads=1",
      ...(language ? [`--whisper-language=${language}`] : []),
    ];
  }
  return null;
}

const missingProgram = (platform: string): string =>
  platform === "linux"
    ? "This computer has no speech program that writes words out as you speak: neither sherpa-onnx nor whisper.cpp's streaming build is here. Install one yourself — sherpa-onnx is the smallest that genuinely streams, and it needs no graphics card — and dictation can use it. Branch will not install one of its own, and will not download one, so until then the switch stays off."
    : platform === "darwin"
      ? "This Mac has no speech program that writes words out as you speak. macOS has one of its own inside the system, but there is no command a program can ask for it, and Branch will not ship a helper of its own to reach it. Install one yourself — `brew install whisper-cpp` brings `whisper-stream`, and it needs a model you point Branch at — and dictation can use it. Branch will not install one of its own, and will not download one, so until then the switch stays off."
      : "This computer has no speech program that writes words out as you speak. Windows' own speech recognition listens for one phrase at a time rather than writing out free speech, so it cannot do this. Install whisper.cpp's streaming build (`whisper-stream`) yourself and point Branch at a model, and dictation can use it. Branch will not install one of its own, and will not download one, so until then the switch stays off.";

/**
 * The recorder dictation would hold open, for a program that is handed sound rather than opening
 * the microphone itself. One recorder, held for as long as the room is being listened to and ended
 * with it — which is the thing the word that starts a turn never does, and why the written promise
 * about letting go of the microphone every window had to be rewritten rather than left standing.
 */
export function dictationCapture(
  engine: DictationEngine, platform: string = process.platform, present: ProgramPresent = onThisComputer,
): RecorderCommand | null {
  if (engine.kind !== "reads-sound") return null;
  return recorderFor(platform, present, null, "stream");
}

/* ---------- how loud the room is ---------- */

/** Twenty milliseconds of sound at a time: small enough to hear a pause, big enough to mean something. */
export const frameBytes = Math.round(bytesPerSecond * 0.02);

/**
 * How loud one piece of sound is, between 0 and 1. Plain arithmetic over the samples themselves —
 * the root of the mean of their squares — so it needs no model, no library and no program at all,
 * and it can be checked with nothing installed.
 */
export function loudness(sound: Uint8Array): number {
  const samples = Math.floor(sound.length / 2);
  if (samples === 0) return 0;
  let total = 0;
  for (let at = 0; at < samples; at += 1) {
    const low = sound[at * 2] ?? 0, high = sound[at * 2 + 1] ?? 0;
    const value = ((high << 24) >> 16) | low; // two bytes, the low one first, read as a signed number
    total += (value / 32768) ** 2;
  }
  return Math.sqrt(total / samples);
}

/**
 * Four-state hysteresis ported from Pipecat vad_analyzer.py at 20999cd7b816
 * (Copyright 2024-2026 Daily, BSD-2-Clause; THIRD_PARTY_NOTICES.md). The existing
 * energy detector remains local; only quiet frames adapt its floor, so speech on
 * the first frame is never learned as ambient noise. No neural VAD is downloaded.
 */
export class RoomFloor {
  private floor = 0.004;
  private state: "quiet" | "starting" | "speaking" | "stopping" = "quiet";
  private count = 0;
  static readonly overFloor = 2.5;
  static readonly leastLoud = 0.01;
  static readonly startFrames = 10;
  static readonly stopFrames = 10;

  /** 200ms start and stop hysteresis, in the recorder's 20ms frames. */
  speech(sound: Uint8Array): boolean {
    const level = loudness(sound);
    const loud = level > Math.max(this.floor * RoomFloor.overFloor, RoomFloor.leastLoud);
    if (loud) {
      if (this.state === "quiet") { this.state = "starting"; this.count = 1; }
      else if (this.state === "starting") this.count += 1;
      else if (this.state === "stopping") { this.state = "speaking"; this.count = 0; }
    } else {
      if (this.state === "quiet") this.floor = this.floor * 0.98 + level * 0.02;
      else if (this.state === "starting") { this.state = "quiet"; this.count = 0; }
      else if (this.state === "speaking") { this.state = "stopping"; this.count = 1; }
      else this.count += 1;
    }
    if (this.state === "starting" && this.count >= RoomFloor.startFrames) { this.state = "speaking"; this.count = 0; }
    if (this.state === "stopping" && this.count >= RoomFloor.stopFrames) { this.state = "quiet"; this.count = 0; }
    return this.state === "speaking" || this.state === "stopping";
  }
  /** Forgotten when the microphone is let go of, so the next room is learned afresh. */
  forget(): void { this.floor = 0.004; this.state = "quiet"; this.count = 0; }
}

/* ---------- the words that come back ---------- */

/** The most words ever held at once. A program that will not stop writing is cut off, never queued. */
export const mostWords = 4000;

/**
 * What a streaming speech program writes out, made into words for the screen. Each of them writes
 * lines; some rewrite the line they last wrote as they hear more, and whisper.cpp marks its timings
 * in square brackets. What is kept is the words, and only the words.
 */
export function cleanWords(written: string): string {
  return written
    .replace(/\[Start speaking\]/gi, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") // the codes a program uses to rewrite its own line
    .replace(/\[[0-9:.\s>-]+\]/g, "")       // whisper.cpp's timings
    .replace(/\r/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- every reason not to ---------- */

/** Integration review: why nothing is listening while Branch is locked, in the owner's words. */
export const dictationLockedRefusal =
  "Branch is locked, so dictation is off and the microphone is let go of. Unlock it and press Dictate again.";

/**
 * RES-709: the free speech program on this computer (src/voice-whisper.ts), as the window's own microphone uses
 * it. When no streaming program is here but this is, the window records while Dictate is held and this writes
 * it out, on this computer; the switch above still decides whether the microphone may be used at all.
 */
export interface WindowSpeech { available: boolean; how: string }

/** Why dictation is refused right now, or null. Every sentence is one the owner reads. */
export function dictationRefusal(
  store: Store, owner: string, platform: string = process.platform,
  present: ProgramPresent = onThisComputer, local: WindowSpeech | null = null,
): string | null {
  const settings = dictationSettings(store, owner);
  if (settings.mode === "off")
    return lockdownOverrides(store, owner, dictationKey)
      ? "Lockdown is on, so dictation is off and nothing can open the microphone. Turn Lockdown off in Settings to allow this again."
      : "Dictation is switched off, so nothing is listening. Turn it on in Settings, Voice.";
  const engine = dictationEngine(voiceSettings(store, owner), platform, present);
  if (!engine.available) return local?.available ? null : local ? local.how : engine.how;
  if (engine.kind === "reads-sound" && !dictationCapture(engine, platform, present))
    return "This computer has no recording program to feed that speech program. Install one yourself — `brew install sox` on a Mac, arecord or parecord on Linux — and dictation can use it; until then the switch stays off.";
  return null;
}

/** What the card shows: the switch, what this computer would really do, and whether it is open. */
export function dictationState(
  store: Store, owner: string, platform: string = process.platform,
  /** Whether the microphone is open this moment. Read from the listener itself, never from the switch. */
  open = false, present: ProgramPresent = onThisComputer, local: WindowSpeech | null = null,
): {
  settings: DictationSettings; mode: FeatureMode; engine: DictationEngine; recorder: string | null;
  refusal: string | null; open: boolean; canDictate: boolean; windowMic: boolean;
} {
  const settings = dictationSettings(store, owner);
  const streaming = dictationEngine(voiceSettings(store, owner), platform, present);
  // RES-709: no streaming program, but the free one is here: the window's microphone, written out on this computer.
  // With neither, what the card says to install is the free one, which is the one that needs the least.
  const windowMic = !streaming.available && !!local?.available;
  const engine: DictationEngine = streaming.available || !local ? streaming
    : { available: local.available, kind: local.available ? "window-mic" : "none", how: local.how, command: null };
  return {
    settings, mode: settings.mode, engine,
    // The recorder's own name, for the sentence a person reads before macOS asks them about the
    // microphone. Only ever a name, never the full path, which is a thing of this computer's.
    recorder: engine.kind === "reads-sound" ? recorderName(platform, present) : null,
    refusal: dictationRefusal(store, owner, platform, present, local),
    canDictate: engine.available,
    open, windowMic,
  };
}

export const dictationOwnerOnlyRefusal =
  "Dictation is the owner's. It opens the microphone on this computer, so it is not offered to anybody else who uses it, and nothing but the owner at this window can switch it on or start it.";

/**
 * The same, as it goes over the wire, and **the owner's alone**. Somebody else on this computer — a
 * household profile — is told that dictation is the owner's and nothing else: not the switch, not
 * which program is here, not the model, and never the control itself.
 */
export function dictationView(
  store: Store, owner: string, platform: string = process.platform, isOwner = true,
  open = false, present: ProgramPresent = onThisComputer, local: WindowSpeech | null = null,
): Record<string, unknown> {
  if (!isOwner)
    return { isOwner: false, canDictate: false, open: false, mode: "off" as FeatureMode,
      refusal: dictationOwnerOnlyRefusal };
  const state = dictationState(store, owner, platform, open, present, local);
  // The program's full path never travels: it is a thing of the owner's computer, and the card only
  // ever shows the sentence and whether there is a program at all, as the wake word's card does.
  return { ...state, isOwner: true,
    engine: { available: state.engine.available, kind: state.engine.kind, how: state.engine.how } };
}
