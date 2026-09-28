import { isAbsolute, resolve } from "node:path";

/**
 * A task never wipes the workspace. Deleting everything in it cannot be undone, so the engine refuses the calls that
 * would do it, whatever the model is and whatever the rules say: moving files to a null device (which deletes them),
 * moving the workspace itself, and a recursive delete (or `find … -delete`) aimed at the whole workspace. The task then stops and says
 * plainly that nothing was deleted (`wipeQuestion`), so the answer never depends on how well the model relays it.
 * Deleting named files the person asked about is not this: those calls name what they touch and go through the rules.
 */
export const wipeQuestion = "I haven't deleted anything. Deleting everything in your workspace can't be undone, so Branch won't do it as part of a task. "
  + "If you really want those files gone, delete them yourself, or tell me exactly which files to remove.";

const nullDevice = /^(?:\/dev\/null|nul:?|\\\\\.\\nul|\/dev\/zero)$/i;
const wholeWorkspace = /^(?:\.|\.\/|\.\\|\*|\.\/\*|\.\\\*|\/\*?|~\/?|\$?HOME\/?|%USERPROFILE%)$/i;
const deleteVerb = /^(?:rm|rmdir|del|erase|rd|remove-item|ri|shred|find)$/i;
const recursiveFlag = /^(?:-[a-z]*r[a-z]*|--recursive|\/s|-recurse)$/i;

/** Why this call would wipe the workspace, in a few words, or null. */
export function wipeAttempt(tool: string, args: unknown, workspace: string): string | null {
  if (tool === "files.move") return movesAway(args, workspace);
  if (/^(?:shell|terminal|code)\./.test(tool)) return deletesEverything(commandWords(args), workspace);
  return null;
}

function movesAway(args: unknown, workspace: string): string | null {
  const input = (args ?? {}) as { from?: unknown; to?: unknown; moves?: { from?: unknown; to?: unknown }[] };
  const pairs = Array.isArray(input.moves) ? input.moves : [{ from: input.from, to: input.to }];
  for (const pair of pairs) {
    const to = [pair.to].flat().map(String), from = [pair.from].flat().map(String);
    if (to.some((place) => nullDevice.test(place.trim()))) return "moving files to a null device, which deletes them";
    if (from.some((place) => isWholeWorkspace(place, workspace))) return "moving the whole workspace away";
  }
  return null;
}

function deletesEverything(words: string[], workspace: string): string | null {
  const verbAt = words.findIndex((word) => deleteVerb.test(word.replace(/\.exe$/i, "")));
  if (verbAt < 0) return null;
  const rest = words.slice(verbAt + 1);
  // `find <workspace> -delete` walks everything under it, as a recursive delete does.
  const finds = /^find$/i.test(words[verbAt]!.replace(/\.exe$/i, ""));
  const recursive = finds ? rest.includes("-delete") : rest.some((word) => recursiveFlag.test(word));
  const aimed = rest.some((word) => !word.startsWith("-") && isWholeWorkspace(word, workspace));
  return recursive && aimed ? "deleting everything in the workspace" : null;
}

function isWholeWorkspace(place: string, workspace: string): boolean {
  const text = place.trim().replace(/^["']|["']$/g, "");
  if (wholeWorkspace.test(text)) return true;
  if (!text) return false;
  const full = isAbsolute(text) ? resolve(text) : resolve(workspace, text);
  return full.replace(/[\\/]+$/, "").toLowerCase() === resolve(workspace).replace(/[\\/]+$/, "").toLowerCase();
}

/** The words of a command, however the tool takes it: an executable with its arguments, or one command line. */
function commandWords(args: unknown): string[] {
  const input = (args ?? {}) as { executable?: unknown; program?: unknown; args?: unknown; command?: unknown };
  const line = [input.executable, input.program].filter((part): part is string => typeof part === "string");
  const listed = Array.isArray(input.args) ? input.args.map(String) : [];
  const typed = typeof input.command === "string" ? input.command.split(/\s+/) : [];
  return [...line, ...listed, ...typed].filter(Boolean);
}
