import { accessSync, constants } from "node:fs";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import type { NetworkPolicy } from "./network-policy.js";
import type { AudioProvider } from "./voice.js";
import { geminiAuth, runProgram, type AudioCostEstimate } from "./voice-stt.js";
import { pcmAsWav, soundType } from "./voice-note.js";

/**
 * Reading text aloud. Three routes: an OpenAI-shaped `/audio/speech`, Gemini's own speech route,
 * and the voice that comes with the computer, which needs no key, no account and no internet at all.
 * That last route is what makes "read this aloud" work on a computer that is offline. It keeps the
 * name "windows" because that is what saved settings say, but it means the system voice: Windows'
 * own voices, `say` on a Mac, and `espeak-ng` on Linux when it is installed.
 */
export type TtsRoute = "openai" | "gemini" | "windows" | "piper";

export interface SpokenAudio {
  bytes: Uint8Array;
  mediaType: string;
  /** Bucket 17: or `engine:<id>`, a speech plug-in (src/speech-engines.ts). */
  route: TtsRoute | `engine:${string}`;
  voice: string;
  cost: AudioCostEstimate;
}

/** The day the per-thousand-character prices below were read. */
export const speechPricedAt = "2026-09-16";
/** Published prices for reading aloud one thousand characters, in US dollars. */
export const ttsPricesPerThousand: Record<string, number> = {
  "tts-1": 0.015,
  "tts-1-hd": 0.03,
  "gpt-4o-mini-tts": 0.012,
};

/** What reading a piece of text aloud probably costs. An unlisted model reports no amount. */
export function estimateSpeechCost(model: string, characters: number, route: TtsRoute): AudioCostEstimate {
  if (route === "windows" || route === "piper")
    return { amount: 0, currency: "USD", confidence: "free", note: "this used a voice already on your computer, so nothing was charged" };
  const each = ttsPricesPerThousand[model] ?? ttsPricesPerThousand[model.toLowerCase()];
  if (each === undefined)
    return { amount: null, currency: "USD", confidence: "unknown", note: `no price on file for ${model}` };
  return {
    amount: Math.round((each * characters / 1000) * 1_000_000) / 1_000_000,
    currency: "USD", confidence: "table", note: `list price for ${model} as of ${speechPricedAt}`,
  };
}

export const SpeakRequestSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  voice: z.string().trim().max(80).default(""),
  /** How fast to speak: 1 is the usual pace. */
  speed: z.number().min(0.5).max(2).default(1),
  model: z.string().trim().max(200).optional(),
}).strict();
export type SpeakRequest = z.infer<typeof SpeakRequestSchema>;

/**
 * The PowerShell that asks Windows to read a sentence into a WAV file with a voice already on the
 * computer. Pure and exported so it can be read and checked without a single sound being played.
 *
 * Nothing a reply or a tool call can influence appears in this script at all. The words and the
 * voice name are read from files written beside it, and the sound file it writes is found from the
 * script's own folder, so a reply carrying a quote, a backtick or a $(...) is data that is read,
 * never text that is run. The only thing that varies is a whole number for the speaking rate.
 */
export function sapiScript(input: { rate: number; withVoice: boolean }): string {
  // Windows takes a speaking rate from -10 to 10; 0 is the usual pace.
  const rate = Math.max(-10, Math.min(10, Math.round((input.rate - 1) * 10)));
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$here = $PSScriptRoot",
    "$words = [System.IO.File]::ReadAllText((Join-Path $here 'speech.txt'), [System.Text.Encoding]::UTF8)",
    "$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$speech.Rate = ${rate}`,
    input.withVoice
      ? "$speech.SelectVoice([System.IO.File]::ReadAllText((Join-Path $here 'voice.txt'), [System.Text.Encoding]::UTF8).Trim())"
      : "",
    "$speech.SetOutputToWaveFile((Join-Path $here 'speech.wav'))",
    "$speech.Speak($words)",
    "$speech.Dispose()",
  ].filter(Boolean).join("\n");
}

/** The PowerShell that lists the voices installed on this computer, one name per line. */
export const sapiVoicesScript =
  "$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName System.Speech\n" +
  "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | " +
  "ForEach-Object { $_.VoiceInfo.Name }";

/** How PowerShell is started: no profile, no questions, no console window, and a file, not a line. */
export function powershellArgs(scriptPath: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
}

/** Where the system voice comes from on this computer, found once per request. */
export interface SystemVoiceProgram { kind: "say" | "espeak-ng"; executable: string }
export type ProgramLocator = (name: string) => string | null;

/** The average speaking pace both `say` and `espeak-ng` use, in words a minute. */
const usualWordsPerMinute = 175;
const wordsPerMinute = (speed: number): number => Math.round(usualWordsPerMinute * Math.max(0.5, Math.min(2, speed)));

/**
 * Which program reads aloud on a Mac or on Linux, or a plain sentence saying there is none. Linux's
 * `spd-say` is only ever mentioned: it speaks through the loudspeaker and cannot write a sound file,
 * and reading aloud here always hands back the sound itself.
 */
export function systemVoiceProgram(platform: string, locate: ProgramLocator): SystemVoiceProgram | string {
  if (platform === "darwin") {
    const say = locate("say");
    return say ? { kind: "say", executable: say } : "This Mac has no say command, so its voice cannot be used. Choose a provider voice under Settings → Voice.";
  }
  if (platform === "linux") {
    const espeak = locate("espeak-ng");
    if (espeak) return { kind: "espeak-ng", executable: espeak };
    if (locate("spd-say"))
      return "This computer has spd-say, which can only speak through the loudspeaker and cannot make a sound Branch can hand back. Install espeak-ng to read aloud here, or choose a provider voice under Settings → Voice.";
  }
  return "There is no system voice on this computer. Install espeak-ng (on Linux), or choose a provider voice under Settings → Voice.";
}

/**
 * The words a system voice is started with. The text is always read from a file (`-f`), so a reply
 * that begins with a dash is words, never an option, and the sound is always written to a WAV file.
 */
export function systemVoiceArgs(kind: SystemVoiceProgram["kind"], input: { textPath: string; outPath: string; voice: string; speed: number }): string[] {
  const voice = input.voice ? ["-v", input.voice] : [];
  const rate = String(wordsPerMinute(input.speed));
  if (kind === "say")
    return ["--file-format=WAVE", "--data-format=LEI16@22050", "-o", input.outPath, "-r", rate, ...voice, "-f", input.textPath];
  return ["-w", input.outPath, "-s", rate, ...voice, "-f", input.textPath];
}

/** A voice name that can only ever be a name: no leading dash, no control characters. */
export const safeVoiceName = (voice: string): boolean => !voice.startsWith("-") && !/[\u0000-\u001f\u007f]/.test(voice);

/**
 * The names from `say -v '?'`, one voice a line: the name, then its language, then a sample after
 * `#`. Names can have spaces and brackets in them ("Eddy (English (UK))"), so the language is what
 * the name is cut at.
 */
export function parseSayVoices(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?)\s+[a-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})+\s+#/.exec(line);
    if (match) names.push(match[1]!.trim());
  }
  return [...new Set(names)].slice(0, 200);
}

/** The voice names from `espeak-ng --voices`: a heading line, then one voice a line in columns. */
export function parseEspeakVoices(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/).slice(1)) {
    const columns = line.trim().split(/\s+/);
    // Pty, Language, Age/Gender, VoiceName, File, Other languages
    if (columns.length >= 5 && /^\d+$/.test(columns[0]!)) names.push(columns[3]!);
  }
  return [...new Set(names)].slice(0, 200);
}

/** Finds a program on this computer's search path, without starting anything. */
export function findOnPath(name: string): string | null {
  for (const folder of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(folder, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/** The one place text is turned into sound, whichever route does the work. */
export class Speech {
  constructor(
    private readonly policy: NetworkPolicy,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
    /** Runs PowerShell; replaced in tests so no sound is ever produced on the owner's computer. */
    private readonly runShell: (file: string, args: string[], signal?: AbortSignal) => Promise<string> = runProgram,
    /** Which computer this is and how programs are found on it; replaced in tests. */
    private readonly system: { platform?: string; locate?: ProgramLocator } = {},
  ) {}
  private get platform(): string { return this.system.platform ?? process.platform; }
  private get locate(): ProgramLocator { return this.system.locate ?? findOnPath; }

  /**
   * Reads text aloud into sound bytes. `keepOnThisComputer` refuses both cloud routes in plain
   * words, so a tool call cannot quietly send the words away after the owner said not to. `voiceNote` asks a route that
   * can make OGG/Opus to make it (UP-CHAT-005), so a chat app shows a voice bubble without converting anything.
   */
  async speak(
    request: SpeakRequest,
    route: { kind: TtsRoute; provider?: AudioProvider | null },
    options: { keepOnThisComputer?: boolean; signal?: AbortSignal; voiceNote?: boolean } = {},
  ): Promise<SpokenAudio> {
    if (route.kind === "piper") throw new Error("The installed Piper voice is handled by the owner's voice service.");
    if (options.keepOnThisComputer && route.kind !== "windows")
      throw new Error(
        "You asked for audio to stay on this computer, so nothing was sent away. Choose the voice that comes with your computer under Settings → Voice, or turn that setting off.",
      );
    if (route.kind === "windows")
      return this.platform === "win32" ? this.windows(request, options.signal) : this.systemVoice(request, options.signal);
    if (route.kind === "gemini") return this.gemini(request, route.provider ?? null, options.signal);
    return this.openai(request, route.provider ?? null, options.signal, options.voiceNote === true);
  }

  private async openai(request: SpeakRequest, provider: AudioProvider | null, signal?: AbortSignal, opus = false): Promise<SpokenAudio> {
    if (!provider) throw new Error("Reading aloud through your provider needs a connection that offers it. Add one under Settings → Models.");
    const model = request.model || "tts-1";
    const voice = request.voice || "alloy";
    const url = await this.allowed(provider.endpoint, "/audio/speech");
    const response = await this.fetch(url, {
      method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
      // Hermes Agent tools/tts_tool.py asks for Opus the same way; the reply is then OGG-contained Opus.
      body: JSON.stringify({ model, input: request.text, voice, speed: request.speed, ...(opus ? { response_format: "opus" } : {}) }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await failure(response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, mediaType: soundType(bytes, "audio/mpeg"), route: "openai", voice,
      cost: estimateSpeechCost(model, request.text.length, "openai") };
  }

  /** Gemini answers with the sound inline, base64, inside its ordinary generateContent reply. */
  private async gemini(request: SpeakRequest, provider: AudioProvider | null, signal?: AbortSignal): Promise<SpokenAudio> {
    if (!provider) throw new Error("Reading aloud through your provider needs a connection that offers it. Add one under Settings → Models.");
    const model = request.model || "gemini-2.5-flash-preview-tts";
    const voice = request.voice || "Kore";
    const url = await this.allowed(provider.endpoint, `/v1beta/models/${model}:generateContent`);
    const response = await this.fetch(url, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", ...geminiAuth(provider) },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: request.text }] }],
        generationConfig: { responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await failure(response);
    const parsed = geminiSpeech.parse(await response.json());
    const part = (parsed.candidates[0]?.content?.parts ?? []).find((entry) => entry.inlineData?.data);
    if (!part?.inlineData?.data) throw new Error("The speech service answered without any sound in it");
    // UP-CHAT-005: Gemini's sound is raw PCM; with a WAV header around it, it plays in the window and in chat apps.
    const sound = pcmAsWav(new Uint8Array(Buffer.from(part.inlineData.data, "base64")), part.inlineData.mimeType);
    return { bytes: sound.bytes, mediaType: sound.mediaType, route: "gemini", voice,
      cost: estimateSpeechCost(model, request.text.length, "gemini") };
  }

  /** A voice that comes with Windows. Nothing leaves the computer and nothing is charged. */
  private async windows(request: SpeakRequest, signal?: AbortSignal): Promise<SpokenAudio> {
    const folder = await mkdtemp(join(tmpdir(), "branch-voice-"));
    const wav = join(folder, "speech.wav"), script = join(folder, "speak.ps1");
    try {
      // The words and the voice name go in beside the script as data files, never inside it.
      await writeFile(join(folder, "speech.txt"), request.text, { encoding: "utf8", mode: 0o600 });
      if (request.voice) await writeFile(join(folder, "voice.txt"), request.voice, { encoding: "utf8", mode: 0o600 });
      await writeFile(script, sapiScript({ rate: request.speed, withVoice: !!request.voice }), { mode: 0o600 });
      await this.runShell("powershell.exe", powershellArgs(script), signal);
      const bytes = await readFile(wav);
      if (!bytes.length) throw new Error("Windows produced no sound; check that a voice is installed under Windows speech settings.");
      return { bytes: new Uint8Array(bytes), mediaType: "audio/wav", route: "windows", voice: request.voice || "the Windows voice",
        cost: estimateSpeechCost("windows", request.text.length, "windows") };
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * The Mac's or Linux's own voice. Like the Windows route, the words go in as a file beside the
   * sound, the program is started directly with a list of arguments, and the folder is removed after.
   */
  private async systemVoice(request: SpeakRequest, signal?: AbortSignal): Promise<SpokenAudio> {
    const program = systemVoiceProgram(this.platform, this.locate);
    if (typeof program === "string") throw new Error(program);
    if (request.voice && !safeVoiceName(request.voice)) throw new Error(`"${request.voice.slice(0, 40)}" is not the name of a voice.`);
    const folder = await mkdtemp(join(tmpdir(), "branch-voice-"));
    const textPath = join(folder, "speech.txt"), outPath = join(folder, "speech.wav");
    try {
      await writeFile(textPath, request.text, { encoding: "utf8", mode: 0o600 });
      await this.runShell(program.executable, systemVoiceArgs(program.kind, { textPath, outPath, voice: request.voice, speed: request.speed }), signal);
      const bytes = await readFile(outPath).catch(() => Buffer.alloc(0));
      if (!bytes.length) throw new Error(`${program.kind} produced no sound; check that the voice you chose is installed.`);
      return { bytes: new Uint8Array(bytes), mediaType: "audio/wav", route: "windows", voice: request.voice || "this computer's voice",
        cost: estimateSpeechCost("system", request.text.length, "windows") };
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The voices on a Mac (`say -v ?`) or on Linux (`espeak-ng --voices`). Empty when there is no system voice. */
  private async systemVoices(): Promise<string[]> {
    const program = systemVoiceProgram(this.platform, this.locate);
    if (typeof program === "string") return [];
    try {
      if (program.kind === "say") return parseSayVoices(await this.runShell(program.executable, ["-v", "?"]));
      return parseEspeakVoices(await this.runShell(program.executable, ["--voices"]));
    } catch { return []; }
  }

  /**
   * The voices installed on this computer, for the list in Settings → Voice. The name is kept for the
   * settings route that asks for it; off Windows it lists the Mac's or Linux's own voices.
   */
  async windowsVoices(): Promise<string[]> {
    if (this.platform !== "win32") return this.systemVoices();
    const folder = await mkdtemp(join(tmpdir(), "branch-voice-"));
    const script = join(folder, "voices.ps1");
    try {
      await writeFile(script, sapiVoicesScript, { mode: 0o600 });
      const out = await this.runShell("powershell.exe", powershellArgs(script));
      return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 40);
    } catch { return []; } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async allowed(endpoint: string, path: string): Promise<string> {
    const url = new URL(endpoint.replace(/\/$/, "") + path);
    try {
      await this.policy.assertAllowed(url, "reading aloud");
    } catch (error) {
      throw new Error(`Cannot reach the voice service: ${error instanceof Error ? error.message : String(error)}`);
    }
    return url.href;
  }
}

const geminiSpeech = z.object({
  candidates: z.array(z.object({
    content: z.object({
      parts: z.array(z.object({ inlineData: z.object({ mimeType: z.string().optional(), data: z.string() }).optional() }).loose()).default([]),
    }).optional(),
  })).default([]),
}).loose();

async function failure(response: Response): Promise<Error> {
  const detail = await response.text().catch(() => response.statusText);
  return new Error(`Reading aloud failed: ${response.status} ${detail.slice(0, 300)}`);
}
