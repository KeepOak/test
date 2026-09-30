import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { skillRequirements } from "./skill-metadata.js";

export interface SkillAvailability { available: boolean; reasons: string[] }
/** Search PATH as files only; checking a requirement starts no program and runs no installer. */
function programAvailable(name: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(name)) return false;
  const windows = process.platform === "win32";
  const endings = windows && !/\.(exe|cmd|bat|com)$/i.test(name) ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const folder of (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ending of endings) {
      const path = join(folder, name + ending);
      try { accessSync(path, windows ? constants.F_OK : constants.X_OK); if (statSync(path).isFile()) return true; } catch { /* Keep searching. */ }
    }
  }
  return false;
}
const platformName = (name: string): string => ({ windows: "win32", macos: "darwin", mac: "darwin", osx: "darwin" }[name.toLowerCase()] ?? name.toLowerCase());

export function skillAvailability(metadata: Record<string, string> = {}): SkillAvailability {
  const required = skillRequirements(metadata), reasons: string[] = [];
  for (const allowed of required.os) {
    if (!allowed.some(name => platformName(name) === process.platform || ["all", "any", "*"].includes(name.toLowerCase())))
      reasons.push(`Requires ${allowed.join(" or ")}`);
  }
  const missing = required.bins.filter(name => !programAvailable(name));
  if (missing.length) reasons.push(`Missing programs: ${missing.join(", ")}`);
  if (required.anyBins.length && !required.anyBins.some(programAvailable)) reasons.push(`Requires one of: ${required.anyBins.join(", ")}`);
  return { available: reasons.length === 0, reasons };
}
