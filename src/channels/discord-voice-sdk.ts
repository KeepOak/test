import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import type { EventEmitter } from "node:events";
export interface VoiceMethods { onVoiceServerUpdate(data: unknown): void; onVoiceStateUpdate(data: unknown): void; destroy(): void }
export interface VoiceSink { ready(botId: string): void; event(type: string, data: unknown): void; stopped(): void }
export interface VoiceConnection extends EventEmitter { state: { status: string }; receiver: { speaking: EventEmitter; subscribe(id: string, options: unknown): Readable }; subscribe(player: Player): unknown; destroy(): void }
export interface Player extends EventEmitter { play(resource: unknown): void; stop(force?: boolean): boolean }
export interface VoiceSdk { joinVoiceChannel(options: unknown): VoiceConnection; createAudioPlayer(options?: unknown): Player; createAudioResource(input: Readable, options: unknown): unknown;
  entersState(target: unknown, state: string, signal: AbortSignal): Promise<unknown>; VoiceConnectionStatus: { Ready: string; Disconnected: string }; AudioPlayerStatus: { Idle: string }; EndBehaviorType: { AfterSilence: number }; StreamType: { Arbitrary: string } }
export interface OpusCodec { decode(input: Buffer): Buffer }
export function preparedDiscordVoice(): { sdk: VoiceSdk; codec(): OpusCodec } {
  const require = createRequire(import.meta.url), [major, minor] = process.versions.node.split(".").map(Number);
  if (major! < 24 || major === 24 && minor! < 17) throw new Error("Hold: Discord voice requires Node 24.17 or newer.");
  try {
    // Optional prepared modules only: the application never installs or downloads a voice bundle.
    const metadata = JSON.parse(readFileSync(join(dirname(require.resolve("@discordjs/voice")), "..", "package.json"), "utf8")) as { version?: string };
    if (metadata.version !== "0.19.2") throw new Error("Voice SDK version is not the reviewed 0.19.2");
    const sdk = require("@discordjs/voice") as VoiceSdk;
    createRequire(require.resolve("@discordjs/voice"))("@snazzah/davey");
    const opus = require("@discordjs/opus") as { OpusEncoder: new (rate: number, channels: number) => OpusCodec };
    if (!sdk.joinVoiceChannel || !sdk.entersState || !sdk.EndBehaviorType) throw new Error("Unsupported SDK interface");
    return { sdk, codec: () => new opus.OpusEncoder(48_000, 2) };
  } catch { throw new Error("Hold: prepare @discordjs/voice 0.19.2, DAVE, @discordjs/opus and FFmpeg before joining. Nothing was installed."); }
}
/** 48 kHz stereo PCM to a bounded WAV for the existing Branch transcription service. */
export function discordWav(pcm: Buffer): Buffer {
  const head = Buffer.alloc(44); head.write("RIFF", 0); head.writeUInt32LE(pcm.length + 36, 4); head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(48_000, 24);
  head.writeUInt32LE(192_000, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
