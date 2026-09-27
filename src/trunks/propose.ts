import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import { TrunkCreateSchema } from "./record.js";

/**
 * "Have Branch make a Trunk": the assistant proposes a Trunk and the owner makes it, or not. The
 * proposal is only the fields the owner's own create takes (POST /api/trunks) and why; nothing is
 * made by this tool. The window draws the call as a card whose "Make" sends exactly these fields.
 */
export const TrunkProposalSchema = TrunkCreateSchema.extend({
  why: z.string().trim().min(1).max(500),
}).strict();

export const trunkProposeTool = "trunk.propose";

/** Registered while Trunks are on; `require` refuses in words if they were switched off since. */
export function registerTrunkPropose(registry: ToolRegistry, require: () => void): void {
  registry.register({
    name: trunkProposeTool, permission: "trunks.propose", group: "trunks", parameters: TrunkProposalSchema,
    description: "Propose a new Trunk (a named assistant with one job) when the owner asks you to make one: its name, a short title, what it does, and why. Nothing is made: the owner sees the proposal and makes the Trunk, or not.",
    target: (args) => args.name,
    execute: async (args) => {
      require();
      return { proposed: { name: args.name, title: args.title, description: args.description }, waitingForOwner: true,
        said: "The owner sees this proposal in the conversation and decides whether to make it." };
    },
  });
}
