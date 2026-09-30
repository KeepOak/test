import { spawn } from "node:child_process";
import { join } from "node:path";
import { ocrInput, checkOcrPixels } from "./local-ocr-input.js";
import { localOcrExecutable } from "./local-ocr-executable.js";

/** One page at a time, with a fixed output name in a private folder and a bounded raster size. */
export async function rasterOcrPage(root: string, page: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const executable = await localOcrExecutable("pdftoppm");
  signal.throwIfAborted();
  const prefix = join(root, "page");
  await new Promise<void>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"])
      if (process.env[name]) env[name] = process.env[name];
    const child = spawn(executable, ["-f", String(page), "-l", String(page), "-singlefile", "-scale-to", "2048",
      "-png", join(root, "input.pdf"), prefix], { cwd: root, env, stdio: "ignore", windowsHide: true });
    let failed: string | null = null;
    const stop = (why: string) => { failed = why; child.kill("SIGKILL"); };
    const abort = () => stop("PDF OCR was cancelled");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop("PDF page rasterization exceeded 15 seconds"), 15_000);
    child.once("error", () => { clearTimeout(timer); signal.removeEventListener("abort", abort);
      reject(new Error("Scanned PDF OCR needs locally installed Poppler pdftoppm on PATH")); });
    child.once("close", (code) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (failed || code !== 0) reject(new Error(failed ?? "PDF page could not be rendered; it may be locked, damaged or outside the page range"));
      else resolve();
    });
  });
  const image = await ocrInput(`${prefix}.png`, 8 * 1024 * 1024, signal);
  checkOcrPixels(image);
  return image;
}
