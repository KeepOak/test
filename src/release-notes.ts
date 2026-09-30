/**
 * What's new: the notes for the installed version, read from `data/release-notes.json`, which ships with the build
 * (scripts/copy-data.mjs copies it beside the program). Each note is a line of plain words and, where it has one, the
 * window action that opens the place it talks about. Nothing is fetched: the notes are the ones this build carries.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

const words = (max: number) => z.string().trim().min(1).max(max);
const NoteSchema = z.object({
  icon: z.string().regex(/^[a-z0-9]{1,20}$/),
  title: words(80),
  text: words(400),
  /** The window action a row opens, by its name in the design's list of actions; the window runs it only when live. */
  act: z.string().regex(/^[a-z0-9-]{1,30}$/),
  data: z.record(z.string().regex(/^[a-z]{1,12}$/), z.string().regex(/^[a-z0-9-]{1,40}$/)).default({}),
  /** Which part of the release notes it is listed under: something new, something better, or something fixed. */
  group: z.enum(["new", "better", "fixed"]).default("new"),
}).strict();
const ReleaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(NoteSchema).min(1).max(16),
}).strict();
export const ReleaseNotesSchema = z.object({ format: z.literal(1), releases: z.array(ReleaseSchema).max(100) }).strict();
export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;
export type Release = z.infer<typeof ReleaseSchema>;

const bundled = [new URL("./release-notes.json", import.meta.url), new URL("../data/release-notes.json", import.meta.url)];
let loaded: ReleaseNotes | undefined;

/** The notes file, read once and checked; a damaged file fails loudly rather than showing half of it. */
export function releaseNotesFile(): ReleaseNotes {
  if (loaded) return loaded;
  for (const source of bundled) {
    let text: string;
    try { text = readFileSync(source, "utf8"); } catch { continue; }
    return (loaded = ReleaseNotesSchema.parse(JSON.parse(text) as unknown));
  }
  throw new Error("The release notes (release-notes.json) are missing from this installation");
}

/** A version's three numbers; a pre-release ("0.19.4-dev.1790479535-g…") comes before its own release. */
const numbers = (version: string): [number, number, number] | null => {
  const found = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null;
};
const before = (a: readonly number[], b: readonly number[]): boolean => a[0]! !== b[0]! ? a[0]! < b[0]! : a[1]! !== b[1]! ? a[1]! < b[1]! : a[2]! < b[2]!;

/**
 * The notes for the installed version: its own, or, for a build the file has no entry for (a dev build between two
 * releases, dogfood D26's empty What's new), the newest release this build already contains, named as that release so
 * the window says whose notes they are. A build older than every release in the file has none.
 */
export function notesFor(version: string, file: ReleaseNotes = releaseNotesFile()): { version: string; installedVersion: string; date: string | null; items: Release["items"] } {
  const own = file.releases.find((entry) => entry.version === version);
  if (own) return { version, installedVersion: version, date: own.date, items: own.items };
  const installed = numbers(version);
  const preRelease = /^\d+\.\d+\.\d+-/.test(version);
  const contained = installed ? file.releases.filter((entry) => {
    const release = numbers(entry.version)!;
    return before(release, installed) || (!preRelease && !before(installed, release));
  }) : [];
  const newest = contained.sort((a, b) => (before(numbers(a.version)!, numbers(b.version)!) ? 1 : -1))[0];
  return newest ? { version: newest.version, installedVersion: version, date: newest.date, items: newest.items } : { version, installedVersion: version, date: null, items: [] };
}
