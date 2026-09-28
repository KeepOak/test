/* RES-710: "Fill from Bitwarden" beside "Take control" when a task's page waits for the owner to sign in. The owner's
   saved sign-ins (GET /api/vault-autofill/settings: names, websites and which manager holds each, never a value) say
   whether this page's website has one. Pressed, POST /api/panels/browser/fill { sessionId, runId } has the engine read
   the password manager and type straight into the page: the password never comes to this window, nor to the model.
   Greyed, with the reason, when no password manager is connected, filling is switched off, or this website has no
   saved sign-in. */

import { esc, renderNow } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";
import { t } from "../../i18n.js";

const V = { view: null, at: 0, asking: false, busy: false };
const MANAGER = { bitwarden: "vault-autofill.service.bitwarden", "1password": "vault-autofill.service.1password", windows: "vault-autofill.service.windows" };

/* The saved sign-ins, read when a sign-in page first shows and again after half a minute. */
function vault() {
  if (!V.asking && Date.now() - V.at > 30_000) {
    V.asking = true;
    api("vault-autofill/settings").then((view) => { V.view = view; }, () => { V.view = null; })
      .finally(() => { V.asking = false; V.at = Date.now(); renderNow(); });
  }
  return V.view;
}
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };
const forHost = (login, host) => login.site === host || (login.alsoHosts ?? []).includes(host);

/* The button, live or greyed with the reason. `cls` is the button's own look where it is drawn. */
export function fillButton(url, runId, sid, cls = "btn") {
  const view = vault(), host = hostOf(url);
  if (!view || !host || !runId || !sid) return "";
  const match = (view.logins ?? []).filter((login) => forHost(login, host));
  const label = t("window.chat.stage.ob.fill-from", { manager: t(MANAGER[match[0]?.service ?? "bitwarden"]) });
  const why = !view.connected ? t("window.chat.stage.ob.fill-connect")
    : view.mode === "off" ? t("window.chat.stage.ob.fill-off")
      : !match.length ? t("window.chat.stage.ob.fill-save-site", { host }) : "";
  if (why) return `<button class="${cls} soon" type="button" aria-disabled="true" tabindex="-1" data-tip="${esc(why)}">${label}</button>`;
  return `<button class="${cls}" type="button" data-act="needs-fill" data-id="${esc(runId)}" data-sid="${esc(sid)}">${label}</button>`;
}

async function fill(el) {
  if (V.busy) return;
  V.busy = true;
  try {
    const done = await api("panels/browser/fill", { sessionId: el.dataset.sid, runId: el.dataset.id });
    toast(t("window.chat.stage.ob.filled", { name: done.login, host: done.site }));
  } catch (error) { toast(error.message); } finally { V.busy = false; }
}

export function initVaultFill() {
  markLive(["needs-fill"]);
  on("needs-fill", (el) => { void fill(el); });
}
