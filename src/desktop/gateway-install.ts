import { rename } from "node:fs/promises";
import { join } from "node:path";
import { UpdateDeferredError, type LiveHooks } from "./updater.js";
import { WindowUpdateDeferred } from "./live-window-ipc.js";
import type { Layout } from "./app-folders.js";

/**
 * The gateway's own install, with no window open (gateway-updates.ts): what an update loop there does once the engine's
 * plan says install. Engine and window changes go live through the gateway's own engine, as the gateway's one adoption
 * at a time, begun with no shell joined, so no window is told or waited for. A change to the app itself is built as a
 * new version folder and put in use by switching `current.json`, so the next window opens as the new version. Nothing
 * is stopped. A window that opens first takes the update instead.
 */
export interface GatewayInstallOptions {
  shellOpen: () => boolean;
  updater: {
    useLive(hooks: LiveHooks | null): void;
    install(options: { automatic: boolean }): Promise<{ live: unknown } | { script: string; stagedDir: string }>;
    switchedWithoutWindow(): void;
    failed(message: string): void;
  };
  live: () => LiveHooks | null;
  appFolders: Layout | null;
  adopt?: <T>(action: () => Promise<T>) => Promise<T>;
  renameFile?: typeof rename;
}

export async function gatewayInstall(options: GatewayInstallOptions): Promise<"live" | "switched"> {
  if (options.shellOpen()) throw new UpdateDeferredError("A window opened, so it takes the update.");
  const { updater } = options;
  updater.useLive(options.live());
  const adopt = options.adopt ?? (<T>(action: () => Promise<T>) => action());
  const installed = await adopt(() => updater.install({ automatic: true })).catch((error: unknown) => {
    if (error instanceof WindowUpdateDeferred) throw new UpdateDeferredError(error.message);
    throw error;
  });
  if ("live" in installed) return "live";
  // A new version of the app itself: in use from the next window. Nothing runs from it yet, so no script is needed.
  try {
    if (!options.appFolders) throw new Error("This copy keeps the older layout, so a change to the app itself waits for its window.");
    await (options.renameFile ?? rename)(join(options.appFolders.root, "current.next.json"), join(options.appFolders.root, "current.json"));
    updater.switchedWithoutWindow();
    return "switched";
  } catch (error) { updater.failed((error as Error).message); throw error; }
}
