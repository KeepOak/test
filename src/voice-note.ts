import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWav } from "./media-audio.js";

/**
 * UP-CHAT-005: what a spoken reply needs before it is sent as a voice note.
 * - `spokenText`: the words a voice reads, without Markdown's marks.
 * - `pcmAsWav`: Gemini's raw PCM made playable.
 * - `toOggOpus`: sound turned into the OGG/Opus a chat app shows as a voice bubble.
 */

// The cleanup below is adapted from Hermes Agent (MIT, Copyright (c) 2025 Nous Research), tools/tts_text_normalize.py
// (`strip_nonspoken_blocks`, `strip_markdown_for_tts`, `smooth_whitespace_for_tts`) at commit a9a54245. It keeps only
// the language-neutral steps: no English unit or currency words are added.
const steps: [RegExp, string | ((...found: string[]) => string)][] = [
  [/<think[\s>][\s\S]*?<\/think>/gi, " "], [/<think[\s>][\s\S]*$/i, " "],
  [/```[\s\S]*?```/g, " "], [/```[\s\S]*$/g, " "],
  [/!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, (_all, alt) => (alt ? ` ${alt} ` : " ")],
  [/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1"],
  [/https?:\/\/\S+/g, ""],
  [/`([^`]+)`/g, "$1"],
  [/\*\*([\s\S]+?)\*\*/g, "$1"], [/__([\s\S]+?)__/g, "$1"],
  [/(?<!\*)\*(?![\s*])([\s\S]+?)(?<![\s*])\*(?!\*)/g, "$1"], [/(?<![\w_])_(?![\s_])([\s\S]+?)(?<![\s_])_(?![\w_])/g, "$1"],
  [/~~([\s\S]+?)~~/g, "$1"],
  [/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "$1."],
  [/^\s*>\s?/gm, ""], [/^\s*(?:[-*+]|\d+[.)])\s+/gm, ""], [/^\s*[-*_]{3,}\s*$/gm, ""],
  [/\s*\|\s*/g, "; "],
  [/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+/gu, ""], [/[︎️]/g, ""],
];
const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " };

/** Markdown turned into the sentences a voice reads, cut at the last full sentence that fits in `max` characters. */
export function spokenText(text: string, max = 4000): string {
  let spoken = text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => entities[entity] ?? entity);
  for (const [pattern, replacement] of steps) spoken = spoken.replace(pattern, replacement as string);
  // With more than one line, each line becomes a sentence, so a list is read with pauses rather than run together.
  const lines = spoken.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^[;.\s]*$/.test(line));
  spoken = lines.length < 2 ? (lines[0] ?? "")
    : lines.map((line) => (/[.!?:;,]$/.test(line) ? line.replace(/[:;]$/, ".") : `${line}.`)).join(" ");
  spoken = spoken.replace(/^[;\s]+|[;\s]+$/g, "").replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/\.{2,}(?!\.)/g, ".");
  if (spoken.length <= max) return spoken;
  const cut = spoken.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (end > max / 2 ? cut.slice(0, end + 1) : cut).trim();
}

/**
 * Gemini's speech comes back as raw 16-bit little-endian PCM (`audio/L16;codec=pcm;rate=24000`), which no player
 * opens. It is given a WAV header, as Hermes Agent's `_wrap_pcm_as_wav` (tools/tts_tool_delivery.py) does. Anything
 * that already names a container is handed back as it came.
 */
export function pcmAsWav(bytes: Uint8Array, mimeType: string | undefined): { bytes: Uint8Array; mediaType: string } {
  const type = (mimeType ?? "").toLowerCase();
  if (type && !/l16|pcm/.test(type)) return { bytes, mediaType: mimeType! };
  const rate = Number(/rate=(\d{4,6})/.exec(type)?.[1] ?? 24000);
  const channels = Number(/channels=(\d)/.exec(type)?.[1] ?? 1);
  const wav = writeWav({ channels, sampleRate: rate, bitsPerSample: 16, blockAlign: channels * 2 }, Buffer.from(bytes));
  return { bytes: new Uint8Array(wav), mediaType: "audio/wav" };
}

/** What a sound file is, read from its first bytes: a service that ignores a format it was asked for is not believed. */
export function soundType(bytes: Uint8Array, fallback: string): string {
  const head = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
  if (head.startsWith("OggS")) return "audio/ogg";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WAVE") return "audio/wav";
  if (head.startsWith("ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
  return fallback;
}

/** Whether a sound is already what a voice bubble needs. */
export const isOggOpus = (mediaType: string): boolean => /^audio\/(?:ogg|opus)\b/i.test(mediaType);

/** ffmpeg's arguments for one-channel OGG/Opus at a voice bitrate (ffmpeg's .ogg default is Vorbis, which bubbles refuse). */
export function oggOpusArgs(input: string, output: string): string[] {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "48000",
    "-c:a", "libopus", "-b:a", "32k", "-application", "voip", output];
}

type Runner = (file: string, args: string[], signal?: AbortSignal) => Promise<string>;

/**
 * The sound as OGG/Opus, converted by this computer's ffmpeg in a private folder that is removed afterwards. With no
 * ffmpeg, or a conversion that fails, the sound is handed back unchanged, so the app sends it as an audio file instead.
 */
export async function toOggOpus(audio: { bytes: Uint8Array; mediaType: string }, ffmpeg: string | null, run: Runner,
  signal?: AbortSignal): Promise<{ bytes: Uint8Array; mediaType: string }> {
  if (isOggOpus(audio.mediaType) || !ffmpeg) return audio;
  const folder = await mkdtemp(join(tmpdir(), "branch-voice-note-"));
  try {
    const input = join(folder, "reply.audio"), output = join(folder, "reply.ogg");
    await writeFile(input, audio.bytes, { mode: 0o600 });
    await run(ffmpeg, oggOpusArgs(input, output), signal);
    const bytes = await readFile(output);
    return bytes.length ? { bytes: new Uint8Array(bytes), mediaType: "audio/ogg" } : audio;
  } catch {
    return audio;
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
