import { access, constants } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { FeatureModeSchema, mediaProgramsShipsAs, type FeatureMode } from "./feature-switches.js";
import { markChosen, sentKeys, shippedUnlessChosen } from "./ship-on.js";
import type { Store } from "./store.js";
import { findOnPath } from "./voice-tts.js";

/**
 * Bucket 17: the two video programs the owner may already have on this computer — ffmpeg, which
 * pulls still pictures and the sound out of a video, and yt-dlp, which saves a video or its
 * captions from a web page. Branch never downloads either one. This file only decides whether the
 * feature is on, where each program lives, and the exact argument list each call would use; the
 * arguments are pure so a test can read them without a program being installed.
 */
export const MediaProgramsSchema = z.object({
  /** The three-way switch. Read through `mediaProgramsSettings`, which gives how it ships ("when needed") unless the owner chose. */
  mode: FeatureModeSchema.default("off"),
  /** Where ffmpeg lives. Empty means "look for it on this computer's search path". */
  ffmpeg: z.string().trim().max(400).default(""),
  /** Where yt-dlp lives. Empty means "look for it on this computer's search path". */
  ytDlp: z.string().trim().max(400).default(""),
  /** How many still pictures are taken from one video (a model is shown at most four at a time). */
  frames: z.number().int().min(1).max(4).default(4),
  /** The largest file a download may save, in megabytes. */
  maxDownloadMb: z.number().int().min(1).max(2000).default(200),
}).strict();
export type MediaPrograms = z.infer<typeof MediaProgramsSchema>;

const settingsKey = "media-programs";
export function mediaProgramsSettings(store: Pick<Store, "get">, owner: string): MediaPrograms {
  const saved = MediaProgramsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  if (!saved.success) return MediaProgramsSchema.parse({});
  // The record also holds the programs' places, so an "off" beside them may be the old default (src/ship-on.ts).
  return shippedUnlessChosen(store, owner, settingsKey, saved.data, { mode: mediaProgramsShipsAs });
}
export function saveMediaProgramsSettings(store: Store, owner: string, input: unknown): MediaPrograms {
  const given = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const value = MediaProgramsSchema.parse({ ...mediaProgramsSettings(store, owner), ...given });
  for (const path of [value.ffmpeg, value.ytDlp])
    if (path && (!isAbsolute(path) || path.startsWith("-")))
      throw new Error("Give the full place of the program, for example /opt/homebrew/bin/ffmpeg");
  store.save("settings", owner, settingsKey, value);
  markChosen(store, owner, settingsKey, sentKeys(given));
  return value;
}
export const mediaProgramsMode = (store: Pick<Store, "get">, owner: string): FeatureMode =>
  mediaProgramsSettings(store, owner).mode;

/** The one sentence every video tool says while the switch is off. */
export const mediaProgramsOff =
  "Watching and saving videos is switched off. Turn it on under Settings → Models → Pictures and sound.";

/** Starts a program with an argument list (never a shell line) and hands back what it printed. */
export type ProgramRunner = (file: string, args: string[], signal?: AbortSignal) => Promise<string>;
export type ProgramFinder = (name: string) => string | null;

export type MediaProgram = "ffmpeg" | "yt-dlp";
const installHint: Record<MediaProgram, string> = {
  ffmpeg: "ffmpeg is not on this computer. Install it yourself (for example `brew install ffmpeg`), or give its full place in Settings.",
  "yt-dlp": "yt-dlp is not on this computer. Install it yourself (for example `brew install yt-dlp`), or give its full place in Settings.",
};

/** Where a program is, from the owner's own setting first and the search path second. */
export async function locateProgram(
  which: MediaProgram, settings: MediaPrograms, find: ProgramFinder = findOnPath, platform: string = process.platform,
): Promise<string> {
  const chosen = which === "ffmpeg" ? settings.ffmpeg : settings.ytDlp;
  if (chosen) {
    try {
      await access(chosen, constants.X_OK);
      return chosen;
    } catch {
      throw new Error(`The program set for ${which} (${chosen}) cannot be started. Check the place in Settings.`);
    }
  }
  const found = find(platform === "win32" ? `${which}.exe` : which);
  if (!found) throw new Error(installHint[which]);
  return found;
}

/* ---------- argument lists, pure ---------- */

const quiet = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
/**
 * Integrator fix: ffmpeg picks its reader from the file's contents, and a playlist (`.m3u8`) or a
 * similar list file makes it open other files named inside it — any video on this computer. Only
 * readers for ordinary video and sound files are allowed, and only plain files, before every `-i`.
 */
export const safeReaders = "mov,matroska,avi,wav,mp3,ogg,flac,aac,mpegts,mpeg,flv,asf,aiff,caf,amr";
const reading = (input: string): string[] =>
  ["-format_whitelist", safeReaders, "-protocol_whitelist", "file", "-i", input];
const knownEndings = new Set([".mp4", ".m4v", ".m4a", ".mov", ".3gp", ".webm", ".mkv", ".avi", ".wav", ".mp3",
  ".ogg", ".oga", ".ogv", ".opus", ".flac", ".aac", ".ts", ".mpg", ".mpeg", ".flv", ".wmv", ".wma", ".aif", ".aiff", ".caf", ".amr"]);
/** The ending the private copy of a file gets: a known video or sound ending, or `.bin`. */
export function scratchEnding(name: string): string {
  const dot = name.lastIndexOf(".");
  const ending = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return knownEndings.has(ending) ? ending : ".bin";
}

/**
 * Still pictures spread evenly across a video. With a known length the pictures are one every
 * `length / count` seconds; without one, one every ten seconds. Each is at most 768 pixels wide.
 */
export function frameArgs(input: string, outDir: string, count: number, seconds: number | null): string[] {
  const every = seconds && seconds > 0 ? seconds / count : 10;
  const rate = (1 / every).toFixed(6);
  return [...quiet, ...reading(input), "-vf", `fps=${rate},scale='min(768,iw)':-2`, "-frames:v", String(count),
    "-q:v", "4", join(outDir, "frame-%02d.jpg")];
}
/** The sound of a video as a small WAV file a speech service can read. */
export function soundTrackArgs(input: string, output: string): string[] {
  return [...quiet, ...reading(input), "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", output];
}
/** Any sound or video turned into a WAV or MP3 sound file. */
export function convertArgs(input: string, output: string, to: "wav" | "mp3"): string[] {
  const codec = to === "mp3" ? ["-codec:a", "libmp3lame", "-q:a", "4"] : ["-codec:a", "pcm_s16le"];
  return [...quiet, ...reading(input), "-vn", ...codec, "-f", to, output];
}

/**
 * What every yt-dlp call starts with. `--ignore-config`: no settings file on this computer can add
 * a command to run afterwards. `--no-plugin-dirs`: no plug-in from the owner's home or Python
 * folders is loaded. `--no-remote-components`: no code is fetched from the web. `--no-cache-dir`:
 * nothing is written outside the private folder. `default,-generic`: only the site readers yt-dlp
 * ships, never the catch-all that follows any page to wherever it points. (Integrator fix.)
 */
const ytDlpBase = ["--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--no-cache-dir",
  "--use-extractors", "default,-generic", "--no-playlist", "--no-progress"];
/** yt-dlp saving one video (or only its sound). `--` means the address can never be read as an option. */
export function downloadArgs(url: string, outDir: string, options: { soundOnly: boolean; maxMb: number; ffmpeg: string | null }): string[] {
  const shape = options.soundOnly ? ["-x", "--audio-format", "mp3"] : ["-f", "mp4/best[ext=mp4]/best"];
  return [...ytDlpBase, "--restrict-filenames",
    "--max-filesize", `${options.maxMb}M`, "-P", outDir, "-o", "%(title).60s-%(id)s.%(ext)s",
    ...(options.ffmpeg ? ["--ffmpeg-location", options.ffmpeg] : []), ...shape, "--", url];
}
/** yt-dlp saving only the captions of a video, written or made by the site, in one language. */
export function captionArgs(url: string, outDir: string, language: string): string[] {
  return [...ytDlpBase, "--skip-download", "--write-subs",
    "--write-auto-subs", "--sub-langs", `${language}.*,${language}`, "--sub-format", "vtt",
    "-P", outDir, "-o", "captions", "--", url];
}

/** Only an ordinary web address may be handed to yt-dlp. */
export function webAddress(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("That is not a web address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https addresses can be saved");
  if (url.username || url.password) throw new Error("An address with a name or password in it is not accepted");
  return url;
}

/* ---------- captions ---------- */

export interface CaptionLine { start: number; end: number; text: string }
const stamp = (value: string): number => {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
};
/**
 * The lines of a WebVTT caption file. Captions a site makes itself repeat each line as the next
 * one rolls in, so a line identical to the one before it is dropped, and styling tags are removed.
 */
export function parseVtt(text: string, limit = 2000): CaptionLine[] {
  const lines: CaptionLine[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n\n+/)) {
    const rows = block.split("\n");
    const at = rows.findIndex((row) => row.includes("-->"));
    if (at < 0) continue;
    const [from, to] = rows[at]!.split("-->");
    const start = stamp(from ?? "0"), end = stamp((to ?? "").trim().split(" ")[0] ?? "0");
    const seen = new Set(lines.slice(-3).map((line) => line.text));
    for (const row of rows.slice(at + 1)) {
      const words = row.replace(/<[^>]*>/g, "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
        .replace(/\s+/g, " ").trim();
      if (!words || seen.has(words)) continue;
      seen.add(words);
      lines.push({ start, end, text: words });
    }
    if (lines.length >= limit) return lines.slice(0, limit);
  }
  return lines;
}
