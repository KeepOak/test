import { z } from "zod";
import { markChosen, shippedUnlessChosen } from "./ship-on.js";
import { FeatureModeSchema, systemVoiceShipsAs } from "./feature-switches.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Store } from "./store.js";

/**
 * Voice settings stored per owner. Preferences for speech input and output.
 */
export const VoiceSettingsSchema = z
  .object({
    autoReadAloud: z.boolean().default(false),
    /**
     * wire-greyed: with read-aloud on, "always" reads every reply the owner is watching; "spoken" only a reply to a message
     * the owner said rather than typed (dictation in the window marks that message).
     */
    readAloudWhen: z.enum(["always", "spoken"]).default("always"),
    voiceId: z.string().max(200).default("default"),
    speechRate: z.number().min(0.5).max(2).default(1),
    useProviderVoice: z.boolean().default(false),
    // Wave 7: which service writes speech out and which reads it aloud, and the one setting that
    // overrules both. "auto" means "whatever the connected model offers"; every other value is a
    // deliberate choice by the owner and is never quietly swapped for something else.
    /** Where recordings are written out: the connected model, Gemini, or a program on this computer. */
    sttRoute: z.enum(["auto", "openai", "gemini", "local"]).default("auto"),
    /** Which service reads replies aloud. "windows" is the computer's own voice (the name is kept for saved settings). */
    ttsRoute: z.enum(["auto", "openai", "gemini", "windows", "piper"]).default("auto"),
    /** The transcription model to ask for; empty means each route's usual one. */
    sttModel: z.string().trim().max(200).default(""),
    /** The speech model to ask for; empty means each route's usual one. */
    ttsModel: z.string().trim().max(200).default(""),
    /**
     * mac2: the computer's own voice (Windows voices, `say`, espeak-ng): off, when needed, or on.
     * Off until the owner turns it on; while off, that route refuses and its voice list stays empty.
     */
    systemVoice: FeatureModeSchema.default("off"),
    /** A language code such as "en" to force, or empty to let the service work it out itself. */
    language: z.string().trim().max(20).default(""),
    /** Nothing containing sound may leave this computer; the cloud routes refuse rather than send. */
    keepAudioOnThisComputer: z.boolean().default(false),
    /** A speech program already installed here, for writing out recordings without the internet. */
    localSpeechExecutable: z.string().trim().max(400).default(""),
    localSpeechModel: z.string().trim().max(400).default(""),
    localSpeechKind: z.enum(["whisper-cpp", "faster-whisper"]).default("whisper-cpp"),
    /** Installed external Piper CLI and an existing .onnx voice with adjacent .onnx.json. */
    localVoiceExecutable: z.string().trim().max(400).default(""),
    localVoiceModel: z.string().trim().max(400).default(""),
    /**
     * mac7/live-voice: a streaming speech program on this computer that is handed sound on its
     * standard input and writes words out as it hears them, for live dictation. Empty means none,
     * and Branch looks for whisper-stream or sherpa-onnx on the search path instead. Branch never
     * downloads one.
     */
    localSpeechStream: z.string().trim().max(400).default(""),
    /** Answer a voice note on a chat app with a voice note back. Off until the owner turns it on. */
    replyWithVoiceOnChannels: z.boolean().default(false),
    // Wave 8: a live conversation, where sound goes up while it is being spoken. Everything here
    // is a limit rather than a feature: how long one may last, what it may cost, and whether any
    // of the sound is written down afterwards.
    /** A live conversation stops itself after this many minutes. */
    liveMaxMinutes: z.number().min(1).max(120).default(10),
    /** A live conversation stops itself once it has cost this much. */
    liveMaxDollars: z.number().min(0.1).max(100).default(1),
    /** Let the service decide when you have stopped speaking, rather than pressing the button. */
    liveVoiceDetection: z.boolean().default(true),
    /**
     * Write down how much sound a live conversation carried, piece by piece. The sound itself is
     * never kept, on or off; this only adds the size of each piece to the task's record.
     */
    keepLiveRecordings: z.boolean().default(false),
    /**
     * phase2/rooms: Talk live in a view of its own (a circle that moves with the sound, what each side
     * said as it is said, Mute, End), and the send button offering Talk live while the box is empty.
     * Off: Talk live is the plain button it always was.
     */
    liveView: z.enum(["off", "on"]).default("off"),
  })
  .strict();
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

export function voiceSettings(store: Store, owner: string): VoiceSettings {
  const saved = store.get("settings", owner, "voice")?.data;
  const parsed = VoiceSettingsSchema.parse(saved ?? {});
  // The owner's rule (src/ship-on.ts): the computer's own voice reads as it ships unless the owner chose.
  return shippedUnlessChosen(store, owner, "voice", parsed, { systemVoice: systemVoiceShipsAs });
}

export function saveVoiceSettings(
  store: Store,
  owner: string,
  settings: unknown,
): VoiceSettings {
  // Merged onto what is saved, like every other settings screen, so a form that only knows some of
  // the fields (the older voice card, or one written before a field existed) cannot reset the rest.
  const given = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const parsed = VoiceSettingsSchema.parse({ ...voiceSettings(store, owner), ...given });
  store.save("settings", owner, "voice", parsed);
  markChosen(store, owner, "voice", Object.keys(given));
  return parsed;
}

/**
 * Audio endpoint info from a provider's audio() method
 */
export interface AudioProvider {
  readonly endpoint: string;
  readonly apiKey: string;
}

/**
 * Transcribe audio from a browser's MediaRecorder to text using the configured provider's
 * OpenAI-compatible /audio/transcriptions endpoint. Throws a plain-language error if:
 * - The provider has no /audio/transcriptions endpoint or no API key
 * - The audio exceeds size or duration limits
 */
export async function transcribeAudio(
  audio: Uint8Array,
  provider: AudioProvider | null,
  policy: NetworkPolicy,
  fetch: typeof globalThis.fetch,
): Promise<string> {
  if (!provider) {
    throw new Error(
      "Speech to text needs an OpenAI-compatible provider with a key. Add one in Settings → Model.",
    );
  }

  const url = new URL("/v1/audio/transcriptions", provider.endpoint);

  // Check network policy before making the request
  try {
    await policy.assertAllowed(url, "audio transcription");
  } catch (e) {
    throw new Error(`Cannot reach audio transcription endpoint: ${e instanceof Error ? e.message : String(e)}`);
  }

  const form = new FormData();
  const audioBlob = new Blob([Buffer.from(audio)], { type: "audio/webm" });
  form.append("file", audioBlob, "audio.webm");
  form.append("model", "whisper-1");

  const response = await fetch(url.href, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const error = await response.text().catch(() => response.statusText);
    throw new Error(`Transcription failed: ${response.status} ${error}`);
  }

  const result = await response.json() as { text?: string };
  if (!result.text) throw new Error("No text in transcription response");
  return result.text;
}

/**
 * Request the configured provider's /audio/speech endpoint to generate speech from text.
 * Throws a plain-language error if the provider has no endpoint or no API key.
 * Returns the audio stream (Uint8Array) for the client to play.
 */
export async function generateSpeech(
  text: string,
  provider: AudioProvider | null,
  policy: NetworkPolicy,
  fetch: typeof globalThis.fetch,
  /** Which voice to use and which speech model to ask; both fall back to the defaults below. */
  options: { voice?: string; model?: string } = {},
): Promise<Uint8Array> {
  if (!provider) {
    throw new Error(
      "Higher-quality voice needs an OpenAI-compatible provider with a key. Add one in Settings → Model.",
    );
  }

  const url = new URL("/v1/audio/speech", provider.endpoint);

  try {
    await policy.assertAllowed(url, "audio speech");
  } catch (e) {
    throw new Error(`Cannot reach speech endpoint: ${e instanceof Error ? e.message : String(e)}`);
  }

  const response = await fetch(url.href, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.model ?? "tts-1",
      input: text,
      voice: options.voice || "alloy",
    }),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => response.statusText);
    throw new Error(`Speech generation failed: ${response.status} ${error}`);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}
