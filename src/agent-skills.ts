import { parseSkillDocument } from "./skill-document.js";
import { packSkill, zipRead, zipWrite, type ZipLimits } from "./skill-package.js";

/**
 * Bucket 12 (A0776): skills in the open Agent Skills layout (agentskills.io), the folder other
 * agents share: `<name>/SKILL.md` with `name` and `description` in its front matter, and optional
 * `references/`, `scripts/` and `assets/` folders beside it.
 *
 * Reading one turns it into an ordinary Branch skill package, so it goes through the same preview,
 * scan and "arrives switched off" path as every other package (src/skill-packages.ts):
 * - the front matter must meet the Agent Skills rules, which `parseSkillDocument` already checks
 *   (lowercase name with single dashes, at most 64 long; description up to 1024), and the name must
 *   match the folder it sits in, as the layout requires;
 * - text references stay separate and are loaded through skills.read_file when a task needs them;
 * - programs in `scripts/` and files in `assets/` are left out and named, never run or unpacked.
 *
 * Writing one does the opposite, so a skill made here can be used by any agent that reads the layout.
 */
export const agentSkillLimits: ZipLimits = { entries: 64, entryBytes: 128 * 1024, totalBytes: 512 * 1024 };
const segment = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,99}$/;
const maxNotes = 12;

export interface AgentSkillFolder {
  name: string;
  /** The folder SKILL.md sat in, or null when it was at the top of the file. */
  folder: string | null;
  /** The original SKILL.md, without inlined references. */
  document: string;
  /** Text references kept with the package, by their package file name. */
  notes: Record<string, string>;
  leftOut: { path: string; why: string }[];
}

/** Which names may be read at all: plain relative paths, no folders of their own, no system clutter. */
function acceptName(name: string): boolean {
  if (name.endsWith("/") || name.startsWith("__MACOSX/") || name.split("/").pop() === ".DS_Store") return false;
  const parts = name.split("/");
  if (parts.length > 4 || name.includes("\\") || !parts.every((part) => segment.test(part) && part !== "." && part !== ".."))
    throw new Error(`${name} is not a plain file name inside the skill folder, so the file was not opened`);
  return true;
}

function findSkillFile(paths: string[]): string {
  const found = paths.filter((path) => path === "SKILL.md" || /^[^/]+\/SKILL\.md$/.test(path));
  if (!found.length) throw new Error("This file holds no SKILL.md, at the top or in one folder, so it is not an Agent Skills folder");
  if (found.length > 1) throw new Error("This file holds more than one skill; give Branch one skill folder at a time");
  return found[0]!;
}

/** What happens to one file beside SKILL.md. */
function sortFile(relative: string): { note: string } | { why: string } {
  if (/^references\/[^/]+\.(md|markdown|txt)$/i.test(relative)) return { note: relative.slice("references/".length) };
  if (relative.startsWith("scripts/")) return { why: "Branch does not run a skill's own programs; the assistant uses its own tools under your approval rules" };
  if (relative.startsWith("assets/")) return { why: "Branch keeps a skill's instructions and text references only" };
  return { why: "not part of the Agent Skills layout (SKILL.md, references, scripts, assets)" };
}

function noteName(file: string, taken: Record<string, string>): string | null {
  const base = `reference-${file.replace(/\.(md|markdown|txt)$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40)}.md`;
  return base in taken || base.includes("..") ? null : base;
}

/** Opens an Agent Skills folder handed over as a zip file. Nothing is installed by reading it. */
export function readAgentSkill(bytes: Buffer): AgentSkillFolder {
  const entries = zipRead(bytes, agentSkillLimits, acceptName);
  const skillPath = findSkillFile([...entries.keys()]);
  const folder = skillPath.includes("/") ? skillPath.split("/")[0]! : null;
  const original = entries.get(skillPath)!;
  const metadata = parseSkillDocument(original);
  if (folder && metadata.name !== folder)
    throw new Error(`The skill is called "${metadata.name}" but sits in the folder "${folder}"; Agent Skills needs the two to match`);
  const notes: Record<string, string> = {}, leftOut: AgentSkillFolder["leftOut"] = [];
  for (const [path, text] of entries) {
    if (path === skillPath) continue;
    if (folder && !path.startsWith(`${folder}/`)) { leftOut.push({ path, why: "outside the skill's folder" }); continue; }
    const sorted = sortFile(folder ? path.slice(folder.length + 1) : path);
    if ("why" in sorted) { leftOut.push({ path, why: sorted.why }); continue; }
    const name = Object.keys(notes).length < maxNotes ? noteName(sorted.note, notes) : null;
    if (!name) { leftOut.push({ path, why: `at most ${maxNotes} text references with distinct names are kept` }); continue; }
    notes[name] = text;
  }
  return { name: metadata.name, folder, document: original, notes, leftOut };
}

/** The same skill as a Branch skill package, ready for the usual preview and install. */
export function agentSkillPackage(folder: AgentSkillFolder, author = "An Agent Skills folder"): Buffer {
  const declared = parseSkillDocument(folder.document).metadata?.version ?? "";
  const packageVersion = /^\d+\.\d+\.\d+$/.test(declared) ? declared : "1.0.0";
  return packSkill({ files: { "SKILL.md": folder.document, ...folder.notes }, author, packageVersion });
}

/**
 * Writes a skill in the Agent Skills layout: `<name>/SKILL.md`, and each kept text reference back
 * under `<name>/references/`, taken back out of the instructions they were added to.
 */
export function writeAgentSkill(document: string, notes: Record<string, string> = {}): { filename: string; base64: string } {
  const { name } = parseSkillDocument(document);
  const kept = Object.entries(notes).filter(([file]) => /^reference-[A-Za-z0-9._-]+\.md$/.test(file));
  // A reference added to the instructions on the way in goes back to its own file only, so reading
  // the folder again does not add it twice.
  let instructions = document;
  for (const [file, text] of kept) instructions = instructions.replace(`\n\n## Reference: ${file.slice("reference-".length)}\n\n${text.trim()}`, "");
  const entries: [string, string][] = [[`${name}/SKILL.md`, instructions]];
  for (const [file, text] of kept) entries.push([`${name}/references/${file.slice("reference-".length)}`, text]);
  return { filename: `${name}.zip`, base64: zipWrite(entries).toString("base64") };
}
