import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The painted characters a Trunk can wear (the window's Look tab), read from the art Branch ships instead of listed by
 * hand, in the prototype's order (design/redesign/prototype.html LOOKS, then pass 17's LOOKS17):
 * every entry of public/art/agents/manifest-*.json by file name. Branch remains the logo only. The manifests name their files as the prototype
 * does ("assets/..."); the window serves the same files under /art/. A file that is not on disk is left out, so a
 * character with no loop for a state falls back to its idle loop, and one with no still is not offered at all.
 */
export interface Character {
  id: string;
  name: string;
  description: string;
  /** Its picture, under /art/. */
  still: string;
  /** Its loop for each state it acts out (idle, think, work, yay, …), under /art/. */
  states: Record<string, string>;
  /**
   * The smaller widths every one of its loops also comes in, smallest first: the same frames encoded at that many pixels
   * square, beside the loop as <name>.<width>.webm. The window plays the smallest one at least as wide as it draws the
   * face, so a 40px face doesn't decode a 300px video.
   */
  sizes: number[];
}

const art = fileURLToPath(new URL("../../public/art/", import.meta.url));
const ID = /^[a-z][a-z0-9-]{0,31}$/;
/** The widths a character's loops may also be encoded at (public/art/agents/<id>/<state>.<width>.webm). */
const WIDTHS = [96, 160, 300];
const FILE = /^assets\/([a-z0-9][a-z0-9/_.-]{0,120})$/;

/** A manifest's "assets/<file>" as the address the window loads it from, or null when it is not on disk. */
function served(file: unknown): string | null {
  const match = typeof file === "string" ? FILE.exec(file) : null;
  if (!match || match[1]!.includes("..") || !existsSync(`${art}${match[1]}`)) return null;
  return `/art/${match[1]}`;
}

function states(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [state, file] of Object.entries(list && typeof list === "object" ? list : {})) {
    const at = ID.test(state) ? served(file) : null;
    if (at) out[state] = at;
  }
  return out;
}

/** The widths every loop has a smaller encode at, on disk beside it. */
function sizes(loops: Record<string, string>): number[] {
  const files = Object.values(loops);
  return WIDTHS.filter((width) => files.every((file) => existsSync(`${art}${file.slice(5).replace(/\.webm$/, `.${width}.webm`)}`)));
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function read(): Character[] {
  const manifests = existsSync(`${art}agents`) ? readdirSync(`${art}agents`).filter((name) => /^manifest-[A-Za-z0-9]+\.json$/.test(name)).sort() : [];
  const entries = manifests.flatMap((name) => {
    const list = readJson(`${art}agents/${name}`);
    return Array.isArray(list) ? list : [];
  });
  const found = new Map<string, Character>();
  for (const entry of entries as Record<string, unknown>[]) {
    const id = String(entry?.id ?? ""), still = served(entry?.still), loops = states(entry?.states);
    if (!ID.test(id) || id === "branch" || found.has(id) || !still || !loops.idle) continue;
    const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 40) : "";
    const description = typeof entry.description === "string" ? entry.description.trim().slice(0, 200) : "";
    found.set(id, { id, name: name || id, description, still, states: loops, sizes: sizes(loops) });
  }
  return [...found.values()];
}

let catalogue: Character[] | undefined;
/** Every character, read from disk once. */
export function characters(): Character[] {
  catalogue ??= read();
  return catalogue;
}
