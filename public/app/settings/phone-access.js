/* Settings › Chat apps › Drive a task's browser from your phone (src/miniapp/phone-access.ts). Telegram only opens its
   Mini App from an HTTPS address, which the owner's Tailscale gives this computer when it forwards one path to the
   Mini App's own door. "Turn on phone access" shows the exact command first and runs it only on the owner's yes;
   "Turn off" does the same with the command that removes that path again. Greyed, with the reason, until an App lock
   PIN is set (the phone asks for it every time) or while the door isn't open. */
import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { t } from "../../i18n.js";

const P = { view: null };
const quoted = (command) => command.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `"${part}"`)).join(" ");

export async function loadPhoneAccess() {
  try { P.view = (await api("miniapp/phone-access")).phoneAccess; } catch { P.view = null; }
}
export function phoneAccessCard() {
  const view = P.view;
  if (!view) return "";
  // Greyed with its reason (core/why.js): a control with no handler behind it is never marked live.
  const why = view.url ? "" : !view.pinSet ? "phone-access-needs-pin" : !view.on ? "phone-access-no-door" : "";
  const line = view.url ? t("window.phone-access.on", { url: view.url }) : t("window.phone-access.off");
  const act = view.url ? "phone-access-off" : why || "phone-access-on";
  const button = `<button class="btn sm" type="button" data-act="${act}"${why ? ` data-why="${why}"` : ""}>${esc(t(view.url ? "window.phone-access.turn-off" : "window.phone-access.turn-on"))}</button>`;
  return `<div class="rows"><div class="ctl" data-phone-access="${view.url ? "on" : "off"}"><b>${esc(t("window.phone-access.title"))}</b><span class="right">${button}</span><small>${esc(line)}</small></div></div>`;
}
function ask(turn) {
  const command = P.view?.[turn];
  if (!command) return;
  openDlg({ title: t(turn === "on" ? "window.phone-access.ask-on" : "window.phone-access.ask-off"),
    body: `<p>${esc(t(turn === "on" ? "window.phone-access.explain-on" : "window.phone-access.explain-off"))}</p><pre class="code" id="phone-access-command">${esc(quoted(command))}</pre>
      <div class="acts"><button class="btn ghost" type="button" data-act="phone-access-cancel">${esc(t("window.phone-access.cancel"))}</button><button class="btn pri" type="button" data-act="phone-access-run" data-v="${turn}">${esc(t("window.phone-access.run"))}</button></div>` });
}
export function initPhoneAccess(reload) {
  markLive(["phone-access-on", "phone-access-off", "phone-access-run", "phone-access-cancel"]);
  on("phone-access-on", () => ask("on"));
  on("phone-access-off", () => ask("off"));
  on("phone-access-cancel", () => closeDlg());
  on("phone-access-run", async (el) => {
    const turn = el.dataset.v, command = P.view?.[turn];
    if (!command) return;
    el.disabled = true;
    try { P.view = (await api("miniapp/phone-access", { turn, command })).phoneAccess; closeDlg(); }
    catch (error) { toast(error.message); el.disabled = false; }
    await reload();
  });
}
