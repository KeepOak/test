import { createHmac, randomBytes } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
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
    if (saved.length !== 32) throw new Error("The question key file is damaged; move it aside to start a new one");
    return saved;
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

/** The fingerprint of `argumentBytes` asked of `tool`: 32 hex characters. */
export function argumentFingerprint(tool: string, argumentBytes: string): string {
  return createHmac("sha256", key).update(`${tool}\u0000${argumentBytes}`, "utf8").digest("hex").slice(0, 32);
}
