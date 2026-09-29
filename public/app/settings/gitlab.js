/* Settings › Advanced › GitLab (RES-719): the connection under GitLab's switch. The owner pastes a personal access
   token (and, for their own server, its address); the engine checks it with GitLab and only then keeps it in the locker
   (POST /api/gitlab/connect, src/gitlab-connection.ts). The token is never read back into the window. Disconnect takes
   it out of the locker again (POST /api/gitlab/disconnect), after a yes, as it can't be undone. */
import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { t } from "../../i18n.js";

export const G = { view: null };

export async function loadGitlab() {
  try { G.view = await api("gitlab"); } catch (error) { toast(error.message); G.view = null; }
}

/* The row under the switch: who it is connected to, or a way to connect. Drawn only while the switch is on. */
export function gitlabRow() {
  const v = G.view;
  if (!v || v.settings?.mode === "off") return "";
  const a = v.account ?? {};
  const line = a.connected && !a.fromLaunchFile ? t("window.settings.gitlab.connected", { server: a.server, who: a.who })
    : a.fromLaunchFile ? t("window.settings.gitlab.from-launch", { server: a.server }) : t("window.settings.gitlab.not-connected");
  const button = a.connected && !a.fromLaunchFile
    ? `<button class="btn sm" type="button" data-act="gl-disconnect">${esc(t("window.settings.gitlab.disconnect"))}</button>`
    : `<button class="btn sm pri" type="button" data-act="gl-connect">${esc(t("window.settings.gitlab.connect"))}</button>`;
  return `<div class="ctl" id="gl-row"><b>${esc(t("window.settings.gitlab.connection"))}</b><span class="right">${button}</span><small>${esc(line)}</small></div>`;
}

function connectDialog() {
  const body = `<div class="fld"><label for="gl-server">${esc(t("window.settings.gitlab.server"))}</label><input class="inp" id="gl-server" value="gitlab.com" spellcheck="false" autocomplete="off"></div>`
    + `<div class="fld"><label for="gl-token">${esc(t("window.settings.gitlab.token"))}</label><input class="inp" id="gl-token" type="password" spellcheck="false" autocomplete="off"></div>`
    + `<p class="hint" data-css="margin:0">${esc(t("window.settings.gitlab.token-note"))}</p>`;
  const foot = `<button class="btn ghost" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>`
    + `<button class="btn pri" type="button" data-act="gl-connect-go">${esc(t("window.settings.gitlab.connect"))}</button>`;
  openDlg({ title: t("window.settings.gitlab.title"), body, foot });
}

async function connect() {
  const server = document.getElementById("gl-server")?.value.trim() || "gitlab.com";
  const token = document.getElementById("gl-token")?.value.trim() ?? "";
  try { G.view = await api("gitlab/connect", { token, apiBase: server }); } catch (error) { toast(error.message); return; }
  closeDlg();
  toast(t("window.settings.gitlab.connected-toast"));
  render();
}

function disconnectDialog() {
  openDlg({ title: t("window.settings.gitlab.disconnect-title"), body: `<p data-css="margin:0">${esc(t("window.settings.gitlab.disconnect-body"))}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("window.core.keep-it")}</button><button class="btn bad" type="button" data-act="gl-disconnect-yes">${esc(t("window.settings.gitlab.disconnect"))}</button>` });
}

async function disconnect() {
  try { G.view = await api("gitlab/disconnect", {}); } catch (error) { toast(error.message); return; }
  closeDlg();
  toast(t("window.settings.gitlab.disconnected-toast"));
  render();
}

export function initGitlab() {
  markLive(["gl-connect", "gl-connect-go", "gl-disconnect", "gl-disconnect-yes", "sw:gl-server", "sw:gl-token"]);
  on("gl-connect", () => connectDialog());
  on("gl-connect-go", () => connect());
  on("gl-disconnect", () => disconnectDialog());
  on("gl-disconnect-yes", () => disconnect());
}
