import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { createBranch } from "./index.js";
import { aliasSchema } from "./remote/ssh-workspace.js";
import { tryToolByHand } from "./playground.js";
import { validationText } from "./request-errors.js";

/**
 * FQ-execution.host-bridge: the one door the owner presses to run a program on a computer they name
 * explicitly, and get back exactly which computer it was sent to alongside what it said. It is
 * `remote.run` (see `src/remote/ssh-workspace.ts`) pressed by hand, through exactly the gate "Try a
 * tool" uses (`tryToolByHand` in `src/playground.ts`): Lockdown, the owner's own rules, the safety
 * extras, a household person's role and the secret scrub all apply here as they do there. The rule
 * about which programs a computer may run is enforced once, by `RemoteWorkspaces.execute`.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;

export class HostBridgeApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function handlesHostBridgePath(path: string): boolean {
  return path === "/api/host-bridge/run";
}

const RunSchema = z.object({
  computer: aliasSchema,
  program: z.string().trim().min(1).max(80),
  args: z.array(z.string().max(300)).max(32).default([]),
  /** Set after the owner has answered the question this run raised the first time round. */
  confirm: z.boolean().default(false),
}).strict();

export type HostBridgeAnswer =
  | { status: "ran"; computer: string; program: string; output: string }
  | { status: "asked"; question: string };

export async function hostBridgeApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, limit?: number) => Promise<unknown>,
): Promise<HostBridgeAnswer> {
  if (request.method !== "POST" || path !== "/api/host-bridge/run")
    throw new HostBridgeApiError(404, "Unknown address");
  const parsed = RunSchema.safeParse(await readBody(request));
  if (!parsed.success) throw new HostBridgeApiError(400, validationText(parsed.error));
  const { computer, program, args, confirm } = parsed.data;
  const outcome = await tryToolByHand(app, { name: "remote.run", arguments: { computer, program, args }, confirm });
  if (outcome.status === "asked") return { status: "asked", question: outcome.question };
  if (outcome.status === "refused") throw new HostBridgeApiError(403, outcome.reason);
  if (outcome.status === "failed") throw new HostBridgeApiError(400, outcome.error);
  // `computer` is the alias `RemoteWorkspaces.execute` looked up and handed to ssh, i.e. the computer
  // the command was sent to. It is not read back from the other end's reply: it comes from the
  // added computer that was used, so a reply is never labelled with a different computer than it went to.
  const ran = outcome.result as { computer: string; program: string; output: string };
  return { status: "ran", computer: ran.computer, program: ran.program, output: ran.output };
}
