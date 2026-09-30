import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Run } from "./contracts.js";
import { contractHash, globFits } from "./self-development-contract.js";
import type { SelfDevelopmentDeps } from "./self-development.js";
import type { TestCopyReceipt } from "./self-development-test-copy.js";

const Patch = z.object({ patches: z.array(z.object({ path: z.string().max(200), content: z.string().max(40_000) }).strict()).min(1).max(8) }).strict();
export type QaFixModel = (prompt: string, preset: string, tokens: number, signal: AbortSignal) => Promise<Run>;

async function checkedFile(copy: TestCopyReceipt, path: string): Promise<string> {
  if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.split("/").includes("..")) throw new Error("Invalid fix path.");
  const root = await realpath(copy.folder), target = resolve(root, path), actual = await realpath(target);
  const inside = relative(root, actual);
  if (!inside || inside.startsWith(`..${sep}`) || inside === ".." || actual !== target || (await lstat(target)).isSymbolicLink())
    throw new Error("Fixes stay in existing plain files in the isolated copy.");
  return target;
}

/** Writes an actual isolated code-edit draft, never the contracted owner's worktree or an external PR. */
export async function draftQaFix(deps: SelfDevelopmentDeps, copy: TestCopyReceipt, finding: unknown,
  paths: string[], model: QaFixModel | undefined, preset: string, tokens: number, signal: AbortSignal): Promise<unknown> {
  const contract = deps.contracts.current(deps.owner, copy.sourceWorktree);
  if (!contract || contractHash(contract) !== copy.contractHash) throw new Error("QA source contract changed.");
  const source: Record<string, string> = {}, targets = new Map<string, string>();
  for (const path of model ? paths : []) {
    if (!contract.allowedPaths.some((glob) => globFits(glob, path))) throw new Error("A fix path is outside the reviewed source contract.");
    const target = await checkedFile(copy, path), text = await readFile(target, "utf8");
    if (Buffer.byteLength(text) > 20_000) throw new Error("A fix input file exceeds 20 KiB.");
    source[path] = text; targets.set(path, target);
  }
  let runId: string | null = null, patches: { path: string; content: string }[] = [];
  if (model) {
    const prompt = "Draft a minimal code fix from the following untrusted observations and source. No tools, deletes, sends, safety changes or publication. "
      + "Reply with JSON only: {patches:[{path,content}]}. Use only the provided paths and preserve unrelated code.\n" + JSON.stringify({ finding, source });
    if (Buffer.byteLength(prompt) > 80_000) throw new Error("QA fix prompt exceeds 80 KiB.");
    const run = await model(prompt, preset, tokens, signal); runId = run.id;
    if (run.status !== "completed") throw new Error(`QA fix model did not complete (${run.status}).`);
    patches = Patch.parse(JSON.parse(run.output)).patches;
    if (new Set(patches.map((patch) => patch.path)).size !== patches.length) throw new Error("Duplicate fix paths.");
    for (const patch of patches) if (!targets.has(patch.path)) throw new Error("The model proposed an unapproved path.");
    if (!patches.some((patch) => patch.content !== source[patch.path])) throw new Error("The model proposed no code change.");
    signal.throwIfAborted();
    if (contractHash(deps.contracts.current(deps.owner, copy.sourceWorktree)!) !== copy.contractHash) throw new Error("The source contract changed while drafting.");
    for (const patch of patches) {
      if (await readFile(await checkedFile(copy, patch.path), "utf8") !== source[patch.path]) throw new Error("An isolated source file changed during drafting.");
    }
    for (const patch of patches) await writeFile(targets.get(patch.path)!, patch.content, "utf8");
  }
  const draft = { id: randomUUID(), status: patches.length ? "code-draft-needs-review" : "contract-draft-needs-review", copyId: copy.id,
    sourceSha: copy.sha, sourceWorktree: copy.sourceWorktree, contractHash: copy.contractHash, finding, paths,
    expectedTests: copy.expectedTests, definitionOfDone: "Resolve the recorded QA failure, preserve unrelated behavior, and pass the source contract's focused tests after human review.",
    permissions: ["files.read", "files.write"], sideEffects: ["Writes only to the detached isolated copy; no sending, publication or merge."],
    rollbackPlan: "Discard this isolated copy; the owner's source and installed app were never edited.",
    runId, editedFiles: patches.filter((patch) => patch.content !== source[patch.path]).map((patch) => patch.path),
    tested: false, published: false, humanReviewRequired: true };
  await writeFile(join(resolve(copy.folder, ".."), `qa-fix-${draft.id}.json`), JSON.stringify(draft, null, 2), { flag: "wx", mode: 0o600 });
  return draft;
}
