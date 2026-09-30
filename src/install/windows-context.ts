import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { resolveDataLocation } from "./layout.js";

/** Infer only a real packaged resource layout; a source checkout keeps its explicit source paths. */
export async function windowsManagementEnv(packageRoot: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (existsSync(win32.join(packageRoot, ".git"))) return env;
  const resources = win32.dirname(packageRoot), root = win32.dirname(resources);
  const packaged = win32.basename(packageRoot).toLowerCase() === "app" && win32.basename(resources).toLowerCase() === "resources"
    && ["Branch Agent.exe", "electron.exe"].some((name) => existsSync(win32.join(root, name)));
  const installRoot = env.BRANCH_INSTALL_ROOT || (packaged ? root : null);
  if (!installRoot) return env;
  if (env.BRANCH_DATA_DIR) return { ...env, BRANCH_INSTALL_ROOT: installRoot };
  const base = env.BRANCH_DESKTOP_HOME || (env.APPDATA ? win32.join(env.APPDATA, "Branch Agent") : null);
  if (!base) throw new Error("The desktop data folder could not be determined. Set BRANCH_DATA_DIR to the installed Branch state folder.");
  const location = await resolveDataLocation(installRoot, base);
  return { ...env, BRANCH_INSTALL_ROOT: installRoot, BRANCH_DATA_DIR: location.dataDir };
}
