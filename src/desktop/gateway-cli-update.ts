import { z } from "zod";
import type { UpdateLoop } from "./update-loop.js";
import type { Updater } from "./updater.js";
import type { EngineHost } from "./engine-host.js";
import { brokerRequest } from "./gateway-engine.js";
import type { DesktopUpdateReceipt } from "./update-receipt.js";

const requestSchema = z.object({ install: z.boolean() }).strict();
const outcomeSchema = z.object({ status: z.string(), question: z.string().optional(), reason: z.string().optional(),
  error: z.string().optional(), result: z.object({ asked: z.boolean().optional(), words: z.string().optional() }).passthrough().optional(),
}).passthrough();

/** The resident broker, rather than a caller-supplied port or bearer key, makes the guarded engine request. */
export async function retainedCliUpdateRequest(host: EngineHost | null, path: string, body: unknown): Promise<unknown> {
  if (!host?.running || host.handingOver) throw new Error("The retained engine is not ready to accept an update request.");
  return brokerRequest(host, async (client) => {
    const response = await client.fetch(`${host.url}${path}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? `The engine answered ${response.status}.`);
    return result;
  });
}

/** Request the resident updater through the same owner/profile/Lockdown/policy gates as the manual tool. */
export async function gatewayCliUpdate(args: unknown, options: {
  resident: () => { loop: UpdateLoop; updater: Updater } | null;
  engine: (path: string, body: unknown) => Promise<unknown>;
  shellOpen: () => boolean;
}): Promise<DesktopUpdateReceipt> {
  const input = requestSchema.parse(args), resident = options.resident();
  if (!resident) throw new Error("This desktop gateway does not have a resident updater ready. Nothing was stopped or installed.");
  const outcome = outcomeSchema.parse(await options.engine("/api/tools/try", {
    name: "branch.update", arguments: { action: input.install ? "install" : "status" }, confirm: input.install,
  }));
  if (outcome.status !== "ran") throw new Error(outcome.reason ?? outcome.error ?? outcome.question ?? "The owner update request was not accepted.");
  if (input.install && outcome.result?.asked !== true) throw new Error("The resident updater did not acknowledge the install request.");
  if (!outcome.result?.words) throw new Error("The resident updater did not return its update status.");
  // With a shell joined, its loop owns the update. A CLI observer never claims the shell's slot or install lock.
  if (input.install && !options.shellOpen()) void resident.loop.look().catch(() => undefined);
  return { accepted: input.install, words: outcome.result.words,
    updater: { phase: resident.updater.status.phase, message: resident.updater.status.message } };
}
