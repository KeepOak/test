/* Customize › Tools › Plugins: where a plugin you placed yourself runs (RES-251). A plugin you put in the plugins folder
   runs as its own walled program; those already switched on before that kept running inside Branch, listed once in a
   notice with "Wall it" beside each and "Keep them as they are". Each one's own row says where it runs: "Wall it" always
   goes; "Let it run inside Branch" is less careful, so the engine's own words are shown and only "Yes" sends it again
   (POST /api/plugin-catalog/add-ons/inside { id, inside, confirmLoosening }), refused under Lockdown. A plugin installed
   from a package always runs walled and has no row. */
import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast, openDlg, closeDlg } from "../core/ui.js";
import { t } from "../../i18n.js";

const W = (key, vars) => t(`window.places.customize.plugin-${key}`, vars);
let asked = null; // { id, inside } waiting for the owner's yes

/** The notice (once, while any kept plugin is left) and this plugin's own row. */
export function insideSection(x, settings, plugins, reload) {
  if (!settings || x.shelf) return "";
  const name = (id) => plugins.find((p) => p.id === id)?.name ?? id;
  const kept = settings.grandfathered ?? [];
  const notice = kept.length ? `<div class="sec plug-kept8"><h2>${esc(W("kept-title"))}</h2><p class="hint">${esc(W("kept-lead"))}</p>
    <div class="rows">${kept.map((id) => `<div class="prow"><span class="grow"><b>${esc(name(id))}</b></span><button class="btn sm" type="button" data-act="plug-wall" data-id="${esc(id)}">${esc(W("wall-it"))}</button></div>`).join("")}</div>
    <div class="acts"><button class="btn ghost sm" type="button" data-act="plug-keep">${esc(W("keep-them"))}</button></div></div>` : "";
  const inside = !settings.wallEveryPlugin || (settings.insideBranch ?? []).includes(x.id);
  const act = inside
    ? `<button class="btn sm" type="button" data-act="plug-wall" data-id="${esc(x.id)}">${esc(W("wall-it"))}</button>`
    : `<button class="btn ghost sm" type="button" data-act="plug-inside" data-id="${esc(x.id)}">${esc(W("let-inside"))}</button>`;
  const allWalledOff = !settings.wallEveryPlugin; // the owner chose every hand-placed plugin inside; that switch decides
  return `${notice}<div class="sec"><h2>${esc(W("where"))}</h2><div class="ctl"><b>${esc(inside ? W("runs-inside") : W("runs-walled"))}</b><span class="right">${allWalledOff ? "" : act}</span><small>${esc(inside ? W("inside-note") : W("walled-note"))}</small></div></div>`;
}

async function send(body, reload) {
  try { await api("plugin-catalog/add-ons/inside", body); } catch (error) {
    if (error.status === 409 && /less careful/.test(error.message) && !body.confirmLoosening) {
      asked = body;
      openDlg({ title: W("inside-title"), body: `<p class="lead-b17">${esc(error.message)}</p>`,
        foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="plug-inside-yes">${t("settings-kit.confirm")}</button>` });
      return;
    }
    toast(error.message);
  }
  await reload();
}

export function initPluginInside(reload) {
  on("plug-wall", (el) => send({ id: el.dataset.id, inside: false }, reload));
  on("plug-inside", (el) => send({ id: el.dataset.id, inside: true }, reload));
  on("plug-inside-yes", () => { const body = asked; asked = null; closeDlg(); if (body) send({ ...body, confirmLoosening: true }, reload); });
  on("plug-keep", async () => { try { await api("plugin-catalog/add-ons/kept", {}); } catch (error) { toast(error.message); } await reload(); });
}
export const pluginInsideLive = ["plug-wall", "plug-inside", "plug-inside-yes", "plug-keep"];
