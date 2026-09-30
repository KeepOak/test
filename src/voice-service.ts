import { z } from "zod";
import { prepareSpokenText, spokenSentences } from "./voice-spoken-text.js";
import type { Provider, ToolContext } from "./contracts.js";
import type { ModelRouter } from "./models.js";
import type { SpeechEngineService } from "./speech-engine-service.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { voiceSettings, type AudioProvider, type VoiceSettings } from "./voice.js";
import { LocalSpeechSchema, runProgram, Transcription, type AudioClip, type SttRoute, type TranscriptionResult } from "./voice-stt.js";
import { LocalWhisper, type LocalWhisperFound, type WhisperChoice } from "./voice-whisper.js";
import { Speech, SpeakRequestSchema, type ProgramLocator, type SpeakRequest, type SpokenAudio, type TtsRoute } from "./voice-tts.js";

/**
 * Voice as the rest of the app sees it: hand it a recording and get words back, hand it words and
 * get sound back. This is where the owner's own choices are applied — which service, which voice,
 * which language, and whether anything containing sound is allowed to leave this computer at all.
 */
export interface VoiceRoute<K> {
  kind: K;
  provider: AudioProvider | null;
  /** Why this route was chosen, in plain words, for the record and the settings screen. */
  reason: string;
}

/** The audio address of a connection, plus how Gemini is told who is asking. */
export function audioOf(provider: Provider | undefined): AudioProvider | null {
  const route = provider?.audio?.() ?? null;
  return route && route.apiKey ? route : null;
}

/** Whether a connection speaks Gemini's shape rather than the OpenAI one. */
export const isGemini = (provider: Provider | undefined): boolean => provider?.name === "gemini";

/** What of the owner's voice settings the free speech program on this computer reads (src/voice-whisper.ts). */
export const whisperChoice = (settings: VoiceSettings): WhisperChoice => ({
  localSpeechExecutable: settings.localSpeechExecutable, localSpeechModel: settings.localSpeechModel,
  localSpeechKind: settings.localSpeechKind, language: settings.language,
});

/**
 * Which service should write a recording out, given what the owner chose and what is connected. `freeHere` is
 * whether a free speech program on this computer is ready (RES-709): left on "auto", that is used before any
 * paid service, so nothing is sent or charged.
 */
export function sttRouteFor(settings: VoiceSettings, provider: Provider | undefined, freeHere = false): VoiceRoute<SttRoute> {
  const audio = audioOf(provider);
  if (settings.keepAudioOnThisComputer)
    return { kind: "local", provider: null, reason: "You asked for audio to stay on this computer" };
  if (settings.sttRoute === "local") return { kind: "local", provider: null, reason: "You chose the speech program on this computer" };
  if (settings.sttRoute === "gemini") return { kind: "gemini", provider: audio, reason: "You chose Gemini" };
  if (settings.sttRoute === "openai") return { kind: "openai", provider: audio, reason: "You chose your model provider" };
  if (freeHere) return { kind: "local", provider: null, reason: "A free speech program on this computer is ready, so nothing is sent or charged" };
  if (isGemini(provider)) return { kind: "gemini", provider: audio, reason: `${provider?.name} is connected, and it can write speech out` };
  if (settings.localSpeechExecutable && !audio)
    return { kind: "local", provider: null, reason: "No connected model offers this, but a speech program is set up here" };
  return { kind: "openai", provider: audio, reason: "Your connected model offers this" };
}

/** The system voice in the owner's words: Windows keeps its own name, every other computer says "your computer's own voice". */
export function systemVoiceWords(platform: string = process.platform): { chosen: string; free: string } {
  return platform === "win32"
    ? { chosen: "the voice that comes with Windows", free: "the free Windows voice" }
    : { chosen: "your computer's own voice", free: "your computer's own voice, which is free," };
}

/** Which service should read a reply aloud. The computer's own voice is the one that needs nothing. */
export function ttsRouteFor(settings: VoiceSettings, provider: Provider | undefined, platform: string = process.platform): VoiceRoute<TtsRoute> {
  const audio = audioOf(provider);
  const words = systemVoiceWords(platform);
  if (settings.keepAudioOnThisComputer)
    return { kind: "windows", provider: null, reason: "You asked for audio to stay on this computer" };
  if (settings.ttsRoute === "windows") return { kind: "windows", provider: null, reason: `You chose ${words.chosen}` };
  if (settings.ttsRoute === "gemini") return { kind: "gemini", provider: audio, reason: "You chose Gemini" };
  if (settings.ttsRoute === "openai") return { kind: "openai", provider: audio, reason: "You chose your model provider" };
  if (!settings.useProviderVoice) return { kind: "windows", provider: null, reason: `Higher-quality voice is switched off, so ${words.free} is used` };
  if (isGemini(provider)) return { kind: "gemini", provider: audio, reason: `${provider?.name} is connected, and it can read text aloud` };
  if (!audio) return { kind: "windows", provider: null, reason: `No connected model offers this, so ${words.free} is used` };
  return { kind: "openai", provider: audio, reason: "Your connected model offers this" };
}

/** What reading aloud says while the computer's own voice is switched off. */
export function systemVoiceOffMessage(platform: string = process.platform, keepAudioHere = false): string {
  const name = platform === "win32" ? "The voice that comes with Windows" : "Your computer's own voice";
  // With audio kept on this computer the provider's voice refuses too, so it is not offered.
  const instead = keepAudioHere ? "" : ", or choose your provider's voice there";
  return `${name} is switched off, so nothing was read aloud. Turn it on under Settings → Voice${instead}.`;
}

/** Which computer the voice runs on, and how it starts and finds programs there; all replaced in tests. */
export interface VoiceSystem {
  platform?: string;
  /** Starts a program with a list of arguments and hands back what it printed. */
  runProgram?: (file: string, args: string[], signal?: AbortSignal) => Promise<string>;
  /** Where a program lives on the search path, without starting it. */
  locate?: ProgramLocator;
  /** RES-709: faster-whisper on this computer. Left out, the real one unless `runProgram` was handed in; null for none. */
  whisper?: LocalWhisper | null;
}

/** Everything the voice screens and routes need in one object, so callers never wire it up twice. */
export class VoiceService {
  readonly transcription: Transcription;
  readonly speech: Speech;
  /** The kind of computer this is, for the words the voice screens use. */
  readonly platform: string;
  /** Bucket 17: speech plug-ins the owner picked under Settings → Voice; asked first, null means carry on. */
  engines: SpeechEngineService | undefined;
  constructor(
    private readonly store: Store,
    private readonly models: ModelRouter,
    policy: NetworkPolicy,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    /** A program runner on its own (older callers), or the whole computer; replaced in tests so nothing is started. */
    system: VoiceSystem | VoiceSystem["runProgram"] = {},
  ) {
    const given: VoiceSystem = typeof system === "function" ? { runProgram: system } : system ?? {};
    this.platform = given.platform ?? process.platform;
    const where = { platform: this.platform, ...(given.locate ? { locate: given.locate } : {}) };
    // A test that hands in its own program runner starts no program, so it gets no speech worker either.
    const whisper = given.whisper !== undefined ? given.whisper : given.runProgram ? null : new LocalWhisper();
    this.transcription = new Transcription(policy, fetchImpl, given.runProgram ?? runProgram, whisper);
    this.speech = given.runProgram ? new Speech(policy, fetchImpl, given.runProgram, where) : new Speech(policy, fetchImpl, undefined, where);
  }
  settings(owner: string): VoiceSettings { return voiceSettings(this.store, owner); }
  /** The free speech program on this computer, as it stands for this owner's settings (RES-709). */
  localSpeech(owner: string): LocalWhisperFound | null {
    return this.transcription.whisper?.find(whisperChoice(this.settings(owner))) ?? null;
  }
  /** Ends the speech worker, if one is running. */
  close(): void { this.transcription.whisper?.stop(); }
  /** The connection that answers for this owner right now, for whichever conversation is open. */
  private provider(owner: string, sessionId = "voice"): Provider | undefined {
    return this.models.plan(owner, sessionId).candidates[0]?.provider;
  }
  /** What would happen if the owner pressed the microphone or Read aloud right now. */
  plan(owner: string): { stt: VoiceRoute<SttRoute>; tts: VoiceRoute<TtsRoute>; settings: VoiceSettings } {
    const settings = this.settings(owner), provider = this.provider(owner);
    const tts = ttsRouteFor(settings, provider, this.platform);
    const off = tts.kind === "windows" && settings.systemVoice === "off";
    const reason = systemVoiceOffMessage(this.platform, settings.keepAudioOnThisComputer);
    return { stt: sttRouteFor(settings, provider, !!this.localSpeech(owner)?.available), tts: off ? { ...tts, reason } : tts, settings };
  }
  /** The computer's own voices, or none without asking the computer while that voice is switched off. */
  async systemVoiceNames(owner: string): Promise<string[]> {
    return this.settings(owner).systemVoice === "off" ? [] : this.speech.windowsVoices();
  }
  /** Writes a recording out, using the owner's chosen service and language. */
  async transcribe(owner: string, clip: AudioClip, options: { signal?: AbortSignal } = {}): Promise<TranscriptionResult> {
    const settings = this.settings(owner);
    // Bucket 17 hook: a chosen speech plug-in does the work instead.
    const byEngine = await this.engines?.listen(owner, clip, settings.keepAudioOnThisComputer, options.signal);
    if (byEngine) return byEngine;
    const route = sttRouteFor(settings, this.provider(owner), !!this.localSpeech(owner)?.available);
    return this.transcription.transcribe(clip, {
      kind: route.kind, provider: route.provider,
      local: LocalSpeechSchema.parse({ executable: settings.localSpeechExecutable, model: settings.localSpeechModel, kind: settings.localSpeechKind }),
    }, {
      ...(settings.sttModel ? { model: settings.sttModel } : {}),
      language: settings.language || null,
      keepOnThisComputer: settings.keepAudioOnThisComputer,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
  /** Reads text aloud, using the owner's chosen voice and speed. */
  sentences(text: string): string[] { return spokenSentences(text); }
  async speak(owner: string, input: SpeakRequest, options: { signal?: AbortSignal } = {}): Promise<SpokenAudio> {
    const settings = this.settings(owner);
    input = { ...input, text: prepareSpokenText(input.text) };
    if (!input.text) throw new Error("There is no spoken text in this reply.");
    // Bucket 17 hook: a chosen speech plug-in does the work instead.
    const byEngine = await this.engines?.speak(owner, input.text, settings.keepAudioOnThisComputer, options.signal);
    if (byEngine) return byEngine;
    const route = ttsRouteFor(settings, this.provider(owner), this.platform);
    if (route.kind === "windows" && settings.systemVoice === "off")
      throw new Error(systemVoiceOffMessage(this.platform, settings.keepAudioOnThisComputer));
    const request: SpeakRequest = {
      text: input.text,
      voice: input.voice || (settings.voiceId === "default" ? "" : settings.voiceId),
      speed: input.speed ?? settings.speechRate,
      ...(input.model || settings.ttsModel ? { model: input.model || settings.ttsModel } : {}),
    };
    return this.speech.speak(request, { kind: route.kind, provider: route.provider }, {
      keepOnThisComputer: settings.keepAudioOnThisComputer,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}

/**
 * The `voice.say` tool. It hands back sound the person's own screen plays, and it obeys "keep
 * audio on this computer" because the refusal lives in the service, not in the web route.
 */
export function registerVoice(registry: ToolRegistry, voice: VoiceService, store?: Store): void {
  registry.register({
    name: "voice.say", permission: "media.write",
    description: "Read a short piece of text aloud for the person, using the voice they chose. Use it when someone asks to hear something rather than read it.",
    parameters: SpeakRequestSchema.extend({ voice: z.string().trim().max(80).default("") }),
    target: () => "reading something aloud",
    execute: async (input: SpeakRequest, context: ToolContext) => {
      if (context.dryRun) return { wouldSay: input.text.slice(0, 200) };
      const spoken = await voice.speak(context.owner, input, { signal: context.signal });
      // What this cost goes into the task's own record, beside every other cost, so the Usage
      // screen is not the only place money is accounted for.
      if (store && context.runId)
        store.event(context.runId, "voice.spoken", {
          route: spoken.route, characters: input.text.length,
          cost: spoken.cost.amount, note: spoken.cost.note,
        });
      return {
        spoken: input.text.slice(0, 500), voice: spoken.voice, route: spoken.route,
        seconds: null, bytes: spoken.bytes.byteLength, mediaType: spoken.mediaType,
        cost: spoken.cost.amount, costNote: spoken.cost.note,
      };
    },
  });
}
