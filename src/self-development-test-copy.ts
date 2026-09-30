import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { contractHash, sourceFolder } from "./self-development-contract.js";
import { boundedDiff } from "./self-development-diff.js";
import { cleanHead, sourceGit } from "./self-development-evidence.js";
import type { SelfDevelopmentDeps } from "./self-development.js";

const Input = z.object({ worktree: z.string().regex(/^branch-agent-source\/\.branch-worktrees\/self-[a-z0-9][a-z0-9-]{0,23}$/) }).strict();

/** A detached copy has no shared build output, data, credentials or installed application. */
export interface TestCopyReceipt {
  id: string; sha: string; sourceWorktree: string; contractHash: string; createdAt: string;
  folder: string; dataDirectory: string; workspace: string;
  status: "prepared"; tested: false; launched: false;
  expectedTests: string[]; holds: string[];
}

async function privateDirectory(parent: string, name: string): Promise<string> {
  const directory = join(parent, name);
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("A test-copy directory must not be a link.");
  const base = await realpath(parent), actual = await realpath(directory), inside = relative(base, actual);
  if (isAbsolute(inside) || inside.startsWith(`..${sep}`) || inside === ".." || resolve(base, inside) !== actual)
    throw new Error("The test-copy directory escaped its parent.");
  return actual;
}

async function addCopy(deps: SelfDevelopmentDeps, worktree: string, folder: string, sha: string, signal: AbortSignal): Promise<void> {
  await sourceGit(deps, worktree, ["worktree", "add", "--detach", folder, sha], signal);
  const head = await sourceGit(deps, folder, ["rev-parse", "HEAD"], signal);
  if (head !== sha) throw new Error("The new test copy does not match the selected commit.");
}

/** Prepare only; execution waits for a confined runner instead of running changed code on the owner host. */
export async function prepareTestCopy(deps: SelfDevelopmentDeps, input: unknown, authorize: () => void): Promise<TestCopyReceipt> {
  authorize();
  const { worktree } = Input.parse(input), contract = deps.contracts.current(deps.owner, worktree);
  if (!contract) throw new Error("Prepare a contracted source change before making a test copy.");
  const signal = AbortSignal.timeout(120_000), sha = await cleanHead(deps, contract, signal);
  const diff = await boundedDiff(deps, contract, signal);
  if (diff.truncated || diff.outside.length || diff.untracked.length || !diff.files.length)
    throw new Error("Commit a complete change within its allowed paths before making a test copy.");
  authorize();
  if (await cleanHead(deps, contract, signal) !== sha || contractHash(deps.contracts.current(deps.owner, worktree)!) !== contractHash(contract))
    throw new Error("The source change changed while preparing its test copy. Try again.");
  const source = await realpath(resolve(deps.workspace, sourceFolder));
  const root = await privateDirectory(source, ".branch-test-copies"), id = randomUUID();
  if ((await readdir(root)).length >= 20) throw new Error("Twenty test copies are already saved. Remove old copies before preparing another.");
  const home = await privateDirectory(root, id), folder = join(home, "source");
  const dataDirectory = await privateDirectory(home, "data"), workspace = await privateDirectory(home, "workspace");
  authorize();
  await addCopy(deps, worktree, folder, sha, signal);
  const receipt: TestCopyReceipt = { id, sha, sourceWorktree: worktree, contractHash: contractHash(contract), createdAt: new Date().toISOString(),
    folder, dataDirectory, workspace, status: "prepared", tested: false, launched: false, expectedTests: [...contract.expectedTests],
    holds: ["Build and the contract's tests have not run in this copy.",
      "A confined preview job uses only an installed container image and this copy's own dependencies. It has no host credentials or network access; the owner's app is still running."] };
  await writeFile(join(home, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
  return receipt;
}
