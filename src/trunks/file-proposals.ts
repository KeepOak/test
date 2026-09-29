import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import { FileProposalInput, type TrunkFiles } from "./files.js";

/** A personality change is always a proposal. The existing owner/person Files route applies the exact reviewed draft. */
export function registerFileProposals(registry: ToolRegistry, files: TrunkFiles, trunkFor: (context: ToolContext) => string): void {
  registry.register({
    name: "trunk.propose_file", permission: "trunks.propose", group: "trunks", parameters: FileProposalInput,
    description: "Propose new complete text for one of your own personality files, with a reason. Nothing is applied: the owner reviews the before/after in Customize > Trunks > Files and accepts or rejects it. You cannot change another Trunk's files.",
    target: (args) => args.name,
    execute: async (input, context) => {
      const proposal = files.propose(trunkFor(context), input);
      return { proposalId: proposal.id, name: proposal.name, waitingForOwner: true,
        said: "The file has not changed. The owner reviews this suggestion in the Trunk's Files tab." };
    },
  });
}
