import { buildDev, realRun, RunError, type DevBuildPlan, type DevStage } from "./dev-build.js";
import { lowerBuildProcess } from "./quiet-build.js";

/**
 * The Beta build's own process (started by build-client.ts, with Electron running as plain Node). It lowers itself
 * before it starts anything, so every program the build runs, and every program those start, inherits the low
 * priority; then it builds exactly as the updater asked, and says each step, the version, and the outcome back.
 * Nothing of the build (git, npm, tsc, the packager, the fingerprint of node_modules) runs in Branch's window or engine.
 */
export type HostPlan = Omit<DevBuildPlan, "onStage" | "onVersion">;
export type ToHost = { type: "build"; plan: HostPlan; log: string } | { type: "pause"; paused: boolean };
export type FromHost =
  | { type: "quiet"; lowered: string }
  | { type: "stage"; stage: DevStage; state: "running" | "skipped" }
  | { type: "version"; version: string }
  | { type: "done"; built: Awaited<ReturnType<typeof buildDev>> }
  | { type: "failed"; message: string; detail: string | null };

const send = (message: FromHost) => process.send?.(message);

async function main(): Promise<void> {
  const { gate, quiet, lowered } = await lowerBuildProcess();
  send({ type: "quiet", lowered });
  // The app went away mid-build: nothing is left running behind it.
  process.on("disconnect", () => { void gate.endAll().finally(() => { quiet?.close(); process.exit(1); }); });
  process.on("message", (message: ToHost) => {
    if (message?.type === "pause") void gate.set(message.paused === true);
    if (message?.type !== "build") return;
    buildDev(realRun(process.platform, message.log, gate), {
      ...message.plan,
      onStage: (stage, state) => send({ type: "stage", stage, state }),
      onVersion: (version) => send({ type: "version", version }),
    }).then((built) => send({ type: "done", built }),
      (error: unknown) => send({ type: "failed", message: error instanceof Error ? error.message : String(error), detail: error instanceof RunError ? error.detail : null }))
      // The app closes the channel once it has the outcome, and this process then ends (the handler above).
      .finally(() => quiet?.close());
  });
}

void main();
