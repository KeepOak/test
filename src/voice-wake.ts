import { z } from "zod";
import { findLocalWhisper, type LocalWhisper, type LocalWhisperFound } from "./voice-whisper.js";
import { keywordSpotter } from "./voice-wake-kws.js";
// mac7/live-voice: the microphone itself now lives on its own in src/mic-capture.ts, because live
// dictation wants exactly the same sound from exactly the same programs, held open rather than
// taken one window at a time. Nothing about the wake word changed with the move: the names below
// are still the ones this file has always exported, and the commands are byte for byte the same.
import { micSampleRate, onThisComputer as programOnThisComputer, recorderFor, recorderName,
  windowBytes as micWindowBytes, type ProgramPresent as MicProgramPresent } from "./mic-capture.js";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";
import { lockdownOverrides } from "./lockdown.js";
import type { Store } from "./store.js";
import { voiceSettings, type VoiceSettings } from "./voice.js";

/**
 * mac7/wake-pins: a word that starts a turn without the Talk button.
 *
 * Three things are true of it and are checked by the tests rather than promised here:
 *
 *   • Listening happens on this computer only. The word is spotted by something already on this
 *     machine, and no sound ever leaves it. When this computer has nothing that can spot a word on
 *     its own, nothing listens whatever the switch says, and the card says so, rather than
 *     sending sound to a service.
 *   • Nothing is recorded before the word is heard. What the listener holds is a few seconds of
 *     sound in memory, thrown away every time the word is not there. No file is written, and
 *     nothing is kept, until the word has been heard.
 *   • The word opens an ordinary spoken turn. It grants nothing: the turn is asked about exactly as
 *     the same words typed into the box would be. What it carries is the one window the word was in
 *     and nothing more — no further sound is recorded for it — and on Windows, whose engine listens
 *     for that one phrase alone, that is the word by itself.
 *
 * Holding the Talk button (R17-S18) stays the way in. This ships off, like every other feature.
 */
export const wakeWordKey = "wake-word";

export const WakeWordSettingsSchema = z.object({
  /** off — nothing listens at all; when needed — only while a conversation is open; on — whenever Branch is running. */
  mode: FeatureModeSchema.default("off"),
  /** The owner's own word or short phrase. Empty means there is nothing to listen for. */
  word: z.string().trim().max(40).default(""),
  /** How sure the spotter must be, out of a hundred. Lower hears the word more often, and more often wrongly. */
  sureness: z.number().int().min(50).max(99).default(80),
  keywordModel: z.string().trim().max(400).default(""),
  keywordFile: z.string().trim().max(400).default(""),
  confirmationFrames: z.number().int().min(1).max(20).default(3),
  /**
   * The longest piece of sound the listener will hold at once, in seconds. A piece longer than this
   * is dropped without being looked at, so however the sound arrives, no more than this is ever in
   * memory, and it is thrown away again whether the word was in it or not.
   */
  windowSeconds: z.number().int().min(1).max(5).default(2),
}).strict();
export type WakeWordSettings = z.infer<typeof WakeWordSettingsSchema>;

/** The saved settings, with Lockdown winning over a saved mode exactly as every other switch does. */
export function wakeWordSettings(store: Pick<Store, "get">, owner: string): WakeWordSettings {
  const settings = ownWakeWordSettings(store, owner);
  return lockdownOverrides(store, owner, wakeWordKey) ? { ...settings, mode: "off" } : settings;
}
/** The owner's own choice as the app would run it, before Lockdown's override: what a change is saved onto. */
function ownWakeWordSettings(store: Pick<Store, "get">, owner: string): WakeWordSettings {
  const saved = WakeWordSettingsSchema.safeParse(store.get("settings", owner, wakeWordKey)?.data ?? {});
  return saved.success ? saved.data : WakeWordSettingsSchema.parse({});
}

export function saveWakeWordSettings(store: Store, owner: string, input: unknown): WakeWordSettings {
  const given = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  // Saved onto the owner's own choice, never onto Lockdown's view, so a change made while locked keeps their switch.
  const next = WakeWordSettingsSchema.parse({ ...ownWakeWordSettings(store, owner), ...given });
  store.save("settings", owner, wakeWordKey, next);
  return next;
}

/* ---------- what each computer can really do ---------- */

/** A program run for the spotter. Always passed in, so a test hands in a fake and no microphone is opened. */
export type WakeRunner = (
  file: string, args: readonly string[], input: Uint8Array, env: Readonly<Record<string, string>>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface WakeSpotter {
  /** True when this computer can spot a word on its own. */
  available: boolean;
  /**
   * Which spotter this is. Windows' own engine can open the microphone for itself; a speech program
   * the owner set up is handed sound by something else. The capture below turns on that difference.
   */
  kind: "windows-speech" | "own-program" | "faster-whisper" | "streaming-keyword" | "none";
  whisper?: LocalWhisperFound;
  /** What it would use, or why it cannot, in the owner's words. */
  how: string;
  /**
   * The program, its arguments and the whole of the environment it is given, or null when there is
   * nothing to run. The environment is built here and holds only these two names: the spotter never
   * inherits this computer's own environment, so nothing of the owner's can leak into it, and the
   * word travels as its own thing rather than as text inside a command (integration review).
   */
  command: { file: string; args: string[]; env: Record<string, string> } | null;
}

const windowsSpotter = (word: string, sureness: number, ownMicrophone: boolean, windowSeconds: number): WakeSpotter => ({
  available: true,
  kind: "windows-speech",
  how: ownMicrophone
    ? "Windows' own speech recognition, which runs on this computer, opens the microphone itself and needs nothing installed."
    : "Windows' own speech recognition, which runs on this computer and needs nothing installed.",
  command: {
    file: "powershell.exe",
    // The word is never put into the script text. PowerShell's -Command takes one string and glues
    // any words after it onto the end of that same string, so an argument there would be read as
    // PowerShell after all; the word is handed over in the environment instead, where it is only
    // ever a value (integration review, mac7/wake-pins).
    args: ["-NoProfile", "-NonInteractive", "-Command", ownMicrophone ? windowsListeningScript : windowsScript],
    env: ownMicrophone
      ? { ...wakeEnvironment(word, sureness), BRANCH_WAKE_WINDOW: String(windowSeconds) }
      : wakeEnvironment(word, sureness),
  },
});

/**
 * The whole environment the spotter is given: the word, how sure it must be, and nothing else. Built
 * rather than inherited, so neither this computer's environment nor anything in it reaches the
 * spotter, and the word is a value the program reads rather than text in a command line.
 */
const wakeEnvironment = (word: string, sureness: number): Record<string, string> =>
  ({ BRANCH_WAKE_WORD: word, BRANCH_WAKE_SURENESS: String(sureness / 100) });

/**
 * The one-word grammar, on this computer. System.Speech ships with Windows, recognises against a
 * grammar of exactly one phrase, and never reaches the network; the online Windows dictation
 * service is a different class and is not used.
 */
const windowsGrammar = [
  "$Word = $env:BRANCH_WAKE_WORD",
  "$Sureness = [double]$env:BRANCH_WAKE_SURENESS",
  "Add-Type -AssemblyName System.Speech",
  "$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine",
  "$choices = New-Object System.Speech.Recognition.Choices($Word)",
  "$builder = New-Object System.Speech.Recognition.GrammarBuilder($choices)",
  "$engine.LoadGrammar((New-Object System.Speech.Recognition.Grammar($builder)))",
];
const windowsAnswer = "if ($heard -and $heard.Confidence -ge $Sureness) { Write-Output $heard.Text }";

/** Sound handed in on standard input: what mac7/wake-pins wrote, unchanged. */
const windowsScript = [
  ...windowsGrammar,
  "$engine.SetInputToWaveStream([Console]::OpenStandardInput())",
  "$heard = $engine.Recognize()",
  windowsAnswer,
].join("; ");

/**
 * mac7/wake-mic: the same engine opening the microphone itself, for one window and no longer. The
 * window is a number the owner chose between one and five, and it travels in the environment beside
 * the word rather than being pasted into the script, exactly as the word does.
 *
 * One run is one window: the program ends when the window is up, which is what lets go of the
 * microphone. Nothing is written down, and no sound ever reaches Branch at all on this path.
 */
const windowsListeningScript = [
  ...windowsGrammar,
  "$engine.SetInputToDefaultAudioDevice()",
  "$heard = $engine.Recognize([TimeSpan]::FromSeconds([double]$env:BRANCH_WAKE_WINDOW))",
  windowsAnswer,
].join("; ");

const ownSpeechProgram = (settings: VoiceSettings, word: string): WakeSpotter => ({
  available: true,
  kind: "own-program",
  // The word itself is never put in this sentence: the sentence is shown to whoever is using this
  // computer, and the owner's word is theirs alone (integration review, mac7/wake-pins).
  how: `The speech program you already set up on this computer (${settings.localSpeechKind}), asked only whether it heard your word. It writes out what it heard rather than saying how sure it is, so "how sure it must be" does nothing while this is what spots the word.`,
  command: {
    file: settings.localSpeechExecutable,
    args: settings.localSpeechKind === "whisper-cpp"
      ? ["-m", settings.localSpeechModel, "-f", "-", "-otxt", "-nt"]
      : ["--model", settings.localSpeechModel, "--output_format", "txt", "-"],
    env: wakeEnvironment(word, 0),
  },
});

const nothingHere = (platform: string): WakeSpotter => ({
  available: false,
  kind: "none",
  how: platform === "darwin"
    ? "This Mac has nothing that spots a word on its own: macOS keeps its speech recognition inside apps with a window, and there is no command here that can be asked. Set up a speech program on this computer under Voice and the wake word can use that; until then nothing listens here, whatever the switch says, because the only other way would be sending what your microphone hears to a service, which is never done."
    : "This computer has nothing that spots a word on its own: Linux ships no speech recognition. Set up a speech program on this computer under Voice and the wake word can use that; until then nothing listens here, whatever the switch says, because the only other way would be sending what your microphone hears to a service, which is never done.",
  command: null,
});

/**
 * What this computer would really use to spot the word. Windows has a word-spotter of its own;
 * macOS and Linux have none that a program can ask, so they use a speech program the owner has
 * already set up, and say plainly that there is nothing otherwise.
 */
export function wakeSpotter(
  settings: VoiceSettings, wake: WakeWordSettings, platform: string = process.platform,
  /** True when this spotter is the one opening the microphone, rather than being handed sound. */
  ownMicrophone = false,
  present: ProgramPresent = programOnThisComputer,
): WakeSpotter {
  if (!wake.word) return { available: false, kind: "none", how: "No word has been chosen yet.", command: null };
  const keyword = keywordSpotter(settings, wake, present);
  if (keyword) return keyword;
  // mac7/wake-mic: when this spotter is the one opening the microphone, Windows' own engine is the
  // only thing here that can, whatever speech program the owner has set up for writing out
  // recordings — Windows ships no recorder to feed one.
  if (ownMicrophone && platform === "win32") return windowsSpotter(wake.word, wake.sureness, true, wake.windowSeconds);
  const python = /(?:^|[\\/])python[\d.]*?(?:\.exe)?$/i.test(settings.localSpeechExecutable);
  if (settings.localSpeechKind === "faster-whisper" || python || !settings.localSpeechExecutable) {
    const whisper = findLocalWhisper({ ...settings, localSpeechKind: python ? "faster-whisper" : settings.localSpeechKind }, { platform });
    if (whisper.available) return { available: true, kind: "faster-whisper", command: null, whisper,
      how: "Your existing faster-whisper worker keeps its model loaded between wake-word recordings. Everything stays on this computer; recordings still use separate windows and can miss speech during recognition." };
    if (settings.localSpeechKind === "faster-whisper" || python)
      return { available: false, kind: "none", command: null, how: whisper.how };
  }
  if (settings.localSpeechExecutable && settings.localSpeechModel) return ownSpeechProgram(settings, wake.word);
  if (platform === "win32") return windowsSpotter(wake.word, wake.sureness, ownMicrophone, wake.windowSeconds);
  return nothingHere(platform);
}

/* ---------- what opens the microphone, on each computer ---------- */

/** Whether a program is on this computer, asked without running it (src/mic-capture.ts). */
export type ProgramPresent = MicProgramPresent;

/**
 * How the sound gets in.
 *
 *   • "recorder" — a recorder this system ships is run for one window and then ends.
 *   • "spotter-listens" — the spotter opens the microphone itself, so Branch never holds any sound.
 *   • "none" — nothing here can listen, whatever the switch says.
 */
export type WakeCaptureKind = "recorder" | "spotter-listens" | "none";

export interface WakeCapture {
  kind: WakeCaptureKind;
  /** True when this computer can listen at all. */
  available: boolean;
  /** What it would use, or why it cannot, in the owner's words. */
  how: string;
  /** The recorder and its arguments, or null when nothing is run to record. */
  command: { file: string; args: string[] } | null;
}

/** Sixteen thousand samples a second, two bytes each, one channel: what every recorder is asked for. */
export const wakeSampleRate = micSampleRate;
/** The most bytes one window may ever be, so a recorder that will not stop is stopped by the count. */
export const windowBytes = micWindowBytes;

/**
 * mac7/wake-mac: what would open the microphone on a Mac. macOS ships no recorder a program can
 * ask, so Branch looks for one the owner already installed and runs nothing otherwise — it installs
 * nothing, bundles nothing, and a Mac with none says which one to install and stays off.
 *
 * The sentence names the program it found, because macOS itself is about to ask the owner whether
 * Branch may open the microphone and they should know what would be asking before they say yes.
 */
function macRecorder(present: ProgramPresent, windowSeconds: number): WakeCapture {
  const file = recorderName("darwin", present);
  const command = recorderFor("darwin", present, windowSeconds, "window");
  if (!file || !command)
    return cannotListen("This Mac has no recording program on it: macOS ships no recorder a program can ask for sound, and Branch will not install one of its own to open your microphone. Install one yourself — `brew install sox` is the smallest — and the wake word can use it; until then the switch stays off.");
  return {
    kind: "recorder", available: true,
    command,
    // Integration review: "which you installed yourself" implied a check that is not made. Branch
    // runs the first program of that name on the owner's own search path and does not look at what
    // it is, so the card says so. What is really true of it is said beside it: it is given an
    // argument array rather than anything a shell reads, and none of this computer's environment.
    how: `${file}, run for one window of sound at a time and then ended, so the microphone is let go of every window. Branch runs the first program called ${file} on your search path and does not check what it is, so keep that path yours; it is given its arguments one by one, never a line for a shell to read, and none of this computer's own environment. The first time it runs, macOS itself will ask whether Branch may use your microphone: that question comes from macOS, it is yours to accept or refuse, and Branch cannot answer it for you — until you do, nothing is heard, and it keeps waiting rather than giving up.`,
  };
}

const cannotListen = (how: string): WakeCapture => ({ kind: "none", available: false, how, command: null });

/**
 * What would really open the microphone here. Each system is asked about what it ships, never told:
 * Linux is looked up on the search path, and neither recorder is assumed to be there.
 */
export function wakeCapture(
  platform: string, present: ProgramPresent, spotter: WakeSpotter, windowSeconds: number,
): WakeCapture {
  // mac7/wake-mac: a Mac is looked at before the spotter, so the card can say which recording
  // program is here, or which to install, even while there is nothing to spot the word with yet.
  if (spotter.kind === "streaming-keyword") return { kind: "spotter-listens", available: true,
    command: null, how: "Your installed keyword program holds the microphone open while the wake word is on and closes it when listening ends." };
  if (platform === "darwin") return macRecorder(present, windowSeconds);
  if (!spotter.available)
    return cannotListen("Nothing here can spot the word, so there is nothing to listen with either.");
  if (spotter.kind === "windows-speech")
    return { kind: "spotter-listens", available: true, command: null,
      how: "Windows' own speech recognition opens the microphone itself, for one window at a time, and no sound ever reaches Branch." };
  if (platform === "linux") {
    const recorder = recorderFor("linux", present, windowSeconds, "window");
    return recorder
      ? { kind: "recorder", available: true, command: recorder,
          how: `${recorder.file}, which is already on this computer, run for one window of sound at a time and then ended.` }
      : cannotListen("This computer has no recorder a program can ask: neither arecord nor parecord is here. Install one of them yourself and the wake word can use it; until then nothing listens here, whatever the switch says, because Branch will not add a program of its own to open your microphone.");
  }
  return cannotListen("This computer has no recorder a program can ask, so nothing can be listened for, whatever the switch says.");
}

/* ---------- starting, and every reason not to ---------- */

/** The real answer on this computer: a look at the search path, which starts nothing. */
export const onThisComputer: ProgramPresent = programOnThisComputer;

/**
 * The settings, the spotter and the capture, worked out together and in that order. A spotter that
 * opens the microphone itself is asked for a second time once the capture has said so, which is the
 * only thing that changes about it; nothing here runs anything.
 */
export function wakeParts(
  store: Store, owner: string, platform: string = process.platform, present: ProgramPresent = onThisComputer,
): { wake: WakeWordSettings; spotter: WakeSpotter; capture: WakeCapture } {
  const wake = wakeWordSettings(store, owner);
  const voice = voiceSettings(store, owner);
  const handedSound = wakeSpotter(voice, wake, platform, false, present);
  const recorded = wakeCapture(platform, present, handedSound, wake.windowSeconds);
  // The spotter that opens the microphone is a different program from the one that is handed sound,
  // so it is asked for once the capture has said which this is. Windows has nothing to record with,
  // so its own engine is also what listens there when the owner has set up a speech program of
  // their own: that program could spot the word, but nothing on Windows could feed it.
  const listensItself = recorded.kind === "spotter-listens" || (!recorded.available && platform === "win32");
  if (!listensItself) return { wake, spotter: handedSound, capture: recorded };
  const spotter = wakeSpotter(voice, wake, platform, true, present);
  return { wake, spotter, capture: wakeCapture(platform, present, spotter, wake.windowSeconds) };
}

/**
 * Integration review: why nothing is listening while Branch is locked. Locking it lets go of the
 * microphone as it lets go of everything else held only for "while I am here", and unlocking it
 * starts listening again by itself.
 */
export const lockedRefusal =
  "Branch is locked, so nothing is listening for your word. Unlock it and it listens again.";

/** Why listening for the word is refused right now, or null. Every sentence is one the owner reads. */
export function wakeRefusal(
  store: Store, owner: string, platform: string = process.platform, present: ProgramPresent = onThisComputer,
): string | null {
  const wake = wakeWordSettings(store, owner);
  if (wake.mode === "off")
    return lockdownOverrides(store, owner, wakeWordKey)
      ? "Lockdown is on, so nothing is listening for your word. Turn Lockdown off in Settings to allow this again."
      : "The wake word is switched off, so nothing is listening. Turn it on in Settings, Voice.";
  if (!wake.word) return "No word has been chosen yet, so there is nothing to listen for. Choose one in Settings, Voice.";
  // mac7/wake-mic: "when needed" means "only while a conversation is open on the screen", and
  // nothing tells this listener that. Rather than listen all the time under a switch that promises
  // otherwise, it says so and holds nothing open.
  if (wake.mode === "when-needed")
    return "\"When needed\" is not wired up yet: nothing tells the listener whether a conversation is open on the screen, so it would end up listening all the time, which is not what that setting says. Choose On, or leave it Off, in Settings, Voice.";
  const { spotter, capture } = wakeParts(store, owner, platform, present);
  if (!spotter.available) return spotter.how;
  // mac7/wake-mic: spotting the word is not listening for it. A computer with no way to record is
  // refused here, after the spotter, so the sentence the owner reads names the real reason.
  if (!capture.available) return capture.how;
  return null;
}

/** What this computer would really use to hear the word at all: the recorder, or the spotter itself. */
export function wakeCaptureFor(
  store: Store, owner: string, platform: string = process.platform, present: ProgramPresent = onThisComputer,
): WakeCapture {
  return wakeParts(store, owner, platform, present).capture;
}

/** What the card shows: the switch, the word, and what this computer would really do. */
export function wakeWordState(
  store: Store, owner: string, platform: string = process.platform,
  /** Whether the listener is running this moment. Read from the listener itself, never guessed from the switch. */
  listening = false, present: ProgramPresent = onThisComputer,
): {
  settings: WakeWordSettings; spotter: WakeSpotter; capture: WakeCapture; refusal: string | null;
  mode: FeatureMode; listening: boolean; canListen: boolean;
} {
  const { wake: settings, spotter, capture } = wakeParts(store, owner, platform, present);
  return {
    settings, mode: settings.mode, spotter, capture,
    refusal: wakeRefusal(store, owner, platform, present),
    /** Whether this computer can listen for a word at all, whatever the switch says. */
    canListen: spotter.available && capture.available,
    listening,
  };
}

/**
 * The same, as it goes over the wire. The program that would be run never travels: its full path is
 * a thing of the owner's, and the card only ever shows the sentence and whether there is a spotter
 * at all. What is left is the switch, the word, that sentence, and why it is refused right now.
 */
export function wakeWordView(
  store: Store, owner: string, platform: string = process.platform, isOwner = true,
  listening = false, present: ProgramPresent = onThisComputer,
): {
  settings: Omit<WakeWordSettings, "word" | "keywordModel" | "keywordFile"> & {
    word?: string; keywordModel?: string; keywordFile?: string;
  }; spotter: { available: boolean; how: string };
  capture: { available: boolean; how: string }; refusal: string | null; mode: FeatureMode;
  listening: boolean; canListen: boolean; wordChosen: boolean;
} {
  const state = wakeWordState(store, owner, platform, listening, present);
  const { word, keywordModel: _model, keywordFile: _keywords, ...rest } = state.settings;
  return {
    ...state,
    // The word is the owner's own. Somebody else on this computer is told whether one has been
    // chosen — which is why nothing is listening — and never what it is (integration review).
    settings: isOwner ? state.settings : rest,
    wordChosen: word.length > 0,
    spotter: { available: state.spotter.available, how: state.spotter.how },
    // The recorder's own name is a thing of this computer's; the sentence is what the card shows.
    capture: { available: state.capture.available, how: state.capture.how },
  };
}

/* ---------- the listener ---------- */

export interface WakeHeard {
  heard: boolean;
  /** What the spotter wrote out, kept only long enough to compare it with the word. */
  text: string;
  /**
   * Integration review: whether the spotter ran at all. A spotter that fails the instant it starts
   * — no PowerShell, a rule that blocks it, no microphone — is not a window that heard nothing, and
   * the loop has to tell the two apart or it starts the failing program as fast as it can.
   */
  ok: boolean;
}

/** Whether what the spotter wrote out is the owner's word. Case and punctuation are ignored. */
export function isTheWord(text: string, word: string): boolean {
  const plain = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim();
  const said = plain(text), wanted = plain(word);
  return wanted.length > 0 && said.includes(wanted);
}

/**
 * Asks the spotter about one window of sound. The runner is a parameter, so every test hands in a
 * fake and no microphone is ever opened; nothing here writes a file, and the sound is handed to the
 * program on its standard input rather than being put anywhere on disk.
 */
export async function askSpotter(runner: WakeRunner, spotter: WakeSpotter, word: string, sound: Uint8Array, whisper?: LocalWhisper, signal?: AbortSignal): Promise<WakeHeard> {
  if (spotter.whisper) {
    try {
      const heard = await whisper?.transcribe(spotter.whisper, sound, { partial: true }, signal);
      const text = heard?.text.slice(0, 200) ?? "";
      return { heard: isTheWord(text, word), text, ok: heard !== null && heard !== undefined };
    } catch { return { heard: false, text: "", ok: false }; }
  }
  if (!spotter.command) return { heard: false, text: "", ok: false };
  const done = await runner(spotter.command.file, spotter.command.args, sound, spotter.command.env);
  const text = done.code === 0 ? done.stdout.trim().slice(0, 200) : "";
  return { heard: isTheWord(text, word), text, ok: done.code === 0 };
}

/** A window of sound, and how many seconds of it there are. */
export interface WakeChunk { sound: Uint8Array; seconds: number }

/**
 * Integration review: how long the listener waits after a window that failed. A recorder or a
 * spotter that fails the instant it is started paces nothing, so without this the loop would start
 * the failing program again as fast as it could turn — which on the one computer whose spotter
 * opens its own microphone meant no timer in the whole app ever ran again.
 */
export const wakeBackoffMs = 2000;

/**
 * A wait between windows. Always a parameter, so a test drives the loop without real time passing.
 * Even a wait of nothing waits: it hands the turn back to the app, so a listener can never hold on
 * to it, and the wait is let go of by the app so it can never keep Branch running by itself.
 */
export type WakePause = (ms: number) => Promise<void>;
export const waitBetweenWindows: WakePause = (ms) => new Promise((settle) => { setTimeout(settle, ms); });

/**
 * The same wait, cut short the moment the listener is told to stop. Integration review: a wait that
 * outlived the stop held up closing the app for as long as it had left to run, and a wait the app
 * had let go of was never serviced at all — `stop()` then never came back, and with it `close()`.
 */
const waitOrStop = (pause: WakePause, ms: number, signal: AbortSignal): Promise<void> =>
  signal.aborted ? Promise.resolve() : new Promise((settle) => {
    const done = () => { signal.removeEventListener("abort", done); settle(); };
    signal.addEventListener("abort", done, { once: true });
    void pause(ms).then(done);
  });

export interface WakeListenerDeps {
  store: Store;
  owner: string;
  runner: WakeRunner;
  whisper?: LocalWhisper;
  platform?: string;
  present?: ProgramPresent;
  /** The wait after a window; the real one above unless a test hands in its own. */
  pause?: WakePause;
  /**
   * Integration review: whether Branch is locked this moment. Locking it lets go of the microphone,
   * and being locked is a state rather than a single push: while it is locked nothing may start
   * listening again, whoever saves a setting — the card, a settings file or a preset.
   */
  locked?: () => boolean;
}

/**
 * Listens for the word over a stream of sound the caller provides. The stream is a parameter as
 * well: nothing in this file opens a microphone, and the sound it is handed is held in memory for
 * at most the window the owner chose and dropped the moment the word is not in it.
 *
 * It answers the first time the word is heard, and stops; what happens next is an ordinary spoken
 * turn with the same permissions and the same questions as a typed one.
 */
export async function listenForWake(
  deps: WakeListenerDeps, sound: AsyncIterable<WakeChunk>, signal?: AbortSignal,
): Promise<{ heard: boolean; text: string; refusal: string | null; windowsTried: number; windowsTooLong: number }> {
  const platform = deps.platform ?? process.platform;
  const present = deps.present ?? onThisComputer;
  const pause = deps.pause ?? waitBetweenWindows;
  const refusal = wakeRefusal(deps.store, deps.owner, platform, present);
  if (refusal) return { heard: false, text: "", refusal, windowsTried: 0, windowsTooLong: 0 };
  if (deps.locked?.()) return { heard: false, text: "", refusal: lockedRefusal, windowsTried: 0, windowsTooLong: 0 };
  let windowsTried = 0, windowsTooLong = 0;
  /** The only copy of any sound this function ever holds; replaced, never added to, never written. */
  let held: Uint8Array | null = null;
  for await (const chunk of sound) {
    // mac7/wake-mic: asked again before every window rather than once at the start. Lockdown coming
    // on, or the switch going off, stops the listener within one window whoever turned it — the app,
    // the command line, or another window — and the microphone is let go of with it.
    const stop = wakeRefusal(deps.store, deps.owner, platform, present)
      ?? (deps.locked?.() ? lockedRefusal : null);
    if (stop) return { heard: false, text: "", refusal: stop, windowsTried, windowsTooLong };
    const { wake, spotter } = wakeParts(deps.store, deps.owner, platform, present);
    // More than the owner allowed to be held at once is dropped where it arrives, without being
    // looked at, so the promise on the card is kept however the sound is handed over.
    if (chunk.seconds > wake.windowSeconds) { windowsTooLong += 1; await pause(0); continue; }
    held = chunk.sound;
    windowsTried += 1;
    const answer = await askSpotter(deps.runner, spotter, wake.word, held, deps.whisper, signal);
    held = null; // thrown away before the next window, heard or not
    if (answer.heard) return { heard: true, text: answer.text, refusal: null, windowsTried, windowsTooLong };
    // Integration review: the turn is always handed back to the app, and a spotter that failed
    // rather than simply hearing nothing is waited out, so nothing here can ever spin.
    await pause(answer.ok ? 0 : wakeBackoffMs);
  }
  return { heard: false, text: "", refusal: null, windowsTried, windowsTooLong };
}

/* ---------- mac7/wake-mic: the listener the app owns ---------- */

/**
 * Records one window of sound and hands it back. Always a parameter, so every test hands in a fake
 * and no microphone is opened; the real one is in src/voice-wake-host.ts, and it keeps nothing.
 */
export type WakeCaptureRunner = (
  command: { file: string; args: readonly string[] }, windowSeconds: number, signal: AbortSignal,
) => Promise<Uint8Array>;

export interface WakeWordListener {
  /** Whether the listener is running this moment. The card reads this rather than guessing. */
  readonly listening: boolean;
  /** Start or stop, according to what the settings now say. Called whenever one of them changes. */
  refresh(): void;
  /** Stop listening and let go of the microphone. */
  stop(): Promise<void>;
}

export interface WakeWordDeps extends WakeListenerDeps {
  capture: WakeCaptureRunner;
  stream?: WakeStreamRunner;
  /**
   * What the spotter wrote out, once the word was in it. The caller starts an ordinary turn with
   * it — the same one a typed message starts, with the same permissions and the same questions.
   * Hearing the word grants nothing.
   */
  onHeard: (text: string) => void | Promise<void>;
}

export type WakeStreamRunner = (command: NonNullable<WakeSpotter["command"]>,
  onWord: (word: string) => void, signal: AbortSignal) => Promise<void>;

async function keepStreaming(deps: WakeWordDeps, controller: AbortController, spotter: WakeSpotter): Promise<void> {
  if (!spotter.command || !deps.stream) return;
  let last = 0, busy = false;
  const check = () => {
    try {
      if (deps.locked?.() || wakeRefusal(deps.store, deps.owner, deps.platform, deps.present)) controller.abort();
    } catch { controller.abort(); }
  };
  const ticker = setInterval(check, 500); ticker.unref?.();
  try {
    await deps.stream(spotter.command, (text) => {
      check();
      const wake = wakeWordSettings(deps.store, deps.owner);
      if (controller.signal.aborted || busy || Date.now() - last < wakeBackoffMs || !isTheWord(text.replace(/_/g, " "), wake.word)) return;
      last = Date.now(); busy = true;
      void Promise.resolve().then(() => {
        check(); if (!controller.signal.aborted) return deps.onHeard(wake.word);
      }).catch(() => undefined).finally(() => { busy = false; });
    }, controller.signal);
  } finally { clearInterval(ticker); }
}

/**
 * One window of sound at a time, for as long as the listener runs. Each window is recorded by a
 * program that ends when the window is up, so the microphone is held for the window and no longer,
 * and only one window is ever in memory. Where the spotter opens the microphone itself, no sound
 * reaches Branch at all and the window handed on is empty.
 */
async function* windowsOfSound(deps: WakeWordDeps, signal: AbortSignal): AsyncIterable<WakeChunk> {
  const platform = deps.platform ?? process.platform;
  while (!signal.aborted) {
    const { wake, capture } = wakeParts(deps.store, deps.owner, platform, deps.present ?? onThisComputer);
    if (capture.kind === "spotter-listens") { yield { sound: new Uint8Array(0), seconds: wake.windowSeconds }; continue; }
    if (!capture.command) return;
    // Integration review: a recorder can fail — the machine woke from sleep with the sound card
    // gone, a microphone was unplugged, the program is not there any more. That is one window lost,
    // waited out and tried again, rather than a failure thrown out of the loop with nobody to catch
    // it (which stopped the app) or a dead device asked again as fast as the loop could turn.
    let sound: Uint8Array | null;
    try { sound = await deps.capture(capture.command, wake.windowSeconds, signal); }
    catch { await (deps.pause ?? waitBetweenWindows)(wakeBackoffMs); continue; }
    if (signal.aborted) return;
    // Integration review (mac7/wake-mac): a window that carried no sound at all is not a window.
    // It is what a recorder gives back while macOS is still asking the owner whether Branch may use
    // the microphone, and what one gives back when the device is refused or gone: it ends at once
    // instead of running its window, so nothing paces the loop. Without this the blocked recorder
    // was started again as fast as the loop could turn — 174 times in a quarter of a second — and
    // the spotter was asked about silence each time. It is waited out and tried again, so the word
    // is heard the moment the owner says yes.
    if (sound.length === 0) { sound = null; await (deps.pause ?? waitBetweenWindows)(wakeBackoffMs); continue; }
    const window = { sound, seconds: wake.windowSeconds };
    sound = null; // the one copy is the one handed on; this binding lets go of it here
    yield window;
  }
}

/** Listens, again and again, starting an ordinary turn each time the word is heard. */
async function keepListening(deps: WakeWordDeps, controller: AbortController, done: () => void): Promise<void> {
  try {
    const { spotter } = wakeParts(deps.store, deps.owner, deps.platform, deps.present);
    if (spotter.kind === "streaming-keyword") { await keepStreaming(deps, controller, spotter); return; }
    while (!controller.signal.aborted) {
      const answer = await listenForWake(deps, windowsOfSound(deps, controller.signal), controller.signal);
      if (controller.signal.aborted || answer.refusal || !answer.heard) return;
      await deps.onHeard(answer.text);
      // Integration review: the one path that had no wait in it at all. Hearing the word returns
      // straight out of the loop above, so a spotter that keeps reporting the word — a stuck engine,
      // or the tail of the same sentence heard again — started turn after turn as fast as the loop
      // could turn, and on the computer whose spotter opens its own microphone that was pure
      // microtask work: no timer in the whole app ever ran again. Waiting here also stops the same
      // breath being heard twice.
      await (deps.pause ?? waitBetweenWindows)(wakeBackoffMs);
    }
  } finally { done(); }
}

/**
 * The listener the app owns. It runs only while the switch is on, a word is chosen, and this
 * computer can really listen; it stops when any of those stops being true — Lockdown coming on, the
 * owner turning the switch off, or the app closing — and lets go of the microphone when it does.
 */
export function startWakeWord(deps: WakeWordDeps): WakeWordListener {
  const platform = deps.platform ?? process.platform;
  const present = deps.present ?? onThisComputer;
  let running: AbortController | null = null;
  let loop: Promise<void> = Promise.resolve();
  let configuration = "";
  const listener: WakeWordListener = {
    get listening() { return running !== null; },
    refresh() {
      // Integration review: being locked is a state, not a single push. A settings save — the card,
      // a settings file, a preset — must not be a way back to the microphone on a locked Branch.
      if (deps.locked?.() || wakeRefusal(deps.store, deps.owner, platform, present)) { void listener.stop(); return; }
      const next = JSON.stringify(wakeParts(deps.store, deps.owner, platform, present));
      if (running && next !== configuration) { void listener.stop().then(() => listener.refresh()); return; }
      if (running) return;
      configuration = next;
      const controller = new AbortController();
      running = controller;
      // Every wait this listener makes ends when the listener does, so stopping is never held up.
      const paced: WakeWordDeps = { ...deps,
        pause: (ms) => waitOrStop(deps.pause ?? waitBetweenWindows, ms, controller.signal) };
      loop = keepListening(paced, controller, () => { if (running === controller) running = null; }).catch(() => undefined);
    },
    async stop() {
      const controller = running;
      running = null;
      controller?.abort();
      await loop.catch(() => undefined);
    },
  };
  listener.refresh();
  return listener;
}
