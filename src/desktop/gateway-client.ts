import { z } from "zod";
import { connectDesktopControl } from "./gateway-control.js";
import { GatewayWindowSchema, gatewayLiveRequest } from "./gateway-live.js";
import { liveHooks, type HotApplyOptions } from "./hot-apply.js";
import { UpdateDeferredError, type LiveHooks } from "./updater.js";

const StageSchema = z.enum(["checking", "copying", "swapping"]);
const AppliedSchema = z.object({ tier: z.enum(["window", "engine", "gateway"]), ms: z.number().nonnegative(),
  words: z.string().max(500), version: z.string().max(80), commit: z.string().regex(/^[a-f0-9]{40}$/) }).strict();

/** Builds stay below normal in the shell's helper; only the retained broker may adopt engine/window files. */
export async function joinedGatewayLive(options: HotApplyOptions): Promise<{ hooks: LiveHooks; close(): void; inspect(): Promise<unknown> }> {
  let onStage: (stage: z.infer<typeof StageSchema>) => void = () => undefined;
  const client = await connectDesktopControl(options.dataDir, {
    "window-update": async (args) => { await options.tellWindow(GatewayWindowSchema.parse(args)); return true; },
    "window-recover": async () => { await options.recoverWindow(); return true; },
    "update-stage": (args) => { onStage(StageSchema.parse(args)); return true; },
  });
  let local = liveHooks(options), paused = false;
  return { close: () => client.close(), inspect: () => client.link.call("test-engine", undefined, 5000), hooks: {
    pause: (next) => { paused = next; local.pause?.(next); }, stop: () => local.stop?.(),
    build: (release, hooks) => local.build(release, hooks),
    apply: async (outcome, hooks) => {
      onStage = hooks.onStage;
      try {
        const result = AppliedSchema.parse(await client.link.call("apply-live", gatewayLiveRequest(outcome), 600000));
        // The broker wrote current.json only after renderer acknowledgment; the next build reads that exact state.
        local = liveHooks(options); local.pause?.(paused);
        return result;
      } catch (error) { throw new UpdateDeferredError(error instanceof Error ? error.message : String(error)); }
      finally { onStage = () => undefined; }
    },
  } };
}
