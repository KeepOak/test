import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { BrowserContext } from 'playwright';

/**
 * A recording of everything the browser did during one task, kept as a single file the owner can
 * open in Playwright's own viewer. It is off unless the owner asks for it.
 *
 * What is recorded, and what deliberately is not: the steps taken and a picture of the window at
 * each one are kept, because that is what makes a recording worth having. A copy of the page's own
 * markup is *not*, because a password box carries its value in the markup even when the box looks
 * blacked out on screen. Password boxes are blacked out before any picture is taken, and Branch
 * refuses to type into one at all, so no password ever reaches a step either.
 */
export const traceOptions = { screenshots: true, snapshots: false, sources: false } as const;

/*
 * While a recording is being made, every box page text leaves out (passwords and one-time codes) is emptied before each
 * step, because the recorder writes down a description of whatever a step points at or reads, and that carries a box's
 * contents with it, blacked out on screen or not (clearSecretValues, src/integrations/browser-page.ts).
 */

/** One recording, while it is being made. */
export interface BrowserRecording {
  stop(): Promise<Buffer>;
  cancel(): Promise<void>;
}

/** Starts recording this task's browser window. */
export async function startRecording(context: BrowserContext): Promise<BrowserRecording> {
  await context.tracing.start({ ...traceOptions });
  const path = join(tmpdir(), `branch-trace-${randomUUID()}.zip`);
  let done = false;
  return {
    async stop() {
      if (done) throw new Error('That recording has already been kept');
      done = true;
      await context.tracing.stop({ path });
      try { return await readFile(path); } finally { await rm(path, { force: true }); }
    },
    async cancel() {
      if (done) return;
      done = true;
      await context.tracing.stop().catch(() => undefined);
      await rm(path, { force: true });
    },
  };
}

/**
 * Reads the files inside a recording without unpacking it to disk. Used by the checks that prove a
 * recording holds no password and no key; a search of the packed bytes would prove nothing,
 * because everything inside is squashed.
 */
export function recordingEntries(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('That is not a recording file');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    const method = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const localName = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const raw = bytes.subarray(start, start + size);
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Every readable word inside a recording, for the checks that prove nothing secret got in. */
export function recordingText(bytes: Buffer): string {
  let text = '';
  for (const [name, entry] of recordingEntries(bytes))
    if (!/\.(jpe?g|png|webp)$/i.test(name)) text += '\n' + entry.toString('utf8');
  return text;
}

/**
 * Whether any of these words got into a recording. This is the check that proves the emptying of
 * password boxes really works; it is run by the tests, not on the way out, because at the moment a
 * recording is kept there is no list of the owner's secrets to compare it against.
 */
export function leaksIn(bytes: Buffer, secrets: readonly string[]): string[] {
  const text = recordingText(bytes);
  return secrets.filter(secret => secret.length >= 6 && text.includes(secret));
}
