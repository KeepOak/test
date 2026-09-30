import { opendir } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { z } from "zod";
import { HttpError } from "./server-http.js";

const choice = z.object({ directory: z.string().trim().min(1).max(400).refine(path => !/[\x00-\x1f]/.test(path)), kind: z.enum(["executable", "model"]) }).strict();

/** Owner-requested directory listing only; never reads file contents or invokes Piper. */
export async function piperFiles(input: unknown) {
  const { directory, kind } = choice.parse(input);
  if (!isAbsolute(directory)) throw new HttpError(400, "Enter an absolute directory on the computer running Branch.");
  try {
    const entries: { name: string; path: string; directory: boolean }[] = [];
    let scanned = 0, truncated = false;
    for await (const entry of await opendir(directory)) {
      if (++scanned > 2000 || entries.length >= 200) { truncated = true; break; }
      if (entry.isDirectory() || entry.isFile() && (kind === "executable" || entry.name.toLowerCase().endsWith(".onnx"))) {
        entries.push({ name: entry.name, path: join(directory, entry.name), directory: entry.isDirectory() });
      }
    }
    entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { directory, parent: dirname(directory), truncated, entries };
  } catch { throw new HttpError(400, "That directory cannot be listed on the computer running Branch."); }
}
