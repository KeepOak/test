/* Settings › Advanced › Reach webhooks from outside: a public address for incoming webhooks and nothing else
   (src/personal/tunnel.ts). Branch's own window never goes on the internet: a small door on this computer passes on
   only the addresses chat services and triggers post to, each still checked by its own signature inside Branch.
   The pressed choice is what runs now (GET /api/personal/tunnel status): Off, or the program the owner's own tunnel runs
   with. Choosing a program switches the personal part "tunnel" on, saves the program (keeping any full path already
   saved) and starts it (POST /api/personal/tunnel/start); the public address it prints is shown to the owner once, and
   a program that is missing or not signed in is refused in the engine's own words. Off stops it. Lockdown refuses a
   start in the engine. A household person is refused by the engine, as with every owner setting. */
import { esc, render } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast, openDlg } from "../core/ui.js";
import { t } from "../../i18n.js";

const PROGRAMS = [["cloudflared", "cloudflared"], ["ngrok", "ngrok"], ["tailscale", "Tailscale"]];
const T = { state: null, busy: false };
const W = (key, vars) => t(`window.settings.advanced.${key}`, vars);

export async function loadTunnel() {
  T.state = await api("personal/tunnel").catch(() => null);
}

export function tunnelSeg() {
  const title = W("reach-webhooks-from-outside");
  const running = T.state?.status?.running ? T.state.settings?.program ?? null : null;
  const opt = (v, words) => `<button type="button" aria-pressed="${T.state ? String((running ?? "off") === v) : "false"}" data-act="tunnel-seg" data-v="${v}"${T.busy ? " disabled" : ""}>${esc(words)}</button>`;
  const note = running && T.state?.status?.address ? W("tunnel-running") : t("personal.tunnel.purpose");
  return `<div class="ctl"><b>${esc(title)}</b><span class="right"><span class="seg" role="group" aria-label="${esc(title)}">${opt("off", t("accounts.switch.off"))}${PROGRAMS.map(([v, words]) => opt(v, words)).join("")}</span></span><small>${esc(note)}</small></div>`;
}

async function start(program) {
  await api("personal/switch", { part: "tunnel", mode: "when-needed" });
  if (T.state?.status?.running) await api("personal/tunnel/stop", {});
  await api("personal/tunnel", { ...(T.state?.settings ?? {}), program });
  const now = await api("personal/tunnel/start", {});
  if (now?.address) openDlg({ title: W("tunnel-open-title"), body: `<p class="lead-b17">${esc(W("tunnel-open-lead"))}</p><p><code class="code15">${esc(now.address)}</code></p>` });
}

async function choose(v) {
  if (T.busy) return;
  T.busy = true;
  render();
  try {
    if (v === "off") await api("personal/tunnel/stop", {});
    else await start(v);
  } catch (error) { toast(error.message); }
  T.busy = false;
  await loadTunnel();
  render();
}

export function initTunnel() {
  on("tunnel-seg", (el) => choose(el.dataset.v));
}
export const tunnelLive = ["tunnel-seg"];
