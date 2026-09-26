import { z } from "zod";
import type { ModelRouter } from "./models.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Store } from "./store.js";
import { saveVoiceSettings } from "./voice.js";
import { recordedWrite } from "./settings-kit/recorded-write.js";
import { audioPricedAt, sttPricesPerMinute } from "./voice-stt.js";
import { speechPricedAt, ttsPricesPerThousand } from "./voice-tts.js";
import { realtimeNote } from "./voice-talk.js";
import { livePlanFor, liveDollarsPerMinute, livePricedAt } from "./realtime-voice.js";
import { systemVoiceWords, type VoiceService } from "./voice-service.js";
import { listModels, switchModel } from "./model-switch.js";
import { mayUseConversation } from "./commands/household.js";
import { conversationHolder } from "./household-approvals.js";
import { HttpError } from "./server-http.js";
import { profileSettings, routeByProfile, saveProfileSettings, taskKinds } from "./model-profiles.js";
import { probeAll, probeProvider } from "./provider-probe.js";
import type { OAuthConnections } from "./oauth.js";
import { GeminiSignInSchema, geminiSignInNote, registerSignedInGemini } from "./gemini-signin.js";

/**
 * The `/api/voice/*` and `/api/models/*` screens behind one function, so the route table in
 * src/server.ts gains a single short block. Nothing here plays a sound or opens a microphone: the
 * browser does the recording and the playing, and this only decides and fetches.
 */
export interface VoiceApiDeps {
  store: Store;
  models: ModelRouter;
  owner: string;
  voice: VoiceService;
  policy: NetworkPolicy;
  fetch: typeof globalThis.fetch;
  /** Wave 7: signing in with Google for Gemini. Absent in tests that do not use it. */
  oauth?: OAuthConnections;
  /** phase2/rooms: why a live conversation cannot hang off this conversation (a Trunk's, a room), or null. */
  liveRefusal?: (sessionId: string) => string | null;
  /** The task a live conversation hangs off waits for its socket to open it, and is stopped if none does. */
  liveWaits?: (runId: string) => void;
}

const switchBody = z.object({ sessionId: z.string().uuid(), model: z.string().trim().min(1).max(120) }).strict();
const kindBody = z.object({ kind: z.enum(taskKinds).default("chat") }).strict();
const liveBody = z.object({ sessionId: z.string().uuid().nullable().default(null) }).strict();

export async function voiceApi(
  deps: VoiceApiDeps, method: string, path: string, body: () => Promise<unknown>,
): Promise<unknown> {
  const { store, models, owner, voice } = deps;
  if (method === "GET" && path === "/api/voice/plan") return voicePlan(deps);
  if (method === "POST" && path === "/api/voice/settings") {
    const input = await body();
    return recordedWrite(store, owner, { writer: "owner-in-window", source: "card", detail: "voice" }, ["voice"],
      () => saveVoiceSettings(store, owner, input));
  }
  if (method === "GET" && path === "/api/voice/voices") return systemVoices(voice, owner);
  // Wave 8: a live conversation hangs off a task like everything else, so the browser is given one
  // to open a socket on. Nothing reaches outside this computer until the browser says "start" on
  // that socket, and a connection that cannot hold a live conversation is refused here in words.
  if (method === "POST" && path === "/api/voice/live") return openLive(deps, await body());
  if (method === "GET" && path === "/api/models/profiles") return profileSettings(store, owner, models);
  if (method === "POST" && path === "/api/models/profiles") return saveProfileSettings(store, owner, models, await body());
  if (method === "POST" && path === "/api/models/profiles/preview") {
    const { kind } = kindBody.parse(await body());
    return { choice: routeByProfile(store, models, owner, kind) };
  }
  if (method === "GET" && path === "/api/models/switch") return listModels(models, owner, "");
  if (method === "POST" && path === "/api/models/switch") {
    const input = switchBody.parse(await body());
    // Q261: only a conversation of whoever is at the window (a household person's own, lent to the owner while it
    // works included). The owner's conversation reads to anybody else exactly like one that does not exist, and a
    // household person is not told the owner's connection names when a name is wrong.
    if (!mayUseConversation(store, owner, "window", input.sessionId)) throw new HttpError(404, "Conversation not found");
    return switchModel(models, owner, input.sessionId, input.model,
      { names: store.profiles.isOwner(), holder: conversationHolder(store, owner, input.sessionId) });
  }
  // Wave 7: "Sign in with Google" on the Gemini card. The settings are kept so the card can say
  // whether a sign-in has been set up at all; the note is never hidden, because signing in only
  // works against the person's own Google Cloud project.
  if (path === "/api/models/gemini-signin") {
    if (method === "GET") return geminiSignInState(store, owner, models);
    if (method === "POST") return signInWithGoogle(deps, await body());
  }
  if (method === "GET" && path === "/api/models/probe") return { connections: await probeAll(models, deps.policy, deps.fetch) };
  if (method === "POST" && path === "/api/models/probe") {
    const { id } = z.object({ id: z.string().min(1).max(64) }).strict().parse(await body());
    return { connection: await probeProvider(models, id, deps.policy, deps.fetch) };
  }
  throw new Error("That is not something Branch can do with voice or model settings");
}

/**
 * What the Voice screen shows: which service would do the work right now, where the sound would
 * go, and what a minute of it costs — said plainly, and never invented when no price is on file.
 */
export function openLive(deps: VoiceApiDeps, input: unknown) {
  const { sessionId } = liveBody.parse(input);
  // phase2/rooms: asked for a new conversation too (Lockdown, a household person); src/live-refusal.ts.
  const refused = deps.liveRefusal?.(sessionId ?? "") ?? null;
  if (refused) throw new Error(refused);
  const plan = livePlanFor(deps.voice.settings(deps.owner), deps.models.plan(deps.owner, sessionId ?? "voice").candidates[0]);
  if (!plan.available) throw new Error(plan.reason);
  const run = deps.store.createRun(deps.owner, "A live conversation", sessionId ?? undefined, false, "web");
  // Only the socket ends a conversation, so a task whose socket never opens one is stopped after a wait
  // (src/realtime-voice.ts) rather than left working until Branch restarts.
  deps.liveWaits?.(run.id);
  return { runId: run.id, sessionId: run.sessionId, plan };
}

export function voicePlan(deps: VoiceApiDeps) {
  const plan = deps.voice.plan(deps.owner);
  return {
    settings: plan.settings,
    speechToText: { route: plan.stt.kind, reason: plan.stt.reason, ready: plan.stt.kind === "local" || plan.stt.provider !== null },
    readAloud: { route: plan.tts.kind, reason: plan.tts.reason,
      ready: plan.tts.kind === "windows" ? plan.settings.systemVoice !== "off" : plan.tts.provider !== null },
    whereAudioGoes: whereAudioGoes(plan.stt.kind, plan.tts.kind, deps.voice.platform),
    // mac2/desktop-ui: the words this computer uses, without asking it for its voices.
    systemVoice: systemVoiceLabels(deps.voice.platform),
    prices: { perMinute: sttPricesPerMinute, perThousandCharacters: ttsPricesPerThousand, transcriptionPricedAt: audioPricedAt, speechPricedAt },
    realtimeNote,
    // Wave 8: whether a live conversation is possible on the connection chosen right now, and the
    // limits it would run under. The composer asks the same question before it offers the button.
    live: { ...livePlanFor(plan.settings, deps.models.plan(deps.owner, "voice").candidates[0]), dollarsPerMinute: liveDollarsPerMinute, pricedAt: livePricedAt },
  };
}

/**
 * The voices already on this computer, for the list in Settings → Voice. `windows` is the name older
 * screens ask for and is kept; `system` is the same list under a name that fits every computer.
 */
export async function systemVoices(voice: VoiceService, owner: string) {
  const names = await voice.systemVoiceNames(owner);
  return { windows: names, system: names, mode: voice.settings(owner).systemVoice, ...systemVoiceLabels(voice.platform) };
}

/** The name of the system voice in the route list, and where to allow the microphone. */
export function systemVoiceLabels(platform: string): { platform: string; label: string; microphoneHelp: string } {
  return {
    platform,
    label: platform === "win32" ? "The voice that comes with Windows (free, works offline)" : "Your computer's own voice (free, works offline)",
    microphoneHelp: microphoneHelp(platform),
  };
}

/** Where to allow the microphone, in the words of this kind of computer. */
export function microphoneHelp(platform: string): string {
  if (platform === "darwin") return "The microphone is not available. Allow it for Branch Agent in System Settings, Privacy & Security, Microphone, and try again.";
  if (platform === "linux") return "The microphone is not available. Check your desktop's sound settings and that the microphone is not muted, and try again.";
  return "The microphone is not available. Allow it for Branch Agent in Windows settings and try again.";
}

/** One sentence about where recordings and spoken replies travel, in the owner's own terms. */
export function whereAudioGoes(stt: string, tts: string, platform: string = process.platform): string {
  const isWindows = platform === "win32";
  const both = stt === "local" && tts === "windows";
  if (both) return isWindows
    ? "Nothing leaves this computer: recordings are written out here, and replies are read aloud by a voice that comes with Windows."
    : "Nothing leaves this computer: recordings are written out here, and replies are read aloud by your computer's own voice.";
  const parts: string[] = [];
  parts.push(stt === "local"
    ? "Your recordings are written out on this computer."
    : "Your recordings are sent to your model provider to be written out, and you are charged for the minutes.");
  parts.push(tts === "windows"
    ? (isWindows ? "Replies are read aloud by a voice that comes with Windows, which costs nothing." : `Replies are read aloud by ${systemVoiceWords(platform).chosen}, which costs nothing.`)
    : "The words of a reply are sent to your model provider to be read aloud, and you are charged for the characters.");
  return parts.join(" ");
}

/* ---------- Wave 7: signing in with Google for Gemini ---------- */

const geminiSettingsKey = "gemini-signin";

/** What the Gemini card shows before anybody presses anything. */
export function geminiSignInState(store: Store, owner: string, models: ModelRouter) {
  const saved = GeminiSignInSchema.safeParse(store.get("settings", owner, geminiSettingsKey)?.data);
  const settings = saved.success ? saved.data : GeminiSignInSchema.parse({});
  return {
    settings,
    /** True once a signed-in connection is registered; it goes when Branch restarts. */
    connected: models.presets.has("google-gemini"),
    note: geminiSignInNote,
  };
}

/**
 * Signs in and registers the connection. The client id is saved first so the card remembers it,
 * then a token is asked for. Whatever Google refuses comes back as plain words, and the ordinary
 * key flow is never taken away.
 */
export async function signInWithGoogle(deps: VoiceApiDeps, input: unknown) {
  const { store, owner, models } = deps;
  const settings = GeminiSignInSchema.parse(input);
  store.save("settings", owner, geminiSettingsKey, settings);
  if (!deps.oauth) throw new Error(`Signing in with Google is not set up on this copy. ${geminiSignInNote}`);
  const preset = await registerSignedInGemini(deps.oauth, settings, (value) => models.register(value));
  return { connected: true, preset: { id: preset.id, name: preset.name, model: preset.model }, note: geminiSignInNote };
}
