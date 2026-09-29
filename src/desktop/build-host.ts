import { buildDev, realRun, RunError, type DevBuildPlan, type DevStage } from "./dev-build.js";
import { appendFile } from "node:fs/promises";
import { lowerBuildProcess } from "./quiet-build.js";
import { buildLive, type LiveOutcome, type LivePlan } from "../hot-update/live-build.js";

/**
 * The Beta build's own process (started by build-client.ts, with Electron running as plain Node). It lowers itself
 * before it starts anything, so every program the build runs, and every program those start, inherits the low
 * priority; then it builds exactly as the updater asked, and says each step, the version, and the outcome back.
 * Nothing of the build (git, npm, tsc, the packager, the fingerprint of node_modules) runs in Branch's window or engine.
 */
export type HostPlan = Omit<DevBuildPlan, "onStage" | "onVersion" | "note">;
export type HostLivePlan = Omit<LivePlan, "onStage" | "onVersion" | "note">;
export type WireLiveOutcome = Exclude<LiveOutcome, { parts: Set<unknown> }> | (Omit<Extract<LiveOutcome, { parts: Set<unknown> }>, "parts"> & { parts: string[] });
export type ToHost = { type: "build"; plan: HostPlan; log: string } | { type: "live-build"; plan: HostLivePlan; log: string } | { type: "pause"; paused: boolean };
export type FromHost =
  | { type: "quiet"; lowered: string }
  | { type: "stage"; stage: DevStage; state: "running" | "skipped" }
  | { type: "version"; version: string }
  | { type: "done"; built: Awaited<ReturnType<typeof buildDev>> | WireLiveOutcome }
  | { type: "failed"; message: string; detail: string | null };

const send = (message: FromHost) => process.send?.(message);

function main(): void {
  const { gate, lowered } = lowerBuildProcess();
  // The app went away mid-build: nothing is left running behind it.
  process.on("disconnect", () => { void gate.endAll().finally(() => process.exit(1)); });
  process.on("message", (message: ToHost) => {
    if (message?.type === "pause") void gate.set(message.paused === true);
    if (message?.type !== "build" && message?.type !== "live-build") return;
    const hooks = {
      onStage: (stage: DevStage, state: "running" | "skipped") => send({ type: "stage", stage, state }),
      onVersion: (version: string) => send({ type: "version", version }),
      note: (line: string) => { void appendFile(message.log, `${line}

`).catch(() => undefined); },
    };
    const run = realRun(process.platform, message.log, gate);
    // The app closes the channel once it has the outcome, and this process then ends (the handler above).
    const build = message.type === "live-build" ? buildLive(run, { ...message.plan, ...hooks }) : buildDev(run, { ...message.plan, ...hooks });
    build.then((built) => send({ type: "done", built: "parts" in built ? { ...built, parts: [...built.parts] } : built }),
      (error: unknown) => send({ type: "failed", message: error instanceof Error ? error.message : String(error), detail: error instanceof RunError ? error.detail : null }));
  });
  // Lowered, and listening: the app sends the plan once it hears this.
  send({ type: "quiet", lowered });
}

main();
