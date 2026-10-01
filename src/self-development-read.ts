import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import { contractHash, prepareToolName } from "./self-development-contract.js";
import { ownerOnly, type SelfDevelopmentDeps } from "./self-development.js";

export const readSourceContractTool = "branch.read_source_contract";
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/, "Use lowercase letters, digits and dashes");

/** Read durable constraints before continuing existing work; never prepare or widen anything. */
export function offerSourceContractRead(deps: SelfDevelopmentDeps): () => void {
  const sync = () => {
    const names = deps.registry.names();
    const available = names.includes("git.push") && names.includes(prepareToolName);
    const offered = names.includes(readSourceContractTool);
    if (available && !offered) deps.registry.register({
      name: readSourceContractTool,
      permission: "git.read",
      description: "Read the latest persisted contract for an existing Branch source change by its original name. Use before continuing or revising that work: recover the exact worktree, source baseline, contract revision/hash, allowed paths, tool permissions, expected tests, completion criteria, side effects and rollback. Do not reconstruct these terms from memory or prepare the worktree again. This reads metadata only; it does not inspect current files, grant permissions, widen a contract, run tests, publish or merge.",
      parameters: z.object({ name }).strict(),
      execute: async (input, context: ToolContext) => {
        ownerOnly(context, deps.store, deps.ownersDefaultTurn, "read an existing Branch source contract");
        const worktree = `branch-agent-source/.branch-worktrees/self-${input.name}`;
        const contract = deps.contracts.current(deps.owner, worktree);
        if (!contract) throw new Error(`${worktree} has no persisted source contract. Do not guess its terms or continue edits.`);
        return { contract, contractHash: contractHash(contract),
          note: "These are the latest persisted contract terms, not permission to change them. sourceSha is the baseline recorded when this contract was prepared; this read does not establish the current local or remote commit, clean files, completed tests, review status or publication state. Reconcile those separately before continuing and use the existing widening flow if the requested work exceeds this contract." };
      },
    });
    if (!available && offered) deps.registry.unregister(readSourceContractTool);
  };
  sync();
  return deps.registry.onToolsChanged(sync);
}
