import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { installedLocation, resolveDataLocation } from "./layout.js";
import { runningNow, type QuitDeps } from "./quit.js";
import { runningShell } from "./quit-shell.js";
import { unixLayout } from "./unix-install.js";

interface ManagementLocation {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  deps?: { quit?: QuitDeps };
}

/** Known launch locations only; never enumerate profiles, open databases or read tokens to discover an app. */
async function candidates(context: ManagementLocation): Promise<string[]> {
  const { env, platform } = context;
  const locations = [resolve(".branch")];
  if (env.BRANCH_DESKTOP_HOME) locations.push(installedLocation(resolve(env.BRANCH_DESKTOP_HOME)).dataDir);
  if (platform === "win32") {
    const roaming = env.APPDATA || join(env.USERPROFILE || homedir(), "AppData", "Roaming");
    locations.push(installedLocation(join(roaming, "Branch Agent")).dataDir);
  } else if (platform === "darwin" || platform === "linux") {
    locations.push(unixLayout(platform, env).dataDir);
  }
  const executable = env.BRANCH_EXECUTABLE;
  if (executable && isAbsolute(executable)) {
    const portable = await resolveDataLocation(dirname(executable), dirname(executable));
    if (portable.portable) locations.push(portable.dataDir);
  }
  const unique = new Map<string, string>();
  for (const location of locations) {
    const path = resolve(location), key = platform === "win32" ? path.toLowerCase() : path;
    unique.set(key, path);
  }
  return [...unique.values()];
}

/** An explicit data folder is authoritative. Ambiguous live launches require an explicit choice. */
export async function managementDataDir(context: ManagementLocation): Promise<string> {
  if (context.env.BRANCH_DATA_DIR !== undefined) return resolve(context.env.BRANCH_DATA_DIR);
  const live: string[] = [];
  for (const candidate of await candidates(context)) {
    if (await runningNow(candidate, context.deps?.quit?.alive)
      || await runningShell(candidate, context.deps?.quit?.alive)) live.push(candidate);
  }
  if (live.length > 1)
    throw new Error("More than one Branch data folder is running. Set BRANCH_DATA_DIR to the one you want to manage.");
  return live[0] ?? resolve(".branch");
}
