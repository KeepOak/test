import { z } from "zod";
import type { Store } from "../store.js";
import type { ToolContext } from "../contracts.js";
import { runOrigin } from "../key-context.js";

export function originalSocialOwner(store: Store, context: ToolContext) {
  store.profiles.requireOwner("Your Facebook Page content");
  const run = store.run(context.runId), origin = runOrigin(store, context.runId);
  const shares = z.object({ tuples: z.array(z.object({ object: z.string() }).passthrough()) }).safeParse(
    store.get("settings", context.owner, "people-shares")?.data ?? { tuples: [] });
  if (context.source !== "owner" || context.depth !== 0 || context.agent || context.trunk || origin.parentRunId
    || origin.shortLivedKey || origin.personProfileId || origin.lentTo || !run || run.owner !== context.owner
    || !store.ownsSession(context.owner, run.sessionId) || store.sessionTemporary(run.sessionId) || !shares.success
    || shares.data.tuples.some(tuple => tuple.object === `conversation:${run.sessionId}`))
    throw new Error("Social content requires your original private owner task; shared, temporary, delegated, Trunk, channel and key work cannot use it");
}

export async function socialDeadline<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted(); let stop: () => void = () => undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new Error("Social request cancelled or timed out; inspect the provider before retrying any publish"));
    signal.addEventListener("abort", stop, { once: true });
  });
  try { return await Promise.race([work(), abort]); }
  finally { signal.removeEventListener("abort", stop); }
}
