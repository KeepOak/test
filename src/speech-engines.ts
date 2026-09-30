import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Store } from "./store.js";
import { shippedUnlessChosen } from "./ship-on.js";
import { runProgram, type AudioClip, type TranscriptionResult } from "./voice-stt.js";
import type { SpokenAudio } from "./voice-tts.js";
import type { ProgramRunner } from "./media-programs.js";

/**
 * Bucket 17: speech as plug-ins. Every service that can write speech out or read words aloud is an
 * engine that registers itself here — Deepgram, ElevenLabs, Azure and "a program on this computer"
 * come built in, and anything else (a plug-in, a test) can add its own with `register`. Spoken
 * commands ("stop", "say that again") are the second half: intents that register the same way.
 * The owner picks an engine under Settings → Voice; until then, and while the switch is off, the
 * ordinary voice routes in src/voice-service.ts do the work exactly as before.
 */
export const SpeechEngineSettingsSchema = z.object({
  mode: FeatureModeSchema.default("off"),
  /** The engine that writes speech out; empty means the ordinary voice route. */
  listen: z.string().trim().max(40).default(""),
  /** The engine that reads words aloud; empty means the ordinary voice route. */
  speak: z.string().trim().max(40).default(""),
  /** The names of the secrets (in the default project) that hold each service's key. */
  secrets: z.object({
    deepgram: z.string().trim().max(100).default("DEEPGRAM_API_KEY"),
    elevenlabs: z.string().trim().max(100).default("ELEVENLABS_API_KEY"),
    azure: z.string().trim().max(100).default("AZURE_SPEECH_KEY"),
  }).strict().default({ deepgram: "DEEPGRAM_API_KEY", elevenlabs: "ELEVENLABS_API_KEY", azure: "AZURE_SPEECH_KEY" }),
  /** The Azure region the speech resource lives in, for example westeurope. */
  azureRegion: z.string().trim().regex(/^([a-z0-9]{2,30})?$/, "Use the region name, for example westeurope").default(""),
  /** The voice to read aloud with; empty means each engine's usual one. */
  voice: z.string().trim().max(100).regex(/^[\w .()-]*$/, "Use the voice's name or id").default(""),
  /** A program on this computer that reads words aloud, such as Piper. */
  program: z.string().trim().max(400).default(""),
  /** Its arguments. `{text}` is replaced by a file holding the words, `{out}` by the WAV file to write. */
  programArgs: z.array(z.string().max(400)).max(20).default([]),
}).strict();
export type SpeechEngineSettings = z.infer<typeof SpeechEngineSettingsSchema>;

const key = "speech-engines";
// The owner's rule (ships on, 2026-09-26): the switch alone changes nothing: with no engine picked the ordinary voice route is used, and a paid engine needs the owner's own key and pick; none of (a)–(f).
export const speechEnginesShipAs: FeatureMode = "when-needed";
export function speechEngineSettings(store: Pick<Store, "get">, owner: string): SpeechEngineSettings {
  const saved = SpeechEngineSettingsSchema.safeParse(store.get("settings", owner, key)?.data ?? {});
  return saved.success ? shippedUnlessChosen(store, owner, key, saved.data, { mode: speechEnginesShipAs }) : SpeechEngineSettingsSchema.parse({});
}

export interface EngineContext {
  settings: SpeechEngineSettings;
  /** The service's key, taken out of the locker at the moment of the call; null for local engines. */
  key: string | null;
  fetch: typeof globalThis.fetch;
  policy: NetworkPolicy;
  run: ProgramRunner;
  signal?: AbortSignal | undefined;
}
export interface SpeechEngine {
  id: string;
  label: string;
  /** True when the sound never leaves this computer. */
  local: boolean;
  /** Which of the settings' secret names holds this engine's key. */
  secret?: keyof SpeechEngineSettings["secrets"];
  listen?(clip: AudioClip, context: EngineContext): Promise<{ text: string; language: string | null }>;
  speak?(text: string, context: EngineContext): Promise<{ bytes: Uint8Array; mediaType: string; voice: string }>;
}
export interface SpokenIntent {
  id: string;
  /** Whole phrases, lower case, that mean this command. */
  phrases: string[];
}

/** The plug-in point: engines and spoken commands, each registered once under its own id. */
export class SpeechRegistry {
  private readonly engines = new Map<string, SpeechEngine>();
  private readonly intents = new Map<string, SpokenIntent>();
  register(engine: SpeechEngine): void {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(engine.id)) throw new Error(`"${engine.id}" is not a usable speech engine name`);
    if (this.engines.has(engine.id)) throw new Error(`A speech engine called ${engine.id} is already there`);
    if (!engine.listen && !engine.speak) throw new Error(`${engine.id} neither listens nor speaks`);
    this.engines.set(engine.id, engine);
  }
  get(id: string): SpeechEngine | undefined { return this.engines.get(id); }
  list(): { id: string; label: string; local: boolean; listens: boolean; speaks: boolean }[] {
    return [...this.engines.values()].map((engine) =>
      ({ id: engine.id, label: engine.label, local: engine.local, listens: !!engine.listen, speaks: !!engine.speak }));
  }
  addIntent(intent: SpokenIntent): void {
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(intent.id)) throw new Error(`"${intent.id}" is not a usable command name`);
    if (this.intents.has(intent.id)) throw new Error(`A spoken command called ${intent.id} is already there`);
    this.intents.set(intent.id, { id: intent.id, phrases: intent.phrases.map(normalise).filter(Boolean) });
  }
  intentList(): SpokenIntent[] { return [...this.intents.values()]; }
  /** The command a short utterance is, or null when it is ordinary speech for the assistant. */
  match(text: string): string | null {
    const said = normalise(text);
    if (!said || said.split(" ").length > 6) return null;
    for (const intent of this.intents.values()) if (intent.phrases.includes(said)) return intent.id;
    return null;
  }
}
const normalise = (text: string): string =>
  text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();

/* ---------- the built-in engines ---------- */

async function send(context: EngineContext, url: string, what: string, init: RequestInit): Promise<Response> {
  await context.policy.assertAllowed(new URL(url), what);
  const response = await context.fetch(url, { ...init, redirect: "error", ...(context.signal ? { signal: context.signal } : {}) });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`${what} failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  return response;
}
const needKey = (context: EngineContext, label: string): string => {
  if (!context.key) throw new Error(`${label} needs its key. Save it as a secret and name it under Settings → Voice.`);
  return context.key;
};
const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const deepgramReply = z.object({
  metadata: z.object({}).passthrough().optional(),
  results: z.object({ channels: z.array(z.object({
    detected_language: z.string().optional(),
    alternatives: z.array(z.object({ transcript: z.string() })),
  })) }),
});
export const deepgram: SpeechEngine = {
  id: "deepgram", label: "Deepgram", local: false, secret: "deepgram",
  async listen(clip, context) {
    const token = needKey(context, "Deepgram");
    const response = await send(context, "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&detect_language=true", "Writing out speech with Deepgram", {
      method: "POST", headers: { authorization: `Token ${token}`, "content-type": clip.mediaType }, body: Buffer.from(clip.bytes),
    });
    const channel = deepgramReply.parse(await response.json()).results.channels[0];
    return { text: channel?.alternatives[0]?.transcript.trim() ?? "", language: channel?.detected_language ?? null };
  },
  async speak(text, context) {
    const token = needKey(context, "Deepgram");
    const voice = context.settings.voice || "aura-2-thalia-en";
    const response = await send(context, `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}`, "Reading aloud with Deepgram", {
      method: "POST", headers: { authorization: `Token ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text }),
    });
    return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType: "audio/mpeg", voice };
  },
};

export const elevenlabs: SpeechEngine = {
  id: "elevenlabs", label: "ElevenLabs", local: false, secret: "elevenlabs",
  async listen(clip, context) {
    const token = needKey(context, "ElevenLabs");
    const form = new FormData();
    form.append("model_id", "scribe_v1");
    form.append("file", new Blob([new Uint8Array(clip.bytes)], { type: clip.mediaType }), clip.name);
    const response = await send(context, "https://api.elevenlabs.io/v1/speech-to-text", "Writing out speech with ElevenLabs", {
      method: "POST", headers: { "xi-api-key": token }, body: form,
    });
    const reply = z.object({ text: z.string(), language_code: z.string().optional() }).parse(await response.json());
    return { text: reply.text.trim(), language: reply.language_code ?? null };
  },
  async speak(text, context) {
    const token = needKey(context, "ElevenLabs");
    const voice = context.settings.voice || "21m00Tcm4TlvDq8ikWAM";
    if (!/^[A-Za-z0-9]{8,40}$/.test(voice)) throw new Error("An ElevenLabs voice is named by its id, letters and digits only");
    const response = await send(context, `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, "Reading aloud with ElevenLabs", {
      method: "POST", headers: { "xi-api-key": token, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    });
    return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType: "audio/mpeg", voice };
  },
};

const azureHost = (context: EngineContext, kind: "stt" | "tts"): string => {
  if (!context.settings.azureRegion) throw new Error("Azure speech needs its region. Add it under Settings → Voice.");
  return `https://${context.settings.azureRegion}.${kind}.speech.microsoft.com`;
};
export const azure: SpeechEngine = {
  id: "azure", label: "Azure speech", local: false, secret: "azure",
  async listen(clip, context) {
    const token = needKey(context, "Azure speech");
    if (!/wav/.test(clip.mediaType)) throw new Error("Azure speech takes WAV sound only here. Record in WAV, or pick another engine.");
    const url = `${azureHost(context, "stt")}/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=simple`;
    const response = await send(context, url, "Writing out speech with Azure", {
      method: "POST", headers: { "ocp-apim-subscription-key": token, "content-type": "audio/wav; codecs=audio/pcm; samplerate=16000" },
      body: Buffer.from(clip.bytes),
    });
    const reply = z.object({ RecognitionStatus: z.string(), DisplayText: z.string().optional() }).parse(await response.json());
    if (reply.RecognitionStatus !== "Success") throw new Error(`Azure heard no speech (${reply.RecognitionStatus})`);
    return { text: (reply.DisplayText ?? "").trim(), language: "en-US" };
  },
  async speak(text, context) {
    const token = needKey(context, "Azure speech");
    const voice = context.settings.voice || "en-US-AvaMultilingualNeural";
    const ssml = `<speak version="1.0" xml:lang="en-US"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`;
    const response = await send(context, `${azureHost(context, "tts")}/cognitiveservices/v1`, "Reading aloud with Azure", {
      method: "POST", body: ssml,
      headers: { "ocp-apim-subscription-key": token, "content-type": "application/ssml+xml",
        "x-microsoft-outputformat": "audio-24khz-48kbitrate-mono-mp3", "user-agent": "branch-agent" },
    });
    return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType: "audio/mpeg", voice };
  },
};

/** The owner's own arguments with the two placeholders filled in; nothing else is ever added. */
export function programArguments(template: string[], textPath: string, outPath: string): string[] {
  if (!template.some((arg) => arg.includes("{out}"))) throw new Error("The program's arguments must say where the sound goes, with {out}");
  return template.map((arg) => arg.replaceAll("{text}", textPath).replaceAll("{out}", outPath));
}
/**
 * mac7/install-torture: a reading-aloud program that was removed, or whose download stopped
 * half-way, otherwise comes back as the system's own "spawn … ENOENT", which says nothing about
 * what is wrong or what to do. The file is only looked at once running it has already failed.
 */
async function speechProgramProblem(file: string, error: unknown): Promise<Error> {
  const there = await stat(file).catch(() => null);
  if (!there?.isFile() || there.size === 0)
    return new Error(`The reading-aloud program at ${file} is not there any more (or its download did not finish). Install it again, or pick another engine under Settings → Voice.`);
  return error instanceof Error ? error : new Error(String(error));
}

export const program: SpeechEngine = {
  id: "program", label: "A program on this computer", local: true,
  async speak(text, context) {
    const { program: file, programArgs } = context.settings;
    if (!file || !isAbsolute(file)) throw new Error("Name the reading-aloud program by its full place under Settings → Voice.");
    const folder = await mkdtemp(join(tmpdir(), "branch-engine-"));
    try {
      const textPath = join(folder, "words.txt"), outPath = join(folder, "speech.wav");
      await writeFile(textPath, text, { encoding: "utf8", mode: 0o600 });
      await context.run(file, programArguments(programArgs, textPath, outPath), context.signal)
        .catch(async (error: unknown) => { throw await speechProgramProblem(file, error); });
      const bytes = await readFile(outPath).catch(() => Buffer.alloc(0));
      if (!bytes.length) throw new Error("The reading-aloud program made no sound");
      return { bytes: new Uint8Array(bytes), mediaType: "audio/wav", voice: file.split(/[\\/]/).pop() ?? "program" };
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

/** A registry holding the built-in engines and the built-in spoken commands. */
export function builtInSpeech(): SpeechRegistry {
  const registry = new SpeechRegistry();
  for (const engine of [deepgram, elevenlabs, azure, program]) registry.register(engine);
  registry.addIntent({ id: "stop", phrases: ["stop", "stop talking", "be quiet", "quiet", "arrête", "stop stop"] });
  registry.addIntent({ id: "repeat", phrases: ["say that again", "repeat that", "again please", "répète"] });
  registry.addIntent({ id: "slower", phrases: ["slower", "slow down", "speak slower", "plus lentement"] });
  registry.addIntent({ id: "faster", phrases: ["faster", "speed up", "speak faster", "plus vite"] });
  return registry;
}
