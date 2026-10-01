import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { isAbsolute } from "node:path";
import { findOnPath } from "./voice-tts.js";

/**
 * mac7/live-voice: the microphone, on its own, away from anything that uses it.
 *
 * Everything here was written for the word that starts a turn (mac7/wake-mic, mac7/wake-mac) and
 * lived inside it. It is here now because a second thing needs exactly the same sound — sixteen
 * thousand samples a second, two bytes each, one channel, from a recording program the owner
 * already has — and wants it held open rather than taken one window at a time. The two are the same
 * table of programs and the same discipline for starting one, with two ways of ending it, so this
 * file owns both and neither feature owns the other.
 *
 * What is true of every program started here, whichever uses it:
 *
 *   • it is given **none** of this computer's own environment, so nothing of the owner's can leak
 *     into it, and its full path is looked up here rather than left to a PATH it does not have;
 *   • it is given its arguments one at a time, never a line for a shell to read;
 *   • **no file name is ever an argument**: the sound goes to standard output and nowhere else;
 *   • its own error output is ignored rather than read, so nothing it prints is ever kept;
 *   • it is asked to stop, and ended for good two seconds later if it will not go.
 */

/** Sixteen thousand samples a second, two bytes each, one channel: what every recorder is asked for. */
export const micSampleRate = 16000;

/** How many bytes one second of that sound is. Used to cap what is ever held, and to time it. */
export const bytesPerSecond = micSampleRate * 2;

/** The most bytes one window may ever be, so a recorder that will not stop is stopped by the count. */
export const windowBytes = (windowSeconds: number): number => bytesPerSecond * windowSeconds + 4096;

/** How long a program is given past its window, or past being asked to stop, before it is ended anyway. */
export const graceMs = 2000;

/** A program and the arguments it is given. Never a shell line, and never a file name. */
export interface RecorderCommand { file: string; args: string[] }

/**
 * Whether a program is on this computer, asked without running it. Always passed in, so a test
 * decides the answer and the result never depends on what happens to be installed on the machine
 * running the tests.
 */
export type ProgramPresent = (name: string) => boolean;

/** The real answer on this computer: a look at the search path, which starts nothing. */
export const onThisComputer: ProgramPresent = (name) => findOnPath(name) !== null;

/**
 * What shape the sound comes back in. A window is a whole small recording, so it carries a WAV
 * header and the spotter reads it as a file would be read. A stream has no end to write a length
 * into, so it is the samples themselves and nothing else — which is also what counting how loud a
 * room is wants, and what a recogniser reading standard input expects.
 */
export type SoundShape = "window" | "stream";

/**
 * How long to record, in seconds, or null to keep going until the program is ended. Every recorder
 * below is also ended by a count of bytes or by Branch ending it, so a program that ignores its own
 * length flag still cannot hold the microphone for longer than it was given.
 */
export type RecordFor = number | null;

const alsaRecorder = (seconds: RecordFor, shape: SoundShape): RecorderCommand => ({
  file: "arecord",
  // `-d` ends it on its own after the window; the count of bytes ends it too, so a recorder that
  // ignores the flag still cannot hold more than it was given. Writing to "-" is standard output.
  args: ["-q", "-f", "S16_LE", "-r", String(micSampleRate), "-c", "1", "-t", shape === "window" ? "wav" : "raw",
    ...(seconds === null ? [] : ["-d", String(seconds)]), "-"],
});

// parecord has no length of its own, so this one is ended by the count of bytes alone rather than
// by a flag guessed at. Writing to "-" is standard output; no file name is ever an argument.
const pulseRecorder = (shape: SoundShape): RecorderCommand => ({
  file: "parecord",
  args: [...(shape === "window" ? ["--file-format=wav"] : ["--raw"]),
    `--rate=${micSampleRate}`, "--channels=1", "--format=s16le", "-"],
});

/**
 * mac7/wake-mac: sox, which the owner installed themselves. `rec` is sox with the microphone
 * already chosen; where only `sox` is here, `-d` is what chooses it, and the two are otherwise the
 * same command. `trim 0 <window>` ends it after one window, and the count of bytes ends it too, so
 * a build that ignored the effect still could not hold more than the owner allowed.
 */
const soxRecorder = (file: string, seconds: RecordFor, shape: SoundShape): RecorderCommand => ({
  file,
  // Writing to "-" is standard output; no file name is ever an argument, and the word never is.
  args: [
    ...(file === "sox" ? ["-d"] : []),
    "-q", "-c", "1", "-r", String(micSampleRate), "-b", "16", "-e", "signed-integer",
    "-t", shape === "window" ? "wav" : "raw", "-",
    ...(seconds === null ? [] : ["trim", "0", String(seconds)]),
  ],
});

/**
 * mac7/wake-mac: ffmpeg, also the owner's own, for a Mac that has it and not sox. The microphone
 * macOS calls the default one, straight to standard output and no further.
 */
const ffmpegRecorder = (seconds: RecordFor, shape: SoundShape): RecorderCommand => ({
  file: "ffmpeg",
  args: [
    "-hide_banner", "-loglevel", "quiet", "-nostdin", "-f", "avfoundation", "-i", ":default",
    ...(seconds === null ? [] : ["-t", String(seconds)]),
    "-ac", "1", "-ar", String(micSampleRate), "-c:a", "pcm_s16le",
    "-f", shape === "window" ? "wav" : "s16le", "-",
  ],
});

/** The recording programs a Mac is looked at for, best first. None is ever installed or bundled. */
export const macRecorders = ["rec", "sox", "ffmpeg"] as const;
/** The recording programs Linux is looked at for, best first. Neither is assumed to be there. */
export const linuxRecorders = ["arecord", "parecord"] as const;

/**
 * The recorder this computer would really use, or null when it has none. macOS ships no recorder a
 * program can ask for sound, so a Mac is looked at for one the owner installed themselves; Linux is
 * looked up on the search path too, and neither of its recorders is assumed to be there. Windows
 * ships none at all and is not looked at: what listens there opens the microphone for itself.
 */
export function recorderFor(
  platform: string, present: ProgramPresent, seconds: RecordFor, shape: SoundShape,
): RecorderCommand | null {
  if (platform === "darwin") {
    const file = macRecorders.find((name) => present(name));
    return !file ? null : file === "ffmpeg" ? ffmpegRecorder(seconds, shape) : soxRecorder(file, seconds, shape);
  }
  if (platform !== "linux") return null;
  if (present("arecord")) return alsaRecorder(seconds, shape);
  return present("parecord") ? pulseRecorder(shape) : null;
}

/** The name of the recorder this computer would use, for the sentence a person reads. */
export function recorderName(platform: string, present: ProgramPresent): string | null {
  const names = platform === "darwin" ? macRecorders : platform === "linux" ? linuxRecorders : [];
  return names.find((name) => present(name)) ?? null;
}

/* ---------- starting one, and ending it ---------- */

/**
 * Where a program really is. Neither of these is given this computer's own environment — a program
 * that inherited it could carry the owner's own things into itself — and without a PATH nothing
 * would be found, so the looking up is done here, in Branch, and the full path is what is run.
 */
export const located = (file: string): string => (isAbsolute(file) ? file : findOnPath(file) ?? file);

/** A program started here: words or sound out, sound in, and nothing read from its error output. */
export type SpawnedProgram = ChildProcessByStdio<Writable, Readable, null>;

/** Ends a program and, if it will not go, ends it for good. */
export function endChild(child: Pick<ChildProcess, "exitCode" | "signalCode" | "kill">): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, graceMs).unref();
}

/**
 * Starts a program that writes sound, or words, to its standard output. Standard input is open so
 * sound can be handed to a recogniser on it; a recorder is given nothing on it and never reads it.
 * Its error output is thrown away where it is written rather than read into Branch.
 */
export function startQuietly(command: RecorderCommand): SpawnedProgram {
  return spawn(located(command.file), [...command.args], { stdio: ["pipe", "pipe", "ignore"], env: {} });
}

/** The same start, but the error output is kept open for the one program that writes its words there. */
export function startKeepingErrors(command: RecorderCommand): ChildProcessByStdio<Writable, Readable, Readable> {
  return spawn(located(command.file), [...command.args], { stdio: ["pipe", "pipe", "pipe"], env: {} });
}
