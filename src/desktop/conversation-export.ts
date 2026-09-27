import { writeFile } from 'node:fs/promises';
import { archiveBodyLimit, parseConversationArchive } from '../session-library.js';
import { maximumMemoryArchiveBytes, parseMemoryArchive } from '../memory.js';
import { maximumBackupBytes, parseBackupArchive } from "../backup.js";
import { exportedMemoryLines, maximumImportBytes } from "../memory-export.js";

export async function saveConversationExport(
  input: unknown,
  choosePath: () => Promise<string | undefined>,
): Promise<{ saved: boolean }> {
  return saveArchive(input, choosePath, archiveBodyLimit, parseConversationArchive);
}

export async function saveBackupExport(
  input: unknown,
  choosePath: () => Promise<string | undefined>,
): Promise<{ saved: boolean }> {
  return saveArchive(input, choosePath, maximumBackupBytes, parseBackupArchive);
}

export async function saveMemoryExport(
  input: unknown,
  choosePath: () => Promise<string | undefined>,
): Promise<{ saved: boolean }> {
  return saveArchive(input, choosePath, maximumMemoryArchiveBytes, parseMemoryArchive);
}

/**
 * rw4: Library › Memory's "Export what it remembers" (JSON Lines). The text is checked line by line before the Save
 * dialog opens, and only the facts as read back are written.
 */
export async function saveMemoryLinesExport(
  input: unknown,
  choosePath: () => Promise<string | undefined>,
): Promise<{ saved: boolean }> {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > maximumImportBytes)
    throw new Error(`Memory export must be JSON Lines text of at most ${maximumImportBytes / 1024 / 1024} MiB`);
  const text = exportedMemoryLines(input);
  const path = await choosePath();
  if (!path) return { saved: false };
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 });
  return { saved: true };
}

async function saveArchive(
  input: unknown, choosePath: () => Promise<string | undefined>,
  maximumBytes: number, parse: (input: unknown) => unknown,
): Promise<{ saved: boolean }> {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > maximumBytes)
    throw new Error(`Archive export must be JSON text of at most ${maximumBytes / 1024 / 1024} MiB`);
  const archive = parse(JSON.parse(input));
  const text = JSON.stringify(archive);
  const path = await choosePath();
  if (!path) return { saved: false };
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 });
  return { saved: true };
}
