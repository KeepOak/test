import { isAbsolute } from "node:path";
import { markChosen } from "./ship-on.js";
import { z } from "zod";
import type { NetworkPolicy } from "./network-policy.js";
import type { Store } from "./store.js";
import type { ProgramRunner } from "./media-programs.js";
import {
  SpeechEngineSettingsSchema, speechEngineSettings, type EngineContext, type SpeechEngine, type SpeechEngineSettings, type SpeechRegistry,
} from "./speech-engines.js";
import { runProgram, type AudioClip, type TranscriptionResult } from "./voice-stt.js";
import type { SpokenAudio } from "./voice-tts.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48

/**
 * Bucket 17: the speech plug-ins as the rest of the app sees them, for one owner at a time. The
 * voice service asks here first; an answer of null means "no engine is chosen, or the switch is
 * off", and the ordinary routes carry on exactly as before.
 */
export interface SpeechEngineDeps {
  store: Store;
  registry: SpeechRegistry;
  policy: NetworkPolicy;
  fetch: typeof globalThis.fetch;
  /** A secret's value by name, taken out at the moment of the call; null when it is not there. */
  secret: (owner: string, name: string, purpose: string) => Promise<string | null>;
  run?: ProgramRunner;
}
const unknownPrice = (label: string) =>
  ({ amount: null, currency: "USD" as const, confidence: "unknown" as const, note: `no price on file for ${label}` });
const freeHere = { amount: 0, currency: "USD" as const, confidence: "free" as const, note: "this ran on your computer, so nothing was charged" };
const keepHereRefusal = (label: string) =>
  `You asked for audio to stay on this computer, so nothing was sent to ${label}. Pick a program on this computer under Settings → Voice, or turn that setting off.`;

export class SpeechEngineService {
  constructor(private readonly deps: SpeechEngineDeps) {}
  get store(): Store { return this.deps.store; }
  settings(owner: string): SpeechEngineSettings { return speechEngineSettings(this.deps.store, owner); }
  /** Saves the owner's choices, refusing an engine that does not exist or cannot do the job. */
  save(owner: string, input: unknown): SpeechEngineSettings {
    const given = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const current = this.settings(owner);
    const merged = SpeechEngineSettingsSchema.parse({ ...current, ...given,
      secrets: { ...current.secrets, ...(given.secrets && typeof given.secrets === "object" ? given.secrets : {}) } });
    if (merged.listen && !this.deps.registry.get(merged.listen)?.listen) throw new Error(`${merged.listen} cannot write speech out`);
    if (merged.speak && !this.deps.registry.get(merged.speak)?.speak) throw new Error(`${merged.speak} cannot read aloud`);
    if (merged.program && (!isAbsolute(merged.program) || merged.program.startsWith("-")))
      throw new Error("Name the reading-aloud program by its full place, for example /opt/homebrew/bin/piper");
    this.deps.store.save("settings", owner, "speech-engines", merged);
    markChosen(this.deps.store, owner, "speech-engines", Object.keys(given));
    return merged;
  }
  /** What the Voice screen lists. */
  view(owner: string) {
    return { settings: this.settings(owner), engines: this.deps.registry.list(), commands: this.deps.registry.intentList() };
  }
  private chosen(owner: string, which: "listen" | "speak"): { engine: SpeechEngine; settings: SpeechEngineSettings } | null {
    const settings = this.settings(owner);
    if (settings.mode === "off" || !settings[which]) return null;
    const engine = this.deps.registry.get(settings[which]);
    if (!engine) throw new Error(`The speech engine ${settings[which]} is not installed any more. Pick another under Settings → Voice.`);
    return { engine, settings };
  }
  private async context(owner: string, engine: SpeechEngine, settings: SpeechEngineSettings, signal?: AbortSignal): Promise<EngineContext> {
    const name = engine.secret ? settings.secrets[engine.secret] : "";
    const key = name ? await this.deps.secret(owner, name, `speech with ${engine.label}`) : null;
    return { settings, key, fetch: this.deps.fetch, policy: this.deps.policy, run: this.deps.run ?? runProgram, signal };
  }
  /** Writes a clip out with the chosen engine, or null when none is chosen. */
  async listen(owner: string, clip: AudioClip, keepHere: boolean, signal?: AbortSignal): Promise<TranscriptionResult | null> {
    const picked = this.chosen(owner, "listen");
    if (!picked?.engine.listen) return null;
    if (keepHere && !picked.engine.local) throw new Error(keepHereRefusal(picked.engine.label));
    const heard = await picked.engine.listen(clip, await this.context(owner, picked.engine, picked.settings, signal));
    if (!heard.text) throw new Error(`${picked.engine.label} answered without any words in it`);
    return { text: heard.text, language: heard.language, route: `engine:${picked.engine.id}`,
      cost: picked.engine.local ? freeHere : unknownPrice(picked.engine.label) };
  }
  /** Reads words aloud with the chosen engine, or null when none is chosen. */
  async speak(owner: string, text: string, keepHere: boolean, signal?: AbortSignal): Promise<SpokenAudio | null> {
    const picked = this.chosen(owner, "speak");
    if (!picked?.engine.speak) return null;
    if (keepHere && !picked.engine.local) throw new Error(keepHereRefusal(picked.engine.label));
    const spoken = await picked.engine.speak(text, await this.context(owner, picked.engine, picked.settings, signal));
    return { ...spoken, route: `engine:${picked.engine.id}`, cost: picked.engine.local ? freeHere : unknownPrice(picked.engine.label) };
  }
  /** The spoken command a short phrase is, or null (always null while the switch is off). */
  command(owner: string, text: string): string | null {
    return this.settings(owner).mode === "off" ? null : this.deps.registry.match(text);
  }
}

const commandBody = z.object({ text: z.string().max(200) }).strict();
/** `/api/voice/engines` and `/api/voice/command`. */
export async function speechEnginesApi(
  service: SpeechEngineService, owner: string, method: string, path: string, body: () => Promise<unknown>,
): Promise<unknown> {
  if (path === "/api/voice/engines" && method === "GET") return service.view(owner);
  if (path === "/api/voice/engines" && method === "POST") {
    const input = await body();
    return { ...service.view(owner), settings: recordedWrite(service.store, owner, byCard("speech-engines"), ["speech-engines"], () => service.save(owner, input)) };
  }
  if (path === "/api/voice/command" && method === "POST") return { command: service.command(owner, commandBody.parse(await body()).text) };
  throw new Error("That is not something Branch can do with speech engines");
}
