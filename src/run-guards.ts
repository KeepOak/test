import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { ToolCall } from "./contracts.js";
import {
  decideFolder, discoverFolder, folderTrust, folderTrustMode, FolderTrustInputSchema, FolderTrustSettingsSchema, isFolderTrusted, needsAnswer,
  saveFolderTrustSettings, trustCappedPolicy, workspaceFolder, type FolderFindings, type FolderTrust,
} from "./folder-trust.js";
import { guardFor, loopGuardMode, saveLoopGuardSettings, type FeatureSwitch, type LoopGuard } from "./loop-guard.js";
import type { Policy } from "./policy.js";
import type { Store } from "./store.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48
import { lockdownActive } from "./lockdown.js";
import { looseningRefusal, withoutConfirm } from "./policy-change-guard.js";

/** Raised between rounds when the loop guard has decided the task should end. */
export class LoopStoppedError extends Error {
  override name = "LoopStoppedError";
}

/**
 * The one place the runtime calls for the two guards of wave mac2: the loop guard
 * (src/loop-guard.ts) and folder trust (src/folder-trust.ts). Each task gets its own loop guard,
 * let go of when the task settles. Both follow the owner's off / on / when-needed setting.
 */
export class RunGuards {
  private readonly runs = new Map<string, LoopGuard | null>();
  private readonly asked = new Set<string>();
  constructor(private readonly store: Store, private readonly owner: string, private readonly workspace: string) {}

  /** The folder tasks work in: the active project's folder inside the workspace, or the workspace. */
  private taskFolder(): string {
    try { return join(this.workspace, this.store.projects.active(this.owner).folder); } catch { return this.workspace; }
  }
  /** How far the folder tasks work in is trusted. */
  trust(): FolderTrust {
    return folderTrust(this.store, this.owner, this.taskFolder());
  }
  /** The approval setting with the folder's trust applied: a task in an untrusted folder asks. */
  policy(policy: Policy): Policy {
    const mode = folderTrustMode(this.store, this.owner);
    // Off (as shipped): nothing is looked up, so a tool call costs exactly what it did before.
    if (mode === "off") return policy;
    return trustCappedPolicy(policy, this.trust(), mode);
  }
  /** For any loader of what a folder carries: may it be read? See `isFolderTrusted`. */
  isFolderTrusted(path: string): Promise<boolean> {
    return isFolderTrusted(this.store, this.owner, path);
  }

  private guard(runId: string): LoopGuard | null {
    if (!this.runs.has(runId)) this.runs.set(runId, guardFor(loopGuardMode(this.store, this.owner)));
    return this.runs.get(runId) ?? null;
  }
  forget(runId: string): void {
    this.runs.delete(runId);
  }

  /** At the start of a task: a folder not decided about yet is written down so the owner is asked. */
  async opening(runId: string): Promise<void> {
    try {
      const mode = folderTrustMode(this.store, this.owner), folder = this.taskFolder();
      if (mode === "off" || this.asked.has(folder) || this.trust() !== "unknown") return;
      this.asked.add(folder);
      const found = await discoverFolder(folder);
      if (needsAnswer(mode, "unknown", found)) this.store.event(runId, "folder.trust_needed", { folder, ...found });
    } catch { /* noticing a folder never fails a task */ }
  }

  /**
   * One tool call with the loop guard around it. A refused call is answered without running; a
   * repeated one runs with a warning beside its result. With the guard off the call just runs.
   */
  async call(runId: string, call: ToolCall, execute: () => Promise<unknown>): Promise<unknown> {
    const guard = this.guard(runId);
    if (!guard) return execute();
    const verdict = guard.check(call.name, call.arguments);
    if (verdict.kind === "block" || verdict.kind === "stop") {
      this.store.event(runId, verdict.kind === "stop" ? "loop.stopped" : "loop.blocked", { name: call.name, id: call.id, reason: verdict.reason });
      return { ok: false, error: verdict.reason };
    }
    const result = await execute();
    const repeated = guard.record(call.name, call.arguments, JSON.stringify(result) ?? "");
    const warning = verdict.kind === "warn" ? verdict.reason : repeated;
    if (!warning) return result;
    this.store.event(runId, "loop.warned", { name: call.name, id: call.id, reason: warning });
    // Put first, so a long result that gets shortened still carries it.
    return result && typeof result === "object" && !Array.isArray(result)
      ? { loopWarning: warning, ...result } : { loopWarning: warning, result };
  }

  /** Ends the task, in one plain sentence, once the guard has decided it is going nowhere. */
  afterRound(runId: string): void {
    const guard = this.runs.get(runId);
    if (guard?.stats().stopped) throw new LoopStoppedError(guard.stopReason());
  }
}

/* ------------------------------------------------------------------ the owner's screens */

/** What the screens need from the app; `createBranch`'s result fits. */
export interface GuardsApp {
  store: Store;
  runtime: { owner: string; workspace: string };
}
export interface FolderTrustView {
  path: string;
  /** The folder as the owner sends it back: "" for the workspace, or a folder inside it. */
  folder: string;
  label: string;
  /** The project whose folder this is, or null for the workspace itself. */
  project: string | null;
  trust: FolderTrust;
  found: FolderFindings;
  /** True when the owner should be asked about this folder now. */
  needsAnswer: boolean;
}

export function handlesGuardsPath(path: string): boolean {
  return path === "/api/folder-trust" || path === "/api/loop-guard";
}

/** The setting, and the workspace and every project folder with what each carries. */
export async function folderTrustView(app: GuardsApp): Promise<{ mode: FeatureSwitch; folders: FolderTrustView[] }> {
  const { owner, workspace } = app.runtime;
  const mode = folderTrustMode(app.store, owner);
  const places = new Map<string, string | null>([["", null]]);
  for (const project of app.store.projects.list(owner))
    if (project.folder && !places.has(project.folder)) places.set(project.folder, project.name);
  const folders: FolderTrustView[] = [];
  for (const [folder, project] of places) {
    const path = workspaceFolder(workspace, folder);
    const trust = folderTrust(app.store, owner, path);
    const found = await discoverFolder(path);
    const label = project === null ? "Your workspace" : `The "${project}" project's folder`;
    folders.push({ path, folder, label, project, trust, found, needsAnswer: needsAnswer(mode, trust, found) });
  }
  return { mode, folders };
}

/** A folder-trust change refused before it is saved (answered with its status). */
export class GuardsApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const trustOrder = ["off", "when-needed", "on"] as const;
/**
 * What a folder-trust change would make less careful, in words, or null when it only tightens: trusting a folder
 * lets what it carries for AI assistants steer the owner's tasks, and a lower mode checks fewer folders first.
 */
export function folderTrustLooser(store: Store, owner: string, workspace: string, input: unknown): string | null {
  if (input && typeof input === "object" && "mode" in input) {
    const { mode } = FolderTrustSettingsSchema.parse(input);
    return trustOrder.indexOf(mode) < trustOrder.indexOf(folderTrustMode(store, owner)) ? "fewer folders would be checked before what they carry is used" : null;
  }
  const { folder, decision } = FolderTrustInputSchema.parse(input);
  if (decision !== "trust" || folderTrust(store, owner, workspaceFolder(workspace, folder)) === "trusted") return null;
  return `what ${folder ? `the folder "${folder}"` : "your workspace"} carries for AI assistants would be used in your tasks`;
}

/** GET reads; POST `{ mode }` changes a setting, POST `{ folder, decision }` answers for a folder. */
export async function guardsApi(
  app: GuardsApp, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage) => Promise<unknown>,
): Promise<unknown> {
  const { store, runtime: { owner, workspace } } = app;
  if (request.method !== "GET" && request.method !== "POST") throw new Error("Use GET or POST");
  const body = request.method === "POST" ? await readBody(request) : undefined;
  if (path === "/api/loop-guard") {
    if (body !== undefined) recordedWrite(store, owner, byCard("loop_guard"), ["loop_guard"], () => saveLoopGuardSettings(store, owner, body));
    return { mode: loopGuardMode(store, owner) };
  }
  if (body !== undefined) {
    // Trusting a folder, or checking fewer, needs the owner's yes and is refused under Lockdown (src/policy-change-guard.ts).
    const { confirmLoosening, input } = withoutConfirm(body);
    const refusal = looseningRefusal(folderTrustLooser(store, owner, workspace, input), confirmLoosening, lockdownActive(store, owner));
    if (refusal) throw new GuardsApiError(409, refusal);
    if (input && typeof input === "object" && "mode" in input)
      recordedWrite(store, owner, byCard("folder_trust_mode"), ["folder_trust_mode"], () => saveFolderTrustSettings(store, owner, input));
    else decideFolder(store, owner, workspace, input);
  }
  return folderTrustView(app);
}
