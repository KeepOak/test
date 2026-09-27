import { rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { z } from "zod";
import { lineDiff } from "./workspace-history.js";
import { languageOf } from "./code-search.js";
import type { WorkspaceFiles, WriteObserver } from "./files.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { parsePatch, applyHunks, patchFileList, patchTargets } from "./patch.js";
import { replaceText } from "./text-replace.js";
import { bracketValidation, canCheckBrackets, typeScriptValidation } from "./code-syntax.js";
import { runAsNode } from "./child-env.js";

/**
 * Changing code precisely: applying a unified diff to one or more files, replacing an exact piece
 * of text, and checking afterwards that the file still reads as valid. A patch is all-or-nothing —
 * if any part of it does not fit the file exactly, nothing is written at all.
 */
export interface ChangeSummary { path: string; created: boolean; added: number; removed: number; diff: string }
/** One file's whole new text, worked out before anything is written. */
export interface PlannedChange { path: string; before: string | null; after: string }
const diffBudget = 20000;

export type PatchWatcher = (changed: ChangeSummary[], context: ToolContext) => void;

export class CodeEditor {
  /**
   * Told the moment a patch has gone in, with what it changed. A hook watching for patches hangs
   * off this: a file changing and a tool finishing are both already announced, and neither of them
   * says a patch was applied, which is the thing a review hook is actually waiting for.
   */
  onPatched: PatchWatcher = () => undefined;
  constructor(private readonly files: WorkspaceFiles, private readonly observer?: WriteObserver) {}

  /** The file's current text, or null when it does not exist yet. */
  private async original(path: string): Promise<string | null> {
    try {
      return (await this.files.read(path)).content;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (error instanceof Error && error.message.includes("32 KiB"))
        throw new Error(`"${path}" is larger than 32 KiB, which these tools cannot change`);
      throw error;
    }
  }

  /** Applies a whole unified diff or nothing at all. */
  async patch(text: string, context: ToolContext): Promise<{ files: ChangeSummary[] }> {
    const changed = await this.writeAll(await this.planPatch(text), context, { readFirst: true });
    this.notifyPatched(changed, context);
    return { files: changed };
  }
  /** Says a patch has gone in. Called by every way a patch reaches the files, and by nothing else. */
  notifyPatched(changed: ChangeSummary[], context: ToolContext): void {
    try { this.onPatched(changed, context); } catch { /* a watcher must never undo a good patch */ }
  }

  /**
   * Works out what a unified diff would do to every file it names, without writing anything. A
   * part that does not fit throws here, before a single file has been touched.
   */
  async planPatch(text: string): Promise<PlannedChange[]> {
    const planned: PlannedChange[] = [];
    for (const file of parsePatch(text)) {
      const before = await this.original(file.path);
      if (file.created && before !== null)
        throw new Error(`Patch refused: "${file.path}" already exists but the patch creates it`);
      planned.push({ path: file.path, before, after: applyHunks(file, before) });
    }
    return planned;
  }

  /** What a planned set of changes looks like written down, with nothing written. */
  preview(planned: PlannedChange[]): ChangeSummary[] {
    const summaries: ChangeSummary[] = [];
    for (const item of planned) summaries.push(summarise(item.path, item.before, item.after, summaries));
    return summaries;
  }

  /**
   * mac7/coding-next: refuses a change to an existing file this task has not read as it is now, when
   * the owner's read-before-edit switch is on. Checked for every file before any file is written.
   */
  async mustHaveRead(paths: string[], context: ToolContext): Promise<void> {
    const guard = this.files.readFirst;
    // With the switch off nothing is looked at, so every refusal is exactly what it was before.
    if (context.readFirstExempt || !guard?.holds(context.runId)) return;
    for (const path of paths) await guard.require(context.runId, await this.files.checked(path), path);
  }

  /**
   * Writes every planned file; a failure part-way puts the files already written back as they were.
   * `readFirst` holds the change to the read-before-edit rule (the model's own edits and patches,
   * and since hardening-3 a language server's rename too).
   */
  async writeAll(
    planned: PlannedChange[],
    context: ToolContext,
    options: { readFirst?: boolean } = {},
  ): Promise<ChangeSummary[]> {
    if (options.readFirst) await this.mustHaveRead(planned.map((item) => item.path), context);
    const done: { path: string; before: string | null }[] = [];
    const summaries: ChangeSummary[] = [];
    try {
      for (const item of planned) {
        await this.save(item.path, item.after, context);
        done.push({ path: item.path, before: item.before });
        summaries.push(summarise(item.path, item.before, item.after, summaries));
      }
    } catch (error) {
      for (const item of done.reverse()) await this.undo(item.path, item.before);
      throw error;
    }
    return summaries;
  }

  private async undo(path: string, before: string | null): Promise<void> {
    try {
      if (before === null) await rm(await this.files.checked(path), { force: true });
      else await this.files.write(path, before, AbortSignal.timeout(10000));
    } catch { /* The rollback is best effort; the original failure is what the caller sees. */ }
  }

  private async save(path: string, content: string, context: ToolContext): Promise<void> {
    const token = this.observer ? await this.observer.before(path, context) : undefined;
    await this.files.write(path, content, context.signal);
    this.files.readFirst?.noteWritten(context.runId, this.files.addressOf(path)); // mac7/coding-next
    if (this.observer) await this.observer.after(path, context, token);
  }

  /**
   * Replaces a piece of text; refuses when the number of matches is not what was expected. Exact
   * text first; only when it is nowhere in the file, whole lines that differ by whitespace alone.
   */
  async edit(
    input: { path: string; find: string; replace: string; expectedOccurrences: number; replaceAll?: boolean },
    context: ToolContext,
  ): Promise<ChangeSummary & { matched?: string }> {
    const existing = await this.original(input.path);
    // An empty `find` on a file that is not there yet creates it, as other agents' edit tools do.
    if (existing === null && input.find !== "") throw new Error(`Edit refused: "${input.path}" does not exist`);
    if (existing !== null) await this.mustHaveRead([input.path], context); // mac7/coding-next
    const before = existing ?? "";
    const result = replaceText(before, input.find, input.replace, input.replaceAll ? "all" : input.expectedOccurrences, `Edit refused: "${input.path}"`);
    await this.save(input.path, result.after, context);
    const summary = summarise(input.path, existing, result.after, []);
    return result.tolerant ? { ...summary, matched: `ignoring ${result.tolerant}` } : summary;
  }
}

function summarise(path: string, before: string | null, after: string, sofar: ChangeSummary[]): ChangeSummary {
  const { added, removed, diff } = lineDiff(before ?? "", after);
  const used = sofar.reduce((total, item) => total + item.diff.length, 0);
  return {
    path, created: before === null, added, removed,
    diff: used + diff.length > diffBudget ? "(change too large to show here)" : diff,
  };
}

export interface ValidationProblem { message: string; line?: number }
export interface Validation {
  path: string; language: string; checked: boolean; ok: boolean;
  problems: ValidationProblem[]; note?: string;
}

/** Reports whether a file still reads as valid. Problems come back as data, never as a failure. */
export async function validateFile(files: WorkspaceFiles, path: string): Promise<Validation> {
  const language = languageOf(path);
  const absolute = await files.checked(path);
  if (!(await stat(absolute)).isFile()) throw new Error(`"${path}" is not a file`);
  if (language === "JSON") return jsonValidation(path, (await files.read(path)).content);
  if (/\.(m|c)?js$/i.test(path)) return scriptValidation(path, absolute);
  // bucket-18 (A0537): TypeScript through Node's type stripper, other languages by bracket pairing.
  if (/\.(m|c)?ts$/i.test(path)) return typeScriptValidation(path, (await files.read(path)).content);
  if (/\.tsx$/i.test(path)) return { ...bracketValidation(path, (await files.read(path)).content, language),
    note: "Only brackets were checked: a full check of TSX needs the TypeScript compiler, which this app does not carry at run time." };
  if (canCheckBrackets(path)) return bracketValidation(path, (await files.read(path)).content, language);
  return { path, language, checked: false, ok: true, problems: [], note: `There is no built-in check for ${language} files.` };
}

function jsonValidation(path: string, content: string): Validation {
  try {
    JSON.parse(content);
    return { path, language: "JSON", checked: true, ok: true, problems: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = /line (\d+)/.exec(message)?.[1];
    return {
      path, language: "JSON", checked: true, ok: false,
      problems: [{ message, ...(line ? { line: Number(line) } : {}) }],
    };
  }
}

/**
 * Uses this app's own Node to check the file's syntax. `--check` parses the file and stops; it
 * never runs it. The host-command runner is not used: it needs a configured alias, refuses while
 * another command is running, and is meant for commands the owner chose.
 */
function scriptValidation(path: string, absolute: string): Promise<Validation> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--check", absolute], { timeout: 10000, windowsHide: true, env: { ...process.env, ...runAsNode(process.execPath) } }, (error, _out, stderr) => {
      if (!error) { resolve({ path, language: "JavaScript", checked: true, ok: true, problems: [] }); return; }
      const text = String(stderr).trim();
      const message = /^(?:SyntaxError|.*Error):.*$/m.exec(text)?.[0] ?? "This file could not be parsed";
      const line = new RegExp(`${absolute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(text)?.[1];
      resolve({
        path, language: "JavaScript", checked: true, ok: false,
        problems: [{ message: message.slice(0, 500), ...(line ? { line: Number(line) } : {}) }],
      });
    });
  });
}

const pathSchema = z.string().min(1).max(500);
/**
 * files.edit's arguments. The names other coding agents use for the same thing (`old_string`,
 * `new_string`, `file_path`, `replace_all`) are accepted and mapped, because a model trained on one
 * of them reaches for those names first, and refusing the call over a spelling wastes a whole turn.
 */
const editParameters = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const input = { ...(raw as Record<string, unknown>) };
  const alias = (from: string, to: string) => {
    if (from in input && !(to in input)) input[to] = input[from];
    delete input[from];
  };
  alias("old_string", "find"); alias("new_string", "replace"); alias("file_path", "path"); alias("replace_all", "replaceAll");
  return input;
}, z.object({
  path: pathSchema,
  find: z.string().max(32768),
  replace: z.string().max(32768),
  expectedOccurrences: z.number().int().min(1).max(100).default(1),
  replaceAll: z.boolean().default(false),
}).strict());
export function registerCodeEdit(registry: ToolRegistry, files: WorkspaceFiles, editor: CodeEditor): void {
  registry.register({
    name: "files.patch", permission: "files.write",
    description: "Apply a unified diff or a *** Begin Patch block. Parts are placed by their lines even when line numbers are off; if any part's lines are missing, nothing is written.",
    parameters: z.object({ patch: z.string().min(1).max(131072) }).strict(),
    // mac7/multi-target: the files are inside the patch, read the way it will be applied.
    target: (a) => patchFileList(a.patch),
    targets: (a) => patchTargets(a.patch),
    execute: async (a, c: ToolContext) => editor.patch(a.patch, c),
  });
  registry.register({
    name: "files.edit", permission: "files.write",
    description: "Replace text in a file. Read it first and copy `find` from it, with nearby lines so it is unique; `replace` is the new text. Empty `find` appends (or creates the file).",
    parameters: editParameters,
    execute: async (a, c: ToolContext) => editor.edit(a, c),
  });
  registry.register({
    name: "files.validate", permission: "files.read",
    description: "Check that a workspace file still reads as valid (JSON and JavaScript). Problems come back as a list to read, not as a failure.",
    parameters: z.object({ path: pathSchema }).strict(),
    execute: async (a) => validateFile(files, a.path),
  });
}
