import type { App } from "electron";
import type { LoginItem, LoginItemState } from "../install/autostart.js";

/**
 * "Start when you log in" on a Mac: the app's own login item. On macOS 13 and later the system may
 * keep it waiting until the person approves it in System Settings › General › Login Items; that is
 * reported as `needsApproval`, and the choice still counts as on. Nothing here asks for anything.
 *
 * `app` is Electron's app, handed in so this can be checked without Electron.
 */
export function macLoginItem(app: Pick<App, "getLoginItemSettings" | "setLoginItemSettings">): LoginItem {
  const read = (): LoginItemState => {
    const settings = app.getLoginItemSettings();
    const needsApproval = settings.status === "requires-approval";
    return { enabled: settings.openAtLogin || settings.status === "enabled" || needsApproval, needsApproval };
  };
  return {
    read,
    set: (enabled) => {
      app.setLoginItemSettings({ openAtLogin: enabled });
      return read();
    },
  };
}
