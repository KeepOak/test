import { z } from "zod";
import { pick, TrunkSchema, type Trunk, type TrunkFields } from "./record.js";
import { notFromAFile } from "../policy.js"; // reads that reach past this computer: never given by a file

/**
 * R17-013 (T-14): a Trunk as one file, to keep or to give to somebody else.
 *
 * The file holds what the Trunk *is* — its name, role, picture, model, instructions, style and
 * lists — and never what it holds: no conversation, no memory, no keys or account choices, and no
 * reach. A Trunk brought in from a file therefore starts with every reach switch off and the
 * owner's own keys, whoever wrote the file. Sharing through a git source is a later step (R17-083).
 */
export const trunkFileFormat = "branch-trunk/1";

export const TrunkFileSchema = z.object({
  format: z.literal(trunkFileFormat),
  exportedAt: z.string().max(40),
  // Q44: where it starts names one of this owner's computers, which means nothing anywhere else.
  trunk: TrunkSchema.omit({ keys: true, reach: true, hidden: true, section: true, pinned: true, order: true, startsIn: true }),
}).strict();
export type TrunkFile = z.infer<typeof TrunkFileSchema>;

export function exportTrunk(trunk: Trunk): TrunkFile {
  const { keys: _keys, reach: _reach, hidden: _hidden, section: _section, pinned: _pinned, order: _order, startsIn: _startsIn, ...shared } = pick(trunk);
  return { format: trunkFileFormat, exportedAt: new Date().toISOString(), trunk: shared };
}

/**
 * The fields a file brings in, checked, with everything it may not carry set back to off.
 *
 * Integrator (R17-A): a file is somebody else's words, so the Trunk it makes may only look. Its tools
 * are the file's list cut down to what only reads here (`readable`, from the running Branch), or
 * all of those when the file names none — never the empty list, which means the owner's whole set.
 * It uses no connected tool server until the owner names one.
 */
export function importedFields(input: unknown, readable: readonly string[]): TrunkFields {
  const file = TrunkFileSchema.parse(input);
  const looking = readable.filter((permission) => permission.endsWith(".read") && !notFromAFile.has(permission));
  const asked = file.trunk.permissions.filter((permission) => looking.includes(permission));
  return TrunkSchema.parse({ ...file.trunk, permissions: asked.length ? asked : looking, mcpServers: [],
    keys: { copyFromOwner: true, accounts: {} }, reach: { channels: [], commands: false } });
}
