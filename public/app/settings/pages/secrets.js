/* Settings › Saved sign-ins: the sign-ins the owner said Branch may fill (GET /api/vault-autofill/settings), never a
   password. Remove takes one off that list (POST /api/vault-autofill/settings { logins }, which replaces the list, so the
   rest are sent back as they were). The status line is shown only when the engine has Bitwarden set up as a service
   (GET /api/credentials/settings). Choosing the password manager (pass 17) is POST /api/credentials/settings
   { choose: one } (Q257): the engine puts that manager first, keeps any other already listed with its command, and
   never touches its on/off switch. Both routes
   are the owner's alone. No password or key value is ever shown: the engine has no route that gives one back, and
   the prototype shows none. */
import { esc, render } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { toast, ic } from "../../core/ui.js";
import { secrets17, VAULT_SERVICE } from "../p17-more.js";
import { level as level17 } from "../../core/state.js";
import { t } from "../../../i18n.js";

const MASK = "••••••••";
let vault = null;
let credentials = null;

async function loadAll() {
  const [v, c] = await Promise.all(["vault-autofill/settings", "credentials/settings"]
    .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  vault = v; credentials = c;
  render();
}

async function remove(name) {
  const logins = (vault?.logins ?? []).filter((x) => x.name !== name);
  try { await api("vault-autofill/settings", { logins }); toast(t("window.settings.secrets.name-removed-from-what-branch-may", { name })); } catch (error) { toast(error.message); }
  await loadAll();
}

const VAULT_NAME = { bitwarden: "vault-autofill.service.bitwarden", onepassword: "vault-autofill.service.1password" };
async function chooseVault(v) {
  const service = VAULT_SERVICE[v];
  if (!service) return;
  try { await api("credentials/settings", { choose: service }); toast(t("window.settings.secrets.sign-ins-now-come-from", { name: t(VAULT_NAME[v]) })); } catch (error) { toast(error.message); }
  await loadAll();
}

export function init() {
  on("secret-rm", (el) => remove(el.dataset.name));
  on("vaultb17", (el) => chooseVault(el.dataset.v));
  markLive(["secret-rm", "vaultb17"]);
  loadAll();
}

export async function load() { await loadAll(); }

export const live = { "secret-rm": true, "vaultb17": true };

function rows() {
  return (vault?.logins ?? []).map((s) => `<div class="prow"><span class="ico-tile">${ic("key", "s")}</span><span class="grow"><b>${esc(s.name)}</b><small>${esc(s.site)}</small></span><span class="meta">${MASK}</span><button class="btn ghost sm" type="button" data-act="secret-rm" data-name="${esc(s.name)}">${t("accounts.action.remove")}</button></div>`).join("");
}

export function draw() {
  const bitwarden = credentials?.enabled && (credentials.services ?? []).includes("bitwarden");
  const status = bitwarden ? `<div class="status"><span class="sdot "></span><div><b>${t("window.settings.secrets.bitwarden-is-connected")}</b><p>${t("window.settings.secrets.branch-asks-bitwarden-to-fill-a")}</p></div></div>` : "";
  return `<h1>${t("window.settings.secrets.saved-sign-ins")}</h1><p class="lede">${t("window.settings.secrets.sign-ins-branch-may-fill-for")}</p>${status}<div class="sec"><h2>${t("window.settings.secrets.branch-may-fill")}</h2><div class="rows">${rows()}</div></div>${secrets17(level17(), credentials?.services)}`;
}
