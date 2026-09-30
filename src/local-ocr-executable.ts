import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Only the owner's startup PATH can select these fixed programs; task input never supplies an executable. */
export async function localOcrExecutable(name: "tesseract" | "pdftoppm"): Promise<string> {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const path = Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  for (const entry of path.split(process.platform === "win32" ? ";" : ":")) {
    const folder = entry.trim().replace(/^"|"$/g, "");
    if (!isAbsolute(folder)) continue;
    const target = join(folder, name + suffix);
    if (await access(target, process.platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false)) return target;
  }
  throw new Error(`Local OCR needs an installed ${name} executable in an absolute directory on the owner's PATH`);
}
