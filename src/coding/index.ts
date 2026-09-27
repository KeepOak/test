import { homedir } from "node:os";
import type { ToolContext } from "../contracts.js";
import type { WorkspaceFiles } from "../files.js";
import { folderAllows } from "../folder-trust.js";
import { toolLimits } from "../knobs/apply.js"; // mac7/speed
import type { GitRun } from "../git-checkpoint.js";
import type { LanguageServers } from "../language-server.js";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import { Checklists, registerChecklist } from "./checklist.js";
import { EditChecks, formatterWall, registerFormat } from "./format-on-edit.js";
import type { CodingHooks, RoundNotes } from "./hooks.js";
import { registerInit } from "./init.js";
import { LargeOutputs, registerLargeOutput } from "./large-output.js";
import { Mentions } from "./mentions.js";
import { registerNotebooks } from "./notebooks.js";
import { registerReadMany } from "./read-many.js"; // mac7/speed
import { PathRules, registerPathRules } from "./path-rules.js";
import { ReviewChecks, registerReviewChecks } from "./review-checks.js";
import { spawnProgram, type ProgramRunner } from "./runner.js";
import { codingMode, codingOn, codingParts, codingTools, saveCodingMode, type CodingMode, type CodingPart } from "./settings.js";
import { ShellSnapshots } from "./shell-snapshot.js";
import { inWorktree, WorktreePlaces, type WorktreeGit } from "./worktrees.js";
import { trunkFilePlace } from "../trunks/file-root.js"; // FQ-routing.isolated-agents

/**
 * Bucket R17-D (wave mac7): coding polish. `createBranch` makes one of these; the runtime asks it
 * where a task works and what to tell the model each round (src/coding/hooks.ts), the registry asks
 * it after every call (format-on-edit, long answers), and the server hands it /api/coding/. Every
 * part ships as src/coding/settings.ts says. See docs/configuration.md, "Coding polish".
 */
export interface CodingDeps {
  runtime: Runtime; registry: ToolRegistry; files: WorkspaceFiles; servers: LanguageServers;
  git: WorktreeGit; gitRun: GitRun;
  runner?: ProgramRunner;
  env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string;
}

export class Coding implements CodingHooks {
  readonly edits: EditChecks;
  readonly outputs: LargeOutputs;
  readonly checklists: Checklists;
  readonly rules: PathRules;
  readonly mentions: Mentions;
  readonly worktrees: WorktreePlaces;
  readonly snapshots: ShellSnapshots;
  readonly checks: ReviewChecks;
  private readonly registrars: Partial<Record<CodingPart, () => void>>;

  constructor(private readonly deps: CodingDeps) {
    const { runtime, registry, files } = deps;
    const store = runtime.store, owner = runtime.owner, runner = deps.runner ?? spawnProgram;
    const trusted = (folder: string) => folderAllows(store, owner, folder);
    const host = { runtime, registry };
    this.edits = new EditChecks({ store, owner, files, runner, areas: () => runtime.protectedAreas, wall: formatterWall(runtime), trusted,
      servers: { enabled: () => deps.servers.settings().enabled, diagnostics: (input, runId) => deps.servers.diagnostics(input, runId) } });
    this.outputs = new LargeOutputs(store, owner, (text) => runtime.hideSecrets(text));
    this.checklists = new Checklists(store, owner);
    this.rules = new PathRules(store, owner, files, trusted, () => registry.permissions());
    this.mentions = new Mentions(host, files);
    this.worktrees = new WorktreePlaces({ store, owner, root: files.root, projectFolder: () => store.projects.active(owner).folder,
      git: deps.git, run: deps.gitRun, branchSession: (who, input) => store.branchSession(who, input),
      note: (runId, kind, data) => store.event(runId, kind, data) });
    this.snapshots = new ShellSnapshots(store, owner, { runner, env: deps.env ?? process.env,
      platform: deps.platform ?? process.platform, home: deps.home ?? homedir(), workspaces: [files.root] });
    this.checks = new ReviewChecks(host, files, store, owner, trusted);
    this.registrars = {
      "format-on-edit": () => registerFormat(registry, this.edits),
      init: () => registerInit(registry, store, files),
      checklist: () => registerChecklist(registry, this.checklists),
      "path-rules": () => registerPathRules(registry, this.rules),
      "large-output": () => registerLargeOutput(registry, this.outputs),
      notebooks: () => registerNotebooks(registry, files),
      "review-checks": () => registerReviewChecks(registry, this.checks),
      // mac7/speed: reading several files in one call, so a task takes fewer round trips. The room
      // it is given is the owner's own tool-answer ceiling, so it never hands back more than the
      // task will keep.
      "fewer-rounds": () => registerReadMany(registry, files,
        () => toolLimits(this.deps.runtime.store, this.deps.runtime.owner, this.deps.runtime.reliability).toolResultChars),
    };
    for (const part of codingParts) this.sync(part);
    registry.afterTool = (name, args, result, context) => this.edits.after(name, args, result, context);
    registry.oversized = (name, result, context) => this.outputs.keep(name, result, context);
  }

  /** A part's tools are in the catalog exactly while its switch is not off. */
  private sync(part: CodingPart): void {
    for (const name of codingTools[part]) this.deps.registry.unregister(name);
    if (codingOn(this.deps.runtime.store, this.deps.runtime.owner, part)) this.registrars[part]?.();
  }

  modes(): Record<CodingPart, CodingMode> {
    const { store, owner } = this.deps.runtime;
    return Object.fromEntries(codingParts.map((part) => [part, codingMode(store, owner, part)])) as Record<CodingPart, CodingMode>;
  }

  setMode(part: CodingPart, mode: CodingMode): CodingMode {
    const saved = saveCodingMode(this.deps.runtime.store, this.deps.runtime.owner, part, mode);
    this.sync(part);
    return saved;
  }

  /* ---------- the runtime's questions (src/coding/hooks.ts) ---------- */

  async placeTask(run: { id: string; sessionId: string }, context: ToolContext, parent: ToolContext | undefined) {
    // FQ-routing.isolated-agents: a coding fork's own copy wins when there is one; otherwise a
    // Trunk's own top-level turn gets its own folder, so it can reach neither another Trunk's files
    // nor the owner's project by way of the workspace they would otherwise share.
    return (await this.worktrees.placeTask(run, context, parent)) ?? trunkFilePlace(this.deps.files.root, context, parent);
  }
  inPlace<T>(scope: string, work: () => Promise<T>): Promise<T> { return inWorktree(scope, work); }

  async roundNotes(run: { id: string; sessionId: string; prompt: string }, context: ToolContext, round: number): Promise<RoundNotes> {
    const { store, owner } = this.deps.runtime;
    const notes: RoundNotes = {};
    // Only the person's own message is looked at for @, never a helper's brief a model wrote.
    if (round === 0 && context.depth === 0 && codingOn(store, owner, "mentions")) {
      const once = await this.mentions.note(run.prompt, context).catch(() => null);
      if (once) notes.once = once;
    }
    const parts = [this.checklists.roundNote(run.sessionId), await this.rules.roundNote(run.id)].filter((note) => note !== null);
    if (parts.length) notes.every = { role: "system", content: parts.map((note) => note.content).join("\n\n") };
    return notes;
  }
}

export { codingParts, codingLabels, codingTools } from "./settings.js";
