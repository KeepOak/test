import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { readDocument, readerByteLimit } from "./document-readers.js";

/**
 * attach-anything: one document read, off the engine's own thread (src/attachment-reading.ts `readInWorker`).
 * The readers are pure JavaScript and can walk a shaped file for a long time; here they hold up nothing but
 * this worker, which the engine ends at its time limit. It reads the one path it is given and answers once.
 */
const { path, name } = workerData as { path: string; name: string };
try {
  const document = readDocument(await readFile(path), name, { byteLimit: readerByteLimit });
  parentPort?.postMessage({ ok: true, text: document.text, notes: document.limits });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: String((error as Error)?.message ?? error).slice(0, 300) });
}
