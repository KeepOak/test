import { endChild, startKeepingErrors, startQuietly, windowBytes } from "./mic-capture.js";
import { mostWords } from "./voice-dictation.js";
import type { SoundStreamRunner, SpeechStreamRunner } from "./voice-dictation-run.js";
import { StreamWords } from "./voice-stream-words.js";

/**
 * mac7/live-voice: the real programs live dictation runs on this computer, and — beside the word
 * that starts a turn in src/voice-wake-host.ts — the only other place in Branch that opens a
 * microphone. Nothing here starts by itself: both runners are called by the listener in
 * src/voice-dictation-run.ts, which runs only after a press, while the switch is on, Branch is
 * unlocked and Lockdown is off. Both are handed to that listener as parameters, so every test hands
 * in a fake instead and no microphone is ever opened by the tests.
 *
 * Neither writes a file, neither is given this computer's own environment, and neither keeps
 * anything. The sound goes straight through and the words go straight to the screen.
 */

/**
 * Starts the speech program. It writes words to its standard output as it hears them, and those go
 * to the screen and nowhere else; what it writes to its error output is thrown away where it is
 * written rather than read into Branch. **No file name is ever an argument.**
 */
export function speechStreamRunner(): SpeechStreamRunner {
  return (command, onWords, onEnded) => {
    // This upstream microphone example writes numbered final segments to stderr alongside diagnostics.
    const segmented = command.file.includes("sherpa-onnx-vad-microphone-offline-asr");
    const child = segmented ? startKeepingErrors(command) : startQuietly(command);
    const words = new StreamWords(onWords);
    let done = false;
    const finish = (why: string | null) => { if (done) return; done = true; words.finish(); endChild(child); onEnded(why); };
    child.stdout.setEncoding("utf8");
    // Words are handed on where they arrive and never held: nothing here accumulates, and a
    // program that will not stop writing is cut off by the cap rather than piling up in memory.
    child.stdout.on("data", (piece: string) => { if (!done) words.write(piece); });
    if (segmented) segmentOutput(child as ReturnType<typeof startKeepingErrors>, onWords, () => done);
    child.on("error", (error) => finish(error.message));
    child.on("close", () => finish(null));
    child.stdin.on("error", () => undefined); // a program that has gone is not an unhandled failure
    // merge-queue review: a broken output pipe ends dictation in words instead of crashing Branch.
    child.stdout.on("error", (error) => finish(error.message));
    return {
      hear(sound) {
        if (done || !child.stdin.writable) return false;
        // Integration review: `write` says false when the program is not keeping up. That answer is
        // passed straight back so the caller drops the piece; nothing is queued behind a slow or
        // dying program, which is the one way this could have piled up sound.
        return child.stdin.write(sound);
      },
      stop() { finish(null); },
    };
  };
}

function segmentOutput(
  child: ReturnType<typeof startKeepingErrors>, onWords: (text: string, final: boolean) => void, done: () => boolean,
): void {
  let pending = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (piece: string) => {
    if (done()) return;
    const lines = (pending + piece).split("\n");
    pending = (lines.pop() ?? "").slice(-mostWords);
    for (const line of lines) {
      const text = /^\s*\d+:\s*(.+)$/.exec(line)?.[1];
      if (text) onWords(text.slice(0, mostWords), true);
    }
  });
}

/**
 * Holds one recorder open for as long as dictation is listening — the thing the word that starts a
 * turn never does — and ends it the moment it is stopped, which is what lets go of the microphone.
 * The recorder writes the samples to its standard output; no file name is ever an argument.
 */
export function soundStreamRunner(): SoundStreamRunner {
  return (command, onSound, onEnded) => {
    const child = startQuietly(command);
    let done = false, held = 0;
    /** The most sound one stretch of dictation may ever carry, so a recorder that will not stop is. */
    const most = windowBytes(60 * 60);
    const finish = (why: string | null) => { if (done) return; done = true; endChild(child); onEnded(why); };
    child.stdout.on("data", (piece: Buffer) => {
      if (done) return;
      held += piece.length;
      if (held > most) { finish("the recorder ran for longer than an hour and was ended"); return; }
      onSound(new Uint8Array(piece));
    });
    child.on("error", (error) => finish(error.message));
    child.on("close", () => finish(null));
    // merge-queue review: an unguarded stream error would be an unhandled 'error' event.
    child.stdout.on("error", (error) => finish(error.message));
    child.stdin.on("error", () => undefined);
    child.stdin.end(); // a recorder is given nothing on its standard input and never reads it
    return { stop() { finish(null); } };
  };
}
