import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { sourceCheckedOut } from "../self-development-contract.js"; // Q12
import type { ToolContext } from "../contracts.js";
import type { WorkspaceFiles } from "../files.js";
import type { Diagnostic } from "../language-server.js";
import { protectedTarget, type ProtectedAreas } from "../never-break/protected.js";
import { parsePatch } from "../patch.js";
import type { ToolRegistry } from "../registry.js";
import { checkedProgram } from "../stdio-rpc.js";
import type { WallContext } from "../sandbox.js";
import type { Store } from "../store.js";
import { runWalled, type ProgramRunner } from "./runner.js";
import { codingOn, partSettings, requireCoding, savePartSettings } from "./settings.js";

/**
 * R17-033: after every change a task makes to a file, the file is tidied with the owner's own
 * formatter for that kind of file, and the mistakes their language server sees in it are added to
 * the answer, so the assistant fixes them in the next step instead of finding out later. This is
 * what OpenCode does in its write tool (MIT, `packages/opencode/src/tool/write.ts`,
 * `format/formatter.ts`, `lsp/diagnostic.ts`); written for Branch.
 *
 * Branch never installs a formatter: the owner names the programs they already have. Each runs from
 * its full address with an argument array and the clean environment, behind the wall around programs
 * when the task has one, and never on one of Branch's own files.
 */
const alias = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/);
const argument = z.string().max(500).refine((value) => !value.includes("\0"), "NUL is not permitted");
export const FormatSettingsSchema = z.object({
  formatters: z.record(alias, z.object({
    /** The program's full address, such as /opt/homebrew/bin/prettier. */
    path: z.string().min(1).max(1000),
    /** Its arguments; `{file}` stands for the file to tidy. */
    args: z.array(argument).max(20).default(["{file}"]),
    /** The endings it tidies, such as [".ts", ".tsx"]. */
    extensions: z.array(z.string().regex(/^\.[A-Za-z0-9]{1,10}$/)).min(1).max(20),
  }).strict()).refine((value) => Object.keys(value).length <= 16, "At most 16 formatters").default({}),
  /** Ask the owner's language servers (Settings, Developer) about each changed file. */
  diagnostics: z.boolean().default(true),
  /** How long a language server is given to look at a changed file. */
  waitMs: z.number().int().min(0).max(10_000).default(1500),
  timeoutMs: z.number().int().min(1000).max(60_000).default(20_000),
}).strict();
export type FormatSettings = z.infer<typeof FormatSettingsSchema>;

export const editTools = ["files.write", "files.edit", "files.patch"] as const;
const maxFilesPerEdit = 10;

export interface DiagnosticsSource {
  diagnostics(input: { path: string; waitMs: number }, runId: string): Promise<{ diagnostics: Diagnostic[] }>;
  enabled(): boolean;
}
export interface FormatDeps {
  store: Store; owner: string; files: WorkspaceFiles; runner: ProgramRunner;
  areas: () => ProtectedAreas; servers: DiagnosticsSource;
  /**
   * The wall a formatter runs behind, worked out as for a command the task ran (src/sandbox-wall.ts),
   * or undefined when there is none. A formatter reads the project's own settings (a `.prettierrc`
   * can load plugins from the project), so without a wall it is not started at all.
   */
  wall: (context: ToolContext, program: string) => WallContext | undefined;
  /** Folder trust (src/folder-trust.ts): nothing is started for a folder the owner has not trusted. */
  trusted: (folder: string) => boolean;
  /** How a program is started behind the wall; src/coding/runner.ts unless a test hands in its own. */
  walled?: typeof runWalled;
}

export const unwalledNote = "Not tidied: a formatter reads the project's own settings, so it only runs behind the wall around programs. Switch the wall on in Settings, Computer.";
export const untrustedNote = "Not tidied: this folder is not trusted, so no program is started for it.";

/** The wall for a formatter: the one a command would get, with no internet (a formatter needs none). */
export const formatterWall = (runtime: { wallFor(tool: string, args: unknown, context: ToolContext, choice: "no-internet"): { osSandbox?: WallContext } }) =>
  (context: ToolContext, program: string): WallContext | undefined =>
    runtime.wallFor("shell.execute", { command: program }, context, "no-internet").osSandbox;
export interface FileCheck { path: string; formatter: string | null; reformatted: boolean; note?: string; problems?: { line: number; severity: string; message: string }[] }

/** The workspace paths an edit tool changed, from its own arguments. */
export function editedPaths(tool: string, args: unknown): string[] {
  if (!(editTools as readonly string[]).includes(tool)) return [];
  const input = (args ?? {}) as { path?: unknown; patch?: unknown };
  if (typeof input.path === "string") return [input.path];
  if (typeof input.patch !== "string") return [];
  try { return [...new Set(parsePatch(input.patch).map((file) => file.path))].slice(0, maxFilesPerEdit); } catch { return []; }
}

const digest = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");

export class EditChecks {
  constructor(private readonly deps: FormatDeps) {}

  requireOn(): void { requireCoding(this.deps.store, this.deps.owner, "format-on-edit"); }

  settings(): FormatSettings { return partSettings(this.deps.store, this.deps.owner, "format-on-edit", FormatSettingsSchema); }

  async save(input: unknown): Promise<FormatSettings> {
    const value = FormatSettingsSchema.parse(input ?? {});
    for (const [name, formatter] of Object.entries(value.formatters)) {
      await checkedProgram(formatter.path).catch((error: Error) => { throw new Error(`${name}: ${error.message}`); });
      if (this.inWorkspace(formatter.path)) throw new Error(`${name}: a formatter inside the workspace could be changed by a task, so name one installed elsewhere.`);
    }
    return savePartSettings(this.deps.store, this.deps.owner, "format-on-edit", FormatSettingsSchema, value);
  }

  /** The registry's after-call look (src/registry.ts): an edit's answer gains what the checks found. */
  async after(tool: string, args: unknown, result: unknown, context: ToolContext): Promise<unknown> {
    if (context.dryRun || !codingOn(this.deps.store, this.deps.owner, "format-on-edit")) return result;
    const paths = editedPaths(tool, args);
    if (!paths.length) return result;
    const checks: FileCheck[] = [];
    for (const path of paths) checks.push(await this.check(path, context).catch((error: Error) => ({ path, formatter: null, reformatted: false, note: error.message.slice(0, 300) })));
    // Ships-on sweep (2026-09-26): with no formatter named and nothing found, an edit's answer is left as it was,
    // so shipping this on adds no noise to every write (and a kept procedure's expected answer still matches).
    if (!checks.some((c) => c.formatter || c.reformatted || c.note || c.problems?.length)) return result;
    const afterEdit = { files: checks };
    return result && typeof result === "object" && !Array.isArray(result) ? { ...result, afterEdit } : { result, afterEdit };
  }

  /** Tidies one file and asks about it. Never throws for a formatter or server problem; it says so. */
  async check(path: string, context: ToolContext): Promise<FileCheck> {
    const absolute = await this.deps.files.checked(path);
    const refused = protectedTarget({ tool: "files.write", readOnly: false, args: { path }, target: path, workspace: this.deps.files.base }, this.deps.areas());
    if (refused) return { path, formatter: null, reformatted: false, note: "Not tidied: it is one of Branch's own files." };
    const settings = this.settings();
    const found = Object.entries(settings.formatters).find(([, formatter]) => formatter.extensions.includes(extname(path).toLowerCase()));
    const check: FileCheck = { path, formatter: found?.[0] ?? null, reformatted: false };
    if (found) await this.format(found[1], absolute, settings.timeoutMs, context, check);
    // mac7/coding-next: a file this task had tidied still counts as read (src/coding/read-first.ts).
    if (check.reformatted) this.deps.files.readFirst?.noteWritten(context.runId, absolute);
    if (settings.diagnostics && this.deps.servers.enabled()) {
      const seen = await this.deps.servers.diagnostics({ path, waitMs: settings.waitMs }, context.runId).catch(() => null);
      if (seen) check.problems = seen.diagnostics.filter((d) => d.severity === "error" || d.severity === "warning").slice(0, 20)
        .map((d) => ({ line: d.line, severity: d.severity, message: d.message.slice(0, 300) }));
    }
    return check;
  }

  /** A program a task could rewrite is never started by itself after an edit. */
  private inWorkspace(program: string): boolean {
    const real = (path: string) => { try { return realpathSync.native(path); } catch { return resolve(path); } };
    const rel = relative(real(this.deps.files.root), real(program));
    return !rel.startsWith("..") && !isAbsolute(rel);
  }

  private async format(formatter: FormatSettings["formatters"][string], absolute: string, timeoutMs: number, context: ToolContext, check: FileCheck): Promise<void> {
    if (this.inWorkspace(formatter.path)) { check.note = "Not tidied: the formatter sits inside the workspace."; return; }
    // Q12: a formatter is walled to the whole workspace, not to one worktree, and reads the project's
    // own settings and plug-ins, so none runs while Branch's own source is checked out here.
    if (sourceCheckedOut(this.deps.files.root)) { check.note = "Not tidied: Branch's own source is checked out in this workspace, and no formatter runs while it is."; return; }
    if (!this.deps.trusted(this.deps.files.base)) { check.note = untrustedNote; return; }
    const wall = this.deps.wall(context, formatter.path);
    if (!wall) { check.note = unwalledNote; return; }
    const before = await digest(absolute);
    const result = await (this.deps.walled ?? runWalled)(this.deps.runner, {
      executable: formatter.path, args: formatter.args.map((arg) => arg.replaceAll("{file}", absolute)),
      cwd: this.deps.files.base, timeoutMs, maxOutputBytes: 65_536, signal: context.signal,
    }, wall, context.workspace);
    if (result.timedOut) check.note = "The formatter took too long and was stopped.";
    else if (result.exitCode !== 0) check.note = `The formatter said: ${(result.stderr || result.stdout).trim().slice(0, 300) || `exit code ${result.exitCode}`}`;
    check.reformatted = (await digest(absolute)) !== before;
  }
}

export function registerFormat(registry: ToolRegistry, checks: EditChecks): void {
  registry.register({
    name: "code.format", permission: "files.write", group: "code",
    description: "Tidy a file with the owner's formatter for its kind and report the mistakes their language server sees in it. The same happens by itself after every edit while this is on.",
    parameters: z.object({ path: z.string().min(1).max(500) }).strict(),
    execute: async ({ path }, context) => {
      checks.requireOn();
      return checks.check(path, context);
    },
  });
}
