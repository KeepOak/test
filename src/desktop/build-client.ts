import { fork, type ForkOptions } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunError, type DevBuildPlan, type DevBuilt } from "./dev-build.js";
import type { FromHost, ToHost } from "./build-host.js";
import type { WireLiveOutcome } from "./build-host.js";
import type { LiveOutcome, LivePlan } from "../hot-update/live-build.js";
import type { Part } from "../hot-update/classify.js";

/**
 * The updater's side of the Beta build's own process (build-host.ts). The host is this app's own file, never one from
 * the source being built, run by this app's own program as plain Node. `pause` tells it to wait: the step running now
 * is suspended when it may be, and the next one does not start until `pause(false)`.
 */
export interface HostedBuild<T = DevBuilt> { done: Promise<T>; pause(paused: boolean): void; stop(): void; lowered: Promise<string> }

export const hostScript = (): string => join(dirname(fileURLToPath(import.meta.url)), "build-host.js");

export function runHostedBuild(plan: DevBuildPlan, options: { log: string; script?: string }): HostedBuild {
  const { onStage, onVersion, note: _note, ...rest } = plan;
  return runHost<DevBuilt>({ type: "build", plan: rest, log: options.log }, { onStage, onVersion }, options);
}

export function runHostedLiveBuild(plan: LivePlan, options: { log: string; script?: string }): HostedBuild<LiveOutcome> {
  const { onStage, onVersion, note: _note, ...rest } = plan;
  const hosted = runHost<WireLiveOutcome>({ type: "live-build", plan: rest, log: options.log }, { onStage, onVersion }, options);
  return { ...hosted, done: hosted.done.then((built) => "parts" in built ? { ...built, parts: new Set(built.parts as Part[]) } : built) };
}

function runHost<T>(request: Exclude<ToHost, { type: "pause" }>, hooks: { onStage: DevBuildPlan["onStage"]; onVersion: DevBuildPlan["onVersion"] },
  options: { log: string; script?: string }): HostedBuild<T> {
  const { onStage, onVersion } = hooks;
  // Hidden on Windows (fork passes spawn's windowsHide on, though its type does not name it).
  const forkOptions: ForkOptions & { windowsHide: boolean } = {
    execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true, serialization: "json",
  };
  const child = fork(options.script ?? hostScript(), [], forkOptions);
  let errors = "", paused = false, ready = false;
  child.stderr?.on("data", (chunk: Buffer) => { errors = `${errors}${String(chunk)}`.slice(-4000); });
  const tell = (message: ToHost) => { if (child.connected) child.send(message); };
  let lowered: (words: string) => void = () => undefined;
  const loweredWords = new Promise<string>((resolve) => { lowered = resolve; });
  const done = new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: () => void) => { if (settled) return; settled = true; if (child.connected) child.disconnect(); outcome(); };
    child.on("message", (message: FromHost) => {
      if (message.type === "quiet") {
        ready = true;
        lowered(message.lowered);
        // IPC preserves order: hold the host before it can start the first program.
        if (paused) tell({ type: "pause", paused });
        tell(request);
      } else if (message.type === "stage") onStage(message.stage, message.state);
      else if (message.type === "version") onVersion?.(message.version);
      else if (message.type === "done") finish(() => resolve(message.built as T));
      else if (message.type === "failed") finish(() => reject(new RunError(message.message, message.detail)));
    });
    child.once("error", (error) => finish(() => reject(new RunError("The Beta build could not be started, so nothing was changed.", error.message))));
    child.once("exit", (code) => finish(() => reject(new RunError("The Beta build stopped before it finished, so nothing was changed.",
      errors.trim().split(/\r?\n/).at(-1)?.slice(0, 300) || `it ended with code ${code}`))));
  });
  return {
    done, lowered: loweredWords,
    pause(next) { if (next === paused) return; paused = next; if (ready) tell({ type: "pause", paused }); },
    // The host ends everything it started when its channel closes (build-host.ts), then ends itself.
    stop() { if (child.connected) child.disconnect(); },
  };
}
