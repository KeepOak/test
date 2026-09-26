import { readRegistryValue, regAddArgs, regDeleteValueArgs, runTool, systemTool, type RunTool } from "./windows.js";
import { runKey, runValueName } from "./installer.js";

/**
 * "Start Branch when I sign in to Windows". Windows offers a per-person list of programs to start at
 * sign-in; switching this on writes one line into it and switching it off removes the line again.
 * Nothing outside the person's own account is touched, so no administrator prompt appears.
 */
export const minimizedFlag = "--start-minimized";

export interface AutostartOptions {
  executable: string;
  /** Open straight to the tray instead of showing the window. */
  minimized: boolean;
  key?: string;
  valueName?: string;
}
export interface AutostartDeps { run?: RunTool; systemRoot?: string }
export interface AutostartState { enabled: boolean; minimized: boolean; command: string | null }

/**
 * Starting at sign-in through the desktop app itself: a Mac login item, which the desktop app hands in
 * (src/desktop/login-item.ts). macOS may want the person to approve it in System Settings first.
 */
export interface LoginItemState { enabled: boolean; needsApproval: boolean }
export interface LoginItem {
  read(): LoginItemState;
  set(enabled: boolean): LoginItemState;
}
/** System Settings › General › Login Items, where a Mac asks for that approval. */
export const macLoginItemsLink = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

/** What gets written into the sign-in list. */
export function autostartCommand(executable: string, minimized: boolean): string {
  return minimized ? `"${executable}" ${minimizedFlag}` : `"${executable}"`;
}

export async function setAutostart(
  enabled: boolean, options: AutostartOptions, deps: AutostartDeps = {},
): Promise<AutostartState> {
  const run = deps.run ?? runTool, reg = systemTool("reg.exe", deps.systemRoot);
  const key = options.key ?? runKey, name = options.valueName ?? runValueName;
  if (!enabled) {
    await run(reg, regDeleteValueArgs(key, name)).catch(() => undefined);
    return { enabled: false, minimized: options.minimized, command: null };
  }
  const command = autostartCommand(options.executable, options.minimized);
  await run(reg, regAddArgs(key, { name, type: "REG_SZ", value: command }));
  return { enabled: true, minimized: options.minimized, command };
}

export async function autostartState(
  options: { key?: string; valueName?: string } = {}, deps: AutostartDeps = {},
): Promise<AutostartState> {
  const command = await readRegistryValue(
    options.key ?? runKey, options.valueName ?? runValueName, deps);
  return { enabled: command !== null, minimized: command?.includes(minimizedFlag) ?? false, command };
}

/** True when this launch should open straight to the tray. */
export function startsMinimized(argv: readonly string[]): boolean {
  return argv.includes(minimizedFlag);
}
