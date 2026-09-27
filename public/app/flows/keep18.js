/* Keep it running, in Overview's "Finish setting up" (places/overview.js): one plain line each to turn off what a new
   install ships on (src/keep-running.ts; updating by itself in src/comfort/settings.ts; the ship-on rule), drawn from the engine and saved at once through its route:
   - the gateway: GET/POST /api/never-break. "when-needed" and "on" both run it (src/never-break/gateway-config.ts), so
     it reads as on and saves "on" or "off"; it takes effect the next time Branch starts, said under its line once saved.
   - starting at sign-in: GET /api/deployment autostart, POST /api/deployment/autostart. Only an installed app can be
     registered, so a source checkout says so and only this switch is off; a Mac may want it approved in System Settings.
   - updating by itself: GET/POST /api/comfort, notify.autoUpdate "install" or "off".
   A switch the engine has not answered for yet is drawn off and not clickable, never as a guess. */
import { app, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { renderNow } from "../core/dom.js";
import { t } from "../../i18n.js";

const K = { ready: false, readAt: 0, gw: null, boot: null, upd: null, platform: "", note: false, busy: new Set() };
const mac = () => app()?.dataset.surface === "mac";
const ctl = (id, name, sub, on, off) => `<div class="ctl"><b>${name}</b><input class="sw" type="checkbox" id="${id}" aria-label="${name}" data-sw="${id}" ${on ? "checked" : ""} ${off ? "disabled" : ""}><small>${sub}</small></div>`;

function bootWhy(boot) {
  if (boot.available) return "";
  if (!boot.installed) return t(K.platform === "darwin" ? "window.flows.setup.boot-install-mac" : K.platform === "win32" ? "window.flows.setup.boot-install-windows" : "window.flows.setup.boot-install-other");
  return t("window.flows.setup.boot-not-here");
}

function bootNote(boot) {
  const why = bootWhy(boot);
  if (why) return `<p class="hint">${why}</p>`;
  if (!boot.needsApproval) return "";
  const open = boot.settingsLink && typeof window.branchDesktop?.openExternal === "function"
    ? `<button class="btn sm" type="button" data-act="fin-login-items">${t("action.open-system-settings")}</button>` : "";
  return `<p class="hint">${t("window.flows.setup.boot-approve")}</p>${open}`;
}

/* The three lines, as the engine has them now. */
export function keepLines() {
  const off = (name, known) => !K.ready || !known || K.busy.has(name);
  const gw = ctl("fin-gw", t("window.flows.setup.gateway"), t("window.flows.setup.gateway-hint"), K.gw != null && K.gw !== "off", off("gw", K.gw != null));
  const boot = ctl("fin-boot", mac() ? t("window.flows.setup.start-mac") : t("window.flows.setup.start-windows"), mac() ? t("window.flows.setup.menu-bar") : t("window.flows.setup.tray"),
    K.boot?.enabled === true, off("boot", K.boot?.available === true));
  const upd = ctl("fin-upd", t("comfort.update.install"), t("window.flows.setup.upd-hint"), K.upd === "install", off("upd", K.upd != null));
  return `<div class="keep18c">${gw}${K.note ? `<p class="hint">${t("never-break.saved")}</p>` : ""}${boot}${K.boot ? bootNote(K.boot) : ""}${upd}</div>`;
}

/* Read again at most every 30 seconds while Overview is open; answers whether anything changed. A read that fails
   says why and leaves its line off. */
export async function loadKeep() {
  if (Date.now() - K.readAt < 30000) return false;
  K.readAt = Date.now();
  const read = (path) => api(path).catch((error) => { toast(error.message); return null; });
  const [gw, dep, comfort] = await Promise.all([read("never-break"), read("deployment"), read("comfort")]);
  const before = JSON.stringify([K.ready, K.gw, K.boot, K.upd]);
  K.gw = gw?.mode ?? null;
  K.boot = dep?.autostart ? { ...dep.autostart, installed: dep.installed === true } : null;
  K.platform = dep?.platform ?? "";
  K.upd = comfort?.values?.notify?.autoUpdate ?? null;
  K.ready = true;
  return before !== JSON.stringify([K.ready, K.gw, K.boot, K.upd]);
}

const SAVE = {
  gw: async (on) => { const view = await api("never-break", { mode: on ? "on" : "off" }); K.gw = view.mode; K.note = !!view.note; },
  boot: async (on) => { const view = await api("deployment/autostart", { enabled: on }); K.boot = { ...K.boot, ...view }; },
  upd: async (on) => { const view = await api("comfort", { card: "notify", values: { autoUpdate: on ? "install" : "off" } }); K.upd = view.values?.notify?.autoUpdate ?? K.upd; },
};

async function save(name, on) {
  K.busy.add(name);
  renderNow();
  try { await SAVE[name](on); } catch (error) { toast(error.message); }
  K.busy.delete(name);
  renderNow();
}

export function initKeep() {
  markLive(["sw:fin-gw", "sw:fin-boot", "sw:fin-upd", "fin-login-items"]);
  on("fin-login-items", () => { const link = K.boot?.settingsLink; if (link) Promise.resolve(window.branchDesktop?.openExternal?.(link)).catch((error) => toast(error.message)); });
  const IDS = { "fin-gw": "gw", "fin-boot": "boot", "fin-upd": "upd" };
  document.addEventListener("change", (e) => { const name = IDS[e.target.id]; if (name) save(name, e.target.checked); });
}
