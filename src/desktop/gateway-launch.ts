import { spawn } from "node:child_process";
import type { Attachment } from "../install/running.js";

export const desktopGatewayFlag = "--branch-gateway";
interface LaunchChild { unref(): void; once(event: "error", listener: (error: Error) => void): unknown }
export interface GatewayLaunchOptions {
  executable: string;
  appRoot: string;
  packaged: boolean;
  base: string;
  dataDir: string;
  workspace: string;
  join(): Promise<Attachment | null>;
  spawn?: (file: string, args: string[], env: NodeJS.ProcessEnv) => LaunchChild;
  waitMs?: number;
}

/** Launch only the existing runtime and program files; the detached broker has its own single-instance lock. */
export async function launchDesktopGateway(options: GatewayLaunchOptions): Promise<Attachment> {
  const joined = await options.join();
  if (joined) return joined;
  const env: NodeJS.ProcessEnv = { ...process.env, BRANCH_DESKTOP_HOME: options.base, BRANCH_DATA_DIR: options.dataDir, BRANCH_WORKSPACE: options.workspace };
  delete env.ELECTRON_RUN_AS_NODE;
  // A shell's debugger/automation preload belongs to that shell, never to the detached owner.
  delete env.NODE_OPTIONS;
  const launch = options.spawn ?? ((file, args, launchEnv) => spawn(file, args,
    { env: launchEnv, detached: true, windowsHide: true, stdio: "ignore" }));
  const child = launch(options.executable, [...(options.packaged ? [] : [options.appRoot]), desktopGatewayFlag], env);
  let failure: Error | null = null;
  child.once("error", (error) => { failure = error; }); child.unref();
  const until = Date.now() + (options.waitMs ?? 120000);
  while (Date.now() < until) {
    const running = await options.join();
    if (running) return running;
    if (failure) throw failure;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Branch's background engine did not become ready. Your work has been left in place.");
}
