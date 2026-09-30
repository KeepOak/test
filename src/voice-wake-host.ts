import { spawn } from "node:child_process";
// mac7/live-voice: the discipline for starting one of these — the full path looked up here, none of
// this computer's environment, and ending it for good if it will not go — is shared with live
// dictation now and lives in src/mic-capture.ts. Nothing about what runs here changed with the move.
import { endChild, located, windowBytes } from "./mic-capture.js";
import type { WakeCaptureRunner, WakeRunner, WakeStreamRunner } from "./voice-wake.js";

/**
 * mac7/wake-mic: the real programs the wake word runs on this computer, and the only place in
 * Branch that opens a microphone. Nothing here starts by itself: each runner is called by the
 * listener in src/voice-wake.ts, which runs only while the switch is on, a word is chosen, and this
 * computer can really listen. Both runners are handed to the listener as parameters, so every test
 * hands in a fake instead and no microphone is ever opened by the tests.
 *
 * Neither writes a file, neither reads this computer's own environment, and neither keeps anything:
 * the recorder's sound goes straight to the listener, which drops it as soon as the spotter has
 * been asked about it.
 */

/**
 * Records one window of sound to memory. The recorder writes to standard output — no file name is
 * ever an argument — and it is ended as soon as one window's worth of bytes has arrived, so a
 * recorder that would keep going cannot hold more than the owner allowed. The microphone is let go
 * of when this returns, because the program that had it has ended.
 */
export function wakeCaptureRunner(): WakeCaptureRunner {
  return (command, windowSeconds, signal) => new Promise((settle, fail) => {
    // mac7/wake-mac: a Mac used to be refused here, because macOS ships no recorder. It now runs the
    // one the owner installed themselves, like every other system: which program that is, and
    // whether there is one at all, is decided in src/voice-wake.ts and nothing is run without it.
    const most = windowBytes(windowSeconds);
    const child = spawn(located(command.file), [...command.args], { stdio: ["ignore", "pipe", "ignore"], env: {} });
    const pieces: Uint8Array[] = [];
    let held = 0, finished = false;
    const done = (answer: Uint8Array | Error) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      endChild(child);
      if (answer instanceof Error) fail(answer); else settle(answer);
    };
    const abort = () => done(new Uint8Array(0));
    signal.addEventListener("abort", abort, { once: true });
    const stopper = setTimeout(() => done(Buffer.concat(pieces)), (windowSeconds + 1) * 1000);
    stopper.unref();
    child.stdout.on("data", (piece: Buffer) => {
      // Integration review: once the window is answered, what the program is still writing on its
      // way out is dropped where it arrives rather than piling up behind an answer already given.
      if (finished) return;
      pieces.push(piece);
      held += piece.length;
      if (held >= most) { clearTimeout(stopper); done(Buffer.concat(pieces).subarray(0, most)); }
    });
    child.on("error", (error) => { clearTimeout(stopper); done(error); });
    child.on("close", () => { clearTimeout(stopper); done(Buffer.concat(pieces).subarray(0, most)); });
  });
}

/**
 * Runs the spotter over one window of sound. The sound goes in on standard input, never to a file,
 * and the program is given only the environment the spotter built — never this computer's own.
 */
export function wakeRunner(): WakeRunner {
  return (file, args, input, env) => new Promise((settle) => {
    const child = spawn(located(file), [...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...env } });
    let stdout = "", stderr = "";
    const answer = (code: number) => settle({ code, stdout, stderr });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Only ever a few words come back; a spotter that would say more is cut off rather than held.
    child.stdout.on("data", (piece: string) => { stdout = (stdout + piece).slice(0, 4000); });
    child.stderr.on("data", (piece: string) => { stderr = (stderr + piece).slice(0, 4000); });
    child.on("error", (error) => { stderr = error.message; answer(1); });
    child.on("close", (code) => answer(code ?? 1));
    child.stdin.on("error", () => undefined);
    if (input.length > 0) child.stdin.write(input);
    child.stdin.end();
  });
}

/** Run the owner's installed Apache-2.0 sherpa KWS microphone CLI once per enabled session.
 * Its Display emits numbered JSON to stderr, sometimes wrapped across terminal lines. */
export function wakeStreamRunner(): WakeStreamRunner {
  return (command, onWord, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { resolve(); return; }
    const child = spawn(located(command.file), command.args, {
      stdio: ["ignore", "ignore", "pipe"], env: {}, windowsHide: true, shell: false,
    });
    let pending = "", finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; signal.removeEventListener("abort", abort); endChild(child);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish();
    signal.addEventListener("abort", abort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (piece: string) => {
      if (finished) return;
      pending = (pending + piece).replace(/\x1b\[[0-9;?]*[A-Za-z]|[\r\n]/g, "").slice(-4000);
      let end: number;
      while ((end = pending.indexOf("}")) >= 0) {
        const start = pending.indexOf("{");
        const json = start >= 0 && start <= end ? pending.slice(start, end + 1) : "";
        pending = pending.slice(end + 1);
        try {
          const value: unknown = JSON.parse(json);
          const word = (value as { keyword?: unknown })?.keyword;
          if (typeof word === "string" && word.length <= 100) onWord(word);
        } catch { /* configuration and device diagnostics never become a wake event */ }
      }
    });
    child.stderr.on("error", (error) => finish(error));
    child.on("error", (error) => finish(error));
    child.on("close", () => finish());
  });
}
