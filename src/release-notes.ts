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

/** The notes for one version; a version the file has nothing for has no notes, never another version's. */
export function notesFor(version: string, file: ReleaseNotes = releaseNotesFile()): { version: string; date: string | null; items: Release["items"] } {
  const release = file.releases.find((entry) => entry.version === version);
  return { version, date: release?.date ?? null, items: release?.items ?? [] };
}
