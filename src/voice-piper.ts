import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { cleanChildEnvironment } from "./child-env.js";
import { findOnPath, type SpeakRequest, type SpokenAudio } from "./voice-tts.js";

export interface PiperChoice { localVoiceExecutable: string; localVoiceModel: string }
export interface PiperFound { executable: string; model: string }

/** Only an already installed program and owner-supplied model; never fetch a voice. */
export function findPiper(choice: PiperChoice): PiperFound | null {
  const executable = choice.localVoiceExecutable || findOnPath("piper") || findOnPath("piper.exe");
  const model = choice.localVoiceModel || process.env.PIPER_VOICE || "";
  if (!executable || !isAbsolute(executable) || !isAbsolute(model) || !model.endsWith(".onnx")) return null;
  try {
    accessSync(executable, constants.X_OK);
    accessSync(model, constants.R_OK);
    accessSync(`${model}.json`, constants.R_OK);
    return { executable, model };
  } catch { return null; }
}

interface Pending { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }

/** Original CLI adapter. GPL Piper remains a separate installed program, not an imported library.
 * The documented stdin loop loads one voice once; each completed WAV is announced on stderr.
 * See OHF-Voice/piper1-gpl efffbfb226bfb511ebbcf55d0cecd8b35a89743d, __main__.py.
 */
export class LocalPiper {
  private child: ChildProcessWithoutNullStreams | undefined;
  private directory = "";
  private key = "";
  private output = "";
  private pending: Pending | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;

  speak(found: PiperFound, request: SpeakRequest, signal?: AbortSignal): Promise<SpokenAudio> {
    const epoch = this.epoch;
    const job = this.queue.then(async () => {
      if (signal?.aborted || epoch !== this.epoch) throw new Error("Reading aloud was stopped.");
      await this.start(found, request.speed, epoch);
      if (epoch !== this.epoch) throw new Error("Reading aloud was stopped.");
      const bytes = await this.write(request.text, signal);
      return { bytes, mediaType: "audio/wav", route: "piper" as const, voice: "piper",
        cost: { amount: 0, currency: "USD" as const, confidence: "free" as const,
          note: "this used an installed voice on your computer, so nothing was charged" } };
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  stop(): void { this.epoch++; this.reset(); }

  private reset(): void {
    if (this.idle) clearTimeout(this.idle);
    const child = this.child, directory = this.directory;
    this.child = undefined; this.directory = ""; this.key = ""; this.output = "";
    this.pending?.reject(new Error("The installed voice stopped reading aloud."));
    this.pending = undefined;
    if (child) this.terminateChild(child, directory);
  }

  private terminateChild(child: ChildProcessWithoutNullStreams, directory: string): void {
    // POSIX: send SIGTERM, then escalate to SIGKILL after grace period if needed.
    // Windows: skip escalation since SIGKILL is not available; process.kill() on Windows
    // always sends SIGKILL equivalent.
    child.kill("SIGTERM");

    // On POSIX, set a timer to escalate to SIGKILL if the process doesn't exit.
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        // Process is still alive; escalate to SIGKILL.
        child.kill("SIGKILL");
      }
    }, 2000);

    // Wait for process exit before removing its private output directory on Windows.
    const clean = () => {
      clearTimeout(escalate);
      void rm(directory, { recursive: true, force: true }).catch(() => undefined);
    };
    if (child.exitCode === null && child.signalCode === null) {
      child.once("close", clean);
    } else {
      clean();
    }
  }

  private async start(found: PiperFound, speed: number, epoch: number): Promise<void> {
    const key = JSON.stringify([found.executable, found.model, speed]);
    if (this.idle) clearTimeout(this.idle);
    if (this.child && this.key === key) return;
    this.reset();
    const directory = await mkdtemp(join(tmpdir(), "branch-piper-"));
    if (epoch !== this.epoch) { await rm(directory, { recursive: true, force: true }); return; }
    const child = spawn(found.executable, ["--model", found.model, "--output-dir", directory,
      "--output-dir-naming", "timestamp", "--length-scale", String(1 / speed)],
    { windowsHide: true, shell: false, stdio: "pipe", env: cleanChildEnvironment(process.env) });
    this.child = child; this.directory = directory; this.key = key;
    child.stdout.on("data", () => undefined);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.receive(child, chunk));
    child.once("error", () => { if (this.child === child) this.reset(); });
    child.once("close", () => { if (this.child === child) this.reset(); });
    child.stdin.on("error", () => { if (this.child === child) this.reset(); });
  }

  private write(text: string, signal?: AbortSignal): Promise<Uint8Array> {
    return new Promise((resolveBytes, reject) => {
      const child = this.child;
      if (!child || signal?.aborted) { this.reset(); reject(new Error("Reading aloud was stopped.")); return; }
      const abort = () => this.reset();
      const timer = setTimeout(abort, 120_000);
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending = {
        resolve: bytes => { done(); this.pending = undefined; this.idle = setTimeout(() => this.reset(), 120_000); resolveBytes(bytes); },
        reject: error => { done(); reject(error); },
      };
      signal?.addEventListener("abort", abort, { once: true });
      // Piper treats each stdin line as a request. Replies remain data, never arguments or shell code.
      child.stdin.write(`${text.replace(/[\r\n]+/g, " ")}\n`, "utf8");
    });
  }

  private receive(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.child !== child) return;
    this.output += chunk;
    if (this.output.length > 16_384) { this.reset(); return; }
    let end: number;
    while ((end = this.output.indexOf("\n")) >= 0) {
      const line = this.output.slice(0, end).trim();
      this.output = this.output.slice(end + 1);
      const written = /\bWrote (.+)$/.exec(line)?.[1];
      if (written && this.pending) void this.finish(child, written);
    }
  }

  private async finish(child: ChildProcessWithoutNullStreams, written: string): Promise<void> {
    const pending = this.pending, directory = this.directory;
    try {
      if (!pending || !/^\d+\.wav$/.test(basename(written))) throw new Error("Invalid voice output.");
      const path = join(directory, basename(written));
      if (resolve(written) !== resolve(path)) throw new Error("Invalid voice output.");
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024 || info.size < 44)
        throw new Error("Invalid voice output.");
      if (await realpath(path) !== join(await realpath(directory), basename(path))) throw new Error("Invalid voice output.");
      const bytes = await readFile(path);
      await rm(path, { force: true });
      if (this.child === child && this.pending === pending) pending.resolve(bytes);
    } catch { if (this.child === child && this.pending === pending) this.reset(); }
  }
}
