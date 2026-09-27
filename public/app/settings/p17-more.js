/* Pass 17's rows on the smaller Settings pages (prototype patch17b), each at its own level:
   Gateway › Never break opens the journal of updates tried, kept or rolled back (GET /api/never-break/journal);
   "Try a bad change" would break the running engine on purpose, so it stays greyed. Saved sign-ins › the password
   manager is shown pressed from the engine's own list of services (GET /api/credentials/settings; the engine calls
   1Password "1password") and chosen in pages/secrets.js. Windows Credential Manager is not a service the engine can
   ask, so that one choice is drawn and greyed. Every other row here has no readout in the window yet, so it is drawn
   and greyed. */
import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg } from "../core/ui.js";
import { seg15 } from "./rows15.js";
import { demos17, demo17, row17, sec17, pill17 } from "./rows17.js";
import { t, language } from "../../i18n.js";
import { say } from "../core/words.js";

/* ---------- Gateway ---------- */
export const gateway17 = (lv) => (lv < 1 ? "" : sec17(t("window.settings.p17-more.never-break"),
  row17(t("window.settings.p17-more.canary-journal-and-rollback"), t("window.settings.p17-more.every-change-to-how-branch-runs"), t("window.settings.p17-more.open-the-journal"), "nbb17"))
  + sec17(t("window.settings.p17-more.chat-apps-in-depth"), demos17(["tgdepth", "delivery", "voicenote", "broadcast", "router", "hookaddr"])));

const ENDED = () => ({ activated: ["ok", t("window.places.kept")], superseded: ["ok", t("window.places.kept")], "rolled-back": ["warn", t("window.settings.p17-more.rolled-back")], failed: ["warn", t("window.settings.p17-more.rolled-back")] });
async function openJournal() {
  let entries;
  try { entries = (await api("never-break/journal")).entries ?? []; } catch (error) { toast(error.message); return; }
  const when = (at) => new Date(at).toLocaleString(language(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const rows = entries.map((e) => `<div class="prow"><span class="grow"><b>${esc(e.fromVersion)} → ${esc(e.toVersion)}</b><small>${esc(when(e.finishedAt ?? e.startedAt))}</small></span>${ENDED()[e.state] ? pill17(...ENDED()[e.state]) : ""}</div>`).join("");
  openDlg({ title: t("window.settings.p17-more.never-break-the-journal"), wide: true, body: `<p class="lead-b17">${t("window.settings.p17-more.each-change-to-how-branch-runs")}</p><div class="rows">${rows}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="nbtryb17">${t("window.settings.p17-more.try-a-bad-change")}</button><button class="btn" type="button" data-act="dlg-close">${t("delight.ach.close")}</button>` });
}

/* ---------- Saved sign-ins ---------- */
const VAULT = { bitwarden: "Bitwarden fills sign-ins; Branch never sees them.", onepassword: "1Password fills sign-ins; Branch never sees them.", windows: "Windows Credential Manager, on this computer only." };
/** The prototype's choice for each service the engine knows, and back. */
export const VAULT_SERVICE = { bitwarden: "bitwarden", onepassword: "1password" };
export function secrets17(lv, services) {
  if (lv < 1) return "";
  // Q257: the chosen manager is the first one listed; a choice keeps the other listed behind it.
  const cur = Object.keys(VAULT_SERVICE).find((v) => (services ?? [])[0] === VAULT_SERVICE[v]) ?? null;
  const seg = seg15(t("window.settings.p17-more.password-manager"), cur ? say(VAULT[cur]) : "", [["bitwarden", t("vault-autofill.service.bitwarden")], ["onepassword", t("vault-autofill.service.1password")], ["windows", "Windows"]], cur, "vaultb17")
    .replace('data-act="vaultb17" data-v="windows"', 'data-act="vaultwinb17" data-v="windows"'); // no engine service: greyed
  return sec17(t("window.settings.p17-more.where-passwords-come-from"), seg + demos17(["keys", "locker", "tokens"]));
}

/* ---------- the rest, by page ---------- */
export const computer17 = (lv) => (lv < 1 ? "" : sec17(t("window.settings.p17-more.where-scripts-run-more"), demos17(["troubleshoot", "bgproc", "screenwatch", "profiles", "devpick", "editor"]))
  + (lv >= 2 ? sec17(t("window.settings.p17-more.limits-technical"), demo17("jobobj")) : ""));
export const accounts17 = (lv) => (lv < 1 ? "" : sec17(t("window.settings.p17-more.terms"), demo17("terms")));
export const developer17 = (lv) => (lv < 2 ? "" : sec17(t("window.settings.p17-more.build-on-branch"), demos17(["sdk", "cli", "events", "scopes", "tracing", "studies", "toolreport", "surfaces", "flowyaml"])));
export const updates17 = (lv) => (lv < 1 ? "" : sec17(t("window.settings.p17-more.help-and-updates-more"), demos17(["handbook", "updfix"])));
export const people17 = (lv) => (lv < 1 ? "" : sec17(t("window.settings.p17-more.records"), demo17("signed")));
export const voice17 = (lv) => (lv < 1 ? "" : sec17(t("window.settings.p17-more.talking-more"), demo17("voiceapprove")));
export const appearance17 = (lv) => (lv < 2 ? "" : sec17(t("window.settings.p17-more.window-technical"), demo17("frame")));
export const self17 = (lv) => (lv < 1 ? "" : sec17(t("window.settings.p17-more.settings-you-can-talk-to"), demos17(["talksettings", "learncore"])));

let started = false;
export function initMore17() {
  if (started) return;
  started = true;
  on("nbb17", () => openJournal());
  markLive(["nbb17"]);
}
