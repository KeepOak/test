import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { localOcrExecutable } from "./local-ocr-executable.js";

export type ReadScreenText = (image: Uint8Array, signal?: AbortSignal) => Promise<string>;

/** Optional local OCR: image bytes use stdin, recognized words use stdout; neither needs an image file. */
export const readScreenText: ReadScreenText = async (image, signal) => {
  signal?.throwIfAborted();
  if (!image.length || image.length > 8 * 1024 * 1024) throw new Error("Screen OCR image exceeds its 8 MiB limit");
  const executable = await localOcrExecutable("tesseract");
  signal?.throwIfAborted();
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TESSDATA_PREFIX"])
    if (process.env[name]) env[name] = process.env[name];
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ["stdin", "stdout", "-l", "eng", "--psm", "6"],
      { env, cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", bytes = 0, failure: string | null = null;
    const stop = (why: string) => { failure = why; child.kill("SIGKILL"); };
    const abort = () => stop("Screen OCR was cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop("Screen OCR exceeded 15 seconds"), 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 32 * 1024) stop("Screen OCR output exceeds 32 KiB");
      else output += chunk;
    });
    // Diagnostics can contain recognized content; drain them without retaining or exposing them.
    child.stderr.resume();
    child.stdin.on("error", () => stop("Screen OCR could not read the captured image"));
    child.once("error", () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("Screen OCR needs a locally installed Tesseract executable on PATH and English language data")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(new Error(failure ?? "Screen OCR failed; check the local Tesseract installation"));
      else resolve(output.replace(/\r/g, "").trim().slice(0, 4096));
    });
    child.stdin.end(image);
  });
};

export function textDifference(before: string | undefined, after: string): string {
  if (before === undefined) return "OCR baseline established; earlier text was not retained across a restart.";
  if (before === after) return "OCR found no text change in the changed picture.";
  const lines = (text: string) => new Set(text.split("\n").map((line) => line.trim()).filter(Boolean));
  const old = lines(before), now = lines(after);
  const removed = [...old].filter((line) => !now.has(line)).slice(0, 6);
  const added = [...now].filter((line) => !old.has(line)).slice(0, 6);
  return ["OCR text changed (recognition may be imperfect).", removed.length ? `Before: ${removed.join(" | ")}` : "",
    added.length ? `After: ${added.join(" | ")}` : ""].filter(Boolean).join("\n").slice(0, 1600);
}
