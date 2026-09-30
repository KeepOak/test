import { setTimeout as pause } from "node:timers/promises";
import type { Attachment } from "../install/running.js";
import { autostartState, type AutostartDeps } from "../install/autostart.js";
import { ensureGatewayTask, runGatewayTask, taskUser, type GatewaySupervision, type GatewayTaskDeps } from "../install/gateway-task.js";

/**
 * UP-PLATFORM-002: on Windows the installed app's window starts the background gateway through its scheduled task
 * (src/install/gateway-task.ts) rather than as a child of its own, because Task Scheduler restarts only what it
 * started. When the task cannot be registered or run, or the gateway it started does not become ready in time, the
 * window starts it directly as before (src/desktop/gateway-launch.ts); the gateway's single-instance lock keeps one.
 */
export interface SupervisedLaunch {
  /** Registers the task, or confirms it is registered; answers how the gateway is looked after. */
  supervise(): Promise<GatewaySupervision>;
  /** Starts the gateway through its task. */
  runTask(): Promise<void>;
  /** Joins a gateway that is running and proves itself. */
  join(): Promise<Attachment | null>;
  /** The direct launch, which joins first and starts the gateway itself otherwise. */
  direct(): Promise<Attachment>;
  log(line: string): void;
  /** How long a gateway started through the task has to become ready. */
  graceMs?: number;
  /** How long the window waits for the registration before it goes on without it (it carries on meanwhile). */
  registerMs?: number;
}

export async function launchSupervisedGateway(launch: SupervisedLaunch): Promise<Attachment> {
  const running = await launch.join();
  if (running) return running;
  const kind = await Promise.race([
    launch.supervise().catch((error: unknown) => { launch.log(`The background engine's scheduled task: ${text(error)}`); return "none" as const; }),
    pause(launch.registerMs ?? 5000, "none" as const, { ref: false }),
  ]);
  if (kind === "task") {
    const started = await launch.runTask().then(() => true, (error: unknown) => {
      launch.log(`The background engine's scheduled task did not start it: ${text(error)}`);
      return false;
    });
    if (started) {
      for (const end = Date.now() + (launch.graceMs ?? 30_000); Date.now() < end; await pause(250)) {
        const joined = await launch.join();
        if (joined) return joined;
      }
      launch.log("The background engine did not become ready through its scheduled task; this window starts it instead.");
    }
  }
  return launch.direct();
}

/** The real registration: the task follows "Start with Windows" (the sign-in list), and belongs to this account. */
export function windowsGatewaySupervision(input: { dataDir: string; executable: string }, deps: GatewayTaskDeps & { autostart?: AutostartDeps } = {}):
  Pick<SupervisedLaunch, "supervise" | "runTask"> {
  return {
    supervise: async () => ensureGatewayTask({ ...input, user: taskUser(deps.env), atSignIn: (await autostartState({}, deps.autostart)).enabled }, deps),
    runTask: () => runGatewayTask(deps),
  };
}

const text = (error: unknown): string => error instanceof Error ? error.message : String(error);
