import { createHmac, randomBytes } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The fingerprint every approval question carries, and that a yes is bound to: the tool the question is about and the
 * exact bytes it asks for, as a keyed digest. The key is made once for each install and kept in a private file in the
 * data folder, so nobody outside the engine can work out the fingerprint of a request they were not shown, the same
 * bytes sent to two different tools are two different questions, and a question kept across a restart (a paused
 * workflow's or flow's, a conversation's carried yes) is still the same question when Branch starts again.
 *
 * Until an install's key is loaded (code that never starts Branch), a key made at load stands in for it.
 */
let key: Buffer = randomBytes(32);

/** The key file's name in the data folder. No tool may read it (src/never-break/protected.ts). */
export const fingerprintKeyFile = "question-fingerprint.key";

async function readKey(path: string): Promise<Buffer | null> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("The question key must not be a link");
    const saved = await readFile(path);
    if (saved.length === 32) return saved;
    // QA retest 2026-09-28 (TRUNK-180): a damaged key used to stop every start ("move it aside to start a new one") and
    // left the gateway restarting the engine until it gave up. It is put aside here and a new key made: a question
    // asked under the old key is then a new question, so a yes carried across the restart is asked for again, never
    // taken as given.
    const aside = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(path, aside);
    console.error(`The question key file was damaged; it was put aside as ${aside} and a new one made. Questions waiting for a yes will be asked again.`);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Loads this install's key from the data folder, making it (readable by the owner only) the first time. */
export async function useFingerprintKey(dataDir: string): Promise<void> {
  const path = join(dataDir, fingerprintKeyFile);
  const saved = await readKey(path);
  if (saved) { key = saved; return; }
  const fresh = randomBytes(32);
  try { await writeFile(path, fresh, { mode: 0o600, flag: "wx" }); key = fresh; }
  catch (error) {
    // Another start made it first: use that one.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const made = await readKey(path);
    if (!made) throw error;
    key = made;
  }
}

/**
 * The fingerprint of `argumentBytes` asked of `tool`: 32 hex characters.
 *
 * Bytes that are JSON are read first and written back with their keys in order and no spacing, because a tool is run
 * on what the JSON says, not on how it was spelled. A model that is told to make the call it was allowed "again,
 * exactly as before" and sends the same object with its keys in another order (local models do) is making the very
 * same request, and a yes given for it must cover it; any change to a key or a value is still a new question. Bytes
 * that are not JSON are kept exactly as they came.
 */
export function argumentFingerprint(tool: string, argumentBytes: string): string {
  return createHmac("sha256", key).update(`${tool}\u0000${sameRequest(argumentBytes)}`, "utf8").digest("hex").slice(0, 32);
}

/** JSON bytes written one way whatever order their keys came in; anything else unchanged. */
function sameRequest(argumentBytes: string): string {
  // Too deep to write back (a call built to be) is kept exactly, as bytes that are not JSON are.
  try { return ordered(JSON.parse(argumentBytes)); } catch { return argumentBytes; }
}
function ordered(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(ordered).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, inner]) => `${JSON.stringify(name)}:${ordered(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
