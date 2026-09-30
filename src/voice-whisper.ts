import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { cleanChildEnvironment } from "./child-env.js";

/**
 * RES-709: free speech-to-text on this computer, with nothing sent anywhere and nothing to pay.
 *
 * Branch runs faster-whisper (https://github.com/SYSTRAN/faster-whisper, MIT) that the owner already
 * installed, through a small worker kept running while it is used: the model is loaded once, so the
 * words of a held push-to-talk come back while the owner is still speaking. Branch adds no package of
 * its own and downloads nothing. It finds:
 *
 *   - the Python that has faster-whisper, in the folder `uv tool install faster-whisper-cli` or
 *     `pipx install faster-whisper-cli` made, or the Python the owner named under Settings → Voice;
 *   - a model already on this computer, in the Hugging Face cache faster-whisper itself fills.
 *
 * The worker is started with `HF_HUB_OFFLINE=1` and `local_files_only`, and handed the model's own
 * folder, so it cannot fetch anything even if it wanted to.
 */

/** The models Branch looks for, fastest first. An English-only model is skipped when another language is chosen. */
export const whisperModels = ["tiny.en", "base.en", "tiny", "base", "small.en", "small"] as const;

/** The uv and pipx folder names faster-whisper is installed under. */
const toolNames = ["faster-whisper-cli", "faster-whisper"];

export interface LocalWhisperFound {
  available: boolean;
  /** The Python to start, when available. */
  python: string | null;
  /** The model's own folder, when available. */
  model: string | null;
  /** The model's short name, such as base.en, for the card. */
  modelName: string | null;
  /** In the owner's words: what Branch would use, or what is missing and how to add it. */
  how: string;
}

/** Where the Hugging Face cache is, as faster-whisper's own library looks for it. */
export function hubFolders(env: NodeJS.ProcessEnv, home: string): string[] {
  const folders = [env.HF_HUB_CACHE, env.HF_HOME ? join(env.HF_HOME, "hub") : undefined, join(home, ".cache", "huggingface", "hub")];
  return [...new Set(folders.filter((folder): folder is string => !!folder))];
}

/** The Pythons faster-whisper's own installers put it next to, for this kind of computer. */
export function pythonCandidates(env: NodeJS.ProcessEnv, platform: string, home: string): string[] {
  const windows = platform === "win32";
  const python = windows ? join("Scripts", "python.exe") : join("bin", "python");
  const roots = windows
    ? [env.APPDATA ? join(env.APPDATA, "uv", "tools") : "", join(home, "pipx", "venvs"), join(home, ".local", "pipx", "venvs")]
    : [join(env.XDG_DATA_HOME || join(home, ".local", "share"), "uv", "tools"), join(home, ".local", "pipx", "venvs"),
      join(home, ".local", "share", "pipx", "venvs")];
  return roots.filter(Boolean).flatMap((root) => toolNames.map((name) => join(root, name, python)));
}

export interface WhisperLookup {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  home?: string;
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
}

/** The newest downloaded copy of one model in the cache, as its folder, or null. */
function cachedModel(hub: string, name: string, exists: (path: string) => boolean, read: (path: string) => string): string | null {
  const folder = join(hub, `models--Systran--faster-whisper-${name}`);
  let revision: string;
  try { revision = read(join(folder, "refs", "main")).trim(); } catch { return null; }
  if (!/^[0-9a-f]{7,64}$/.test(revision)) return null;
  const snapshot = join(folder, "snapshots", revision);
  return exists(join(snapshot, "model.bin")) ? snapshot : null;
}

/** The model to load: the owner's own folder, else the first of `whisperModels` already on this computer. */
export function findWhisperModel(named: string, language: string, lookup: Required<WhisperLookup>): { path: string; name: string } | null {
  if (named && isAbsolute(named)) return lookup.exists(join(named, "model.bin")) ? { path: named, name: basename(named) } : null;
  const english = !language || language.toLowerCase().startsWith("en");
  const wanted = named ? [named] : whisperModels.filter((name) => english || !name.endsWith(".en"));
  for (const hub of hubFolders(lookup.env, lookup.home))
    for (const name of wanted) {
      const path = cachedModel(hub, name, lookup.exists, lookup.read);
      if (path) return { path, name };
    }
  return null;
}

/** What the owner set under Settings → Voice that this reads. */
export interface WhisperChoice { localSpeechExecutable: string; localSpeechModel: string; localSpeechKind: string; language: string }

const missingPython =
  "Free speech on this computer needs faster-whisper. Install it once with `uv tool install faster-whisper-cli` (or `pipx install faster-whisper-cli`), then run `faster-whisper --model_size_or_path base.en` on any recording to fetch its model. Branch installs and downloads nothing itself.";
const missingModel =
  `faster-whisper is on this computer, but no speech model is. Run \`faster-whisper --model_size_or_path base.en\` on any recording once to fetch one; after that everything stays on this computer.`;

/** Whether free speech-to-text can run here, and with what. Looks at files only; nothing is started. */
export function findLocalWhisper(choice: WhisperChoice, given: WhisperLookup = {}): LocalWhisperFound {
  const lookup: Required<WhisperLookup> = {
    env: given.env ?? process.env, platform: given.platform ?? process.platform, home: given.home ?? homedir(),
    exists: given.exists ?? existsSync, read: given.read ?? ((path) => readFileSync(path, "utf8")),
  };
  const named = choice.localSpeechKind === "faster-whisper" && isAbsolute(choice.localSpeechExecutable) ? choice.localSpeechExecutable : "";
  const python = (named ? [named] : pythonCandidates(lookup.env, lookup.platform, lookup.home)).find((path) => lookup.exists(path));
  if (!python) return { available: false, python: null, model: null, modelName: null, how: missingPython };
  const model = findWhisperModel(choice.localSpeechKind === "faster-whisper" ? choice.localSpeechModel : "", choice.language, lookup);
  if (!model) return { available: false, python, model: null, modelName: null, how: missingModel };
  return { available: true, python, model: model.path, modelName: model.name,
    how: `faster-whisper with the ${model.name} model, on this computer. Nothing is sent anywhere and nothing is charged.` };
}

/* ---------- the worker ---------- */

/**
 * The worker, run as `python -X utf8 -u -c <this> <model folder>`. One JSON line in (the sound as base64,
 * in any format PyAV reads: WAV, WebM, Ogg), one JSON line out. It never writes a file.
 */
export const whisperWorkerScript = `
import base64, io, json, sys
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", local_files_only=True)
vad = False
try:
    from faster_whisper.vad import get_vad_model, get_speech_timestamps
    get_vad_model()  # installed package asset only; cached in this existing worker
    vad = True
except Exception:
    pass  # old/missing installed VAD keeps the existing non-neural path
print(json.dumps({"ready": True, "vad": "silero" if vad else "none"}), flush=True)
for line in sys.stdin:
    ask = {}
    try:
        ask = json.loads(line)
        sound = decode_audio(io.BytesIO(base64.b64decode(ask["audio"])), sampling_rate=16000)
        quick = bool(ask.get("partial"))
        if vad:
            speech = get_speech_timestamps(sound, min_silence_duration_ms=200, speech_pad_ms=400)
            if not speech:
                print(json.dumps({"id": ask.get("id"), "text": "", "language": ask.get("language")}), flush=True)
                continue
            # Apply speech spans before language detection, matching faster-whisper's VAD path.
            sound = np.concatenate([sound[segment["start"]:segment["end"]] for segment in speech])
        segments, info = model.transcribe(sound, language=ask.get("language") or None, beam_size=1 if quick else 5,
                                          condition_on_previous_text=False, vad_filter=False)
        text = " ".join(part.text.strip() for part in segments).strip()
        print(json.dumps({"id": ask.get("id"), "text": text, "language": info.language}), flush=True)
    except Exception as error:
        print(json.dumps({"id": ask.get("id"), "error": str(error)[:300]}), flush=True)
`;

/** The most sound one request may carry: ten minutes of 16 kHz WAV, or far more of anything compressed. */
export const whisperMostBytes = 20 * 1024 * 1024;
/** How long the worker is kept after its last use, so the model is not held in memory for nothing. */
export const whisperIdleMs = 120_000;
/** How long one request may take before the worker is ended. The first also loads the model. */
export const whisperRequestMs = 120_000;

export type WhisperSpawn = (python: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
const realSpawn: WhisperSpawn = (python, args, env) =>
  spawn(python, args, { env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });

/** The environment the worker gets: the usual clean one, offline, and nothing of Branch's own. */
export function whisperEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...cleanChildEnvironment(source), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1",
    PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" };
}

export interface WhisperHeard { text: string; language: string | null }
interface Pending { id: number; resolve: (heard: WhisperHeard) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/**
 * One worker, started on first use and ended after `whisperIdleMs` of quiet, when the engine closes, or when
 * the owner's choice of Python or model changes. One request runs at a time: a finished recording waits its
 * turn, and a live caption asked for while one is running is dropped rather than queued behind it.
 */
export class LocalWhisper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private running = "";
  private ready: Promise<void> | null = null;
  private pending: Pending | null = null;
  private turn: Promise<unknown> = Promise.resolve();
  private busy = false;
  private nextId = 1;
  private idle: NodeJS.Timeout | null = null;
  private vad: "silero" | "none" | null = null;
  private errors = "";
  private found: { at: number; key: string; value: LocalWhisperFound } | null = null;

  constructor(private readonly lookup: WhisperLookup = {}, private readonly start: WhisperSpawn = realSpawn,
    private readonly now: () => number = Date.now) {}

  /** What `findLocalWhisper` says, remembered for ten seconds so a screen that asks often reads no disk. */
  find(choice: WhisperChoice): LocalWhisperFound {
    const key = JSON.stringify(choice);
    if (this.found && this.found.key === key && this.now() - this.found.at < 10_000) return this.withVad(this.found.value);
    const value = findLocalWhisper(choice, this.lookup);
    this.found = { at: this.now(), key, value };
    return this.withVad(value);
  }
  private withVad(value: LocalWhisperFound): LocalWhisperFound {
    if (!value.available || !this.vad || this.running !== `${value.python}\n${value.model}`) return value;
    return { ...value, how: `${value.how} ${this.vad === "silero" ?
      "Installed Silero VAD filters live captions and finished recordings; speech and quiet are distinguished by the neural model." :
      "Neural VAD is unavailable in this installed environment; speech recognition continues without it."}` };
  }

  /** Whether a worker is running this moment. */
  get alive(): boolean { return this.child !== null; }

  /**
   * Writes one recording out. `partial` is a live caption: it is answered quickly, or not at all (null) when
   * the worker is still busy with the last one.
   */
  async transcribe(found: LocalWhisperFound, bytes: Uint8Array, options: { language?: string | null; partial?: boolean } = {}): Promise<WhisperHeard | null> {
    if (!found.available || !found.python || !found.model) throw new Error(found.how);
    if (bytes.byteLength === 0) throw new Error("That recording has no sound in it.");
    if (bytes.byteLength > whisperMostBytes) throw new Error("That recording is too long to write out here. Keep it under ten minutes.");
    if (options.partial && this.busy) return null;
    const mine = this.turn.then(() => this.ask(found, bytes, options));
    this.turn = mine.catch(() => undefined);
    return mine;
  }

  private async ask(found: LocalWhisperFound, bytes: Uint8Array, options: { language?: string | null; partial?: boolean }): Promise<WhisperHeard> {
    this.busy = true;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    try {
      await this.ensure(found.python!, found.model!);
      return await new Promise<WhisperHeard>((resolve, reject) => {
        const id = this.nextId++;
        const timer = setTimeout(() => this.fail(new Error("faster-whisper took more than two minutes, so Branch stopped it.")), whisperRequestMs);
        this.pending = { id, resolve, reject, timer };
        const line = JSON.stringify({ id, audio: Buffer.from(bytes).toString("base64"), language: options.language || null, partial: !!options.partial });
        this.child!.stdin.write(`${line}\n`);
      });
    } finally {
      this.busy = false;
      if (this.child) { this.idle = setTimeout(() => this.stop(), whisperIdleMs); this.idle.unref?.(); }
    }
  }

  /** Starts the worker for this Python and model, or keeps the one already running for them. */
  private ensure(python: string, model: string): Promise<void> {
    const key = `${python}\n${model}`;
    if (this.child && this.running === key && this.ready) return this.ready;
    this.stop();
    this.running = key;
    this.errors = "";
    const child = this.start(python, ["-X", "utf8", "-u", "-c", whisperWorkerScript, model], whisperEnvironment());
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      this.pending = { id: 0, resolve: () => resolve(), reject, timer: setTimeout(() => this.fail(new Error("faster-whisper did not start within two minutes.")), whisperRequestMs) };
    });
    let partial = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (this.child !== child) return;
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!.slice(-65_536);
      for (const line of lines) if (line.trim()) this.answer(line);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { this.errors = (this.errors + chunk).slice(-600); });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => this.fail(new Error(`Branch could not start faster-whisper: ${error.message}`), child));
    child.on("close", () => this.fail(new Error(this.stopped()), child));
    return this.ready;
  }

  /** Why the worker stopped, in words: the last thing Python said, which names a missing package or model. */
  private stopped(): string {
    const last = this.errors.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    return `faster-whisper stopped${last ? `: ${last.slice(0, 300)}` : ""}. Check it under Settings → Voice.`;
  }

  private answer(line: string): void {
    let said: { ready?: boolean; vad?: string; id?: number; text?: string; language?: string; error?: string };
    try { said = JSON.parse(line); } catch { return; }
    const pending = this.pending;
    if (!pending) return;
    if (said.ready && pending.id === 0) {
      this.vad = said.vad === "silero" ? "silero" : "none";
      this.settle(); pending.resolve({ text: "", language: null }); return;
    }
    if (said.id !== pending.id) return;
    this.settle();
    if (said.error) pending.reject(new Error(`faster-whisper could not write that out: ${said.error}`));
    else pending.resolve({ text: String(said.text ?? "").trim(), language: said.language ?? null });
  }

  private settle(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  /** Ends the worker and fails whatever was waiting on it. A worker that is not this one's is left alone. */
  private fail(error: Error, which: ChildProcessWithoutNullStreams | null = this.child): void {
    if (which !== this.child) return;
    const pending = this.pending;
    this.settle();
    this.stop();
    pending?.reject(error);
  }

  /** Ends the worker, failing anything still waiting on it; the next use starts a fresh one. */
  stop(): void {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const child = this.child, pending = this.pending;
    this.child = null;
    this.ready = null;
    this.running = "";
    this.vad = null;
    this.settle();
    if (child) { child.stdin.end(); child.kill(); }
    pending?.reject(new Error("faster-whisper was stopped before it finished."));
  }
}
