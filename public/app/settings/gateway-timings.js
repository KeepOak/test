import { esc } from "../core/dom.js";
import { E, activeId } from "../core/state.js";
import { api, token } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { controlRow } from "./row-kit.js";
import { t } from "../../i18n.js";

const fields = [["startSeconds", 2, 600], ["holdSeconds", 0, 120], ["maxQuickCrashes", 1, 50], ["gapSeconds", 5, 3600], ["watchSeconds", 10, 3600]];
let current = null, busy = false, generation = 0;
const locked = () => document.getElementById("app")?.classList.contains("locked");
const valid = state => current === state && generation === state.generation && E.profiles === state.profile && activeId() === state.id && token.get() === state.token && E.profiles?.isOwner === true && !locked();

export function timingsLink() {
  return controlRow(`<b>${esc(t("gateway.timings.title"))}</b><span class="right"><button class="btn sm" type="button" data-act="gateway-timings">${esc(t("gateway.timings.edit"))}</button></span><small>${esc(t("gateway.timings.about"))}</small>`);
}

async function open(reload) {
  if (E.profiles?.isOwner !== true || locked() || busy) return;
  const state = {profile: E.profiles, id: activeId(), token: token.get(), generation, reload}; current = state;
  try {
    const gw = await api("never-break");
    if (!valid(state)) return;
    const body = fields.map(([key, min, max]) => controlRow(`<b>${esc(key)}</b><span class="right"><input class="inp" id="timing-${key}" type="number" min="${min}" max="${max}" step="1" value="${esc(gw.config?.[key])}" aria-label="${esc(key)}"></span><small>${esc(t("gateway.timings.range", {min, max}))}</small>`)).join("");
    markLive(fields.map(([key]) => `sw:timing-${key}`));
    openDlg({title: t("gateway.timings.title"), body: `<p>${esc(t("gateway.timings.about"))}</p>${body}<label>${esc(t("gateway.timings.why"))}<input class="inp" id="timing-why" maxlength="500"></label>`, foot: `<button class="btn ghost" type="button" data-act="dlg-close">${esc(t("mode.cancel"))}</button><button class="btn" type="button" data-act="gateway-timings-try">${esc(t("gateway.timings.try"))}</button>`});
  } catch (error) { if (valid(state)) toast(error.message); }
}

async function submit(el) {
  const state = current;
  if (!state || !valid(state) || busy) return;
  const change = {};
  for (const [key, min, max] of fields) {
    const raw = document.getElementById(`timing-${key}`)?.value ?? "", value = Number(raw);
    if (!raw.trim() || !Number.isInteger(value) || value < min || value > max) return toast(t("gateway.timings.invalid"));
    change[key] = value;
  }
  const why = document.getElementById("timing-why")?.value.trim();
  if (!why) return toast(t("gateway.timings.reason"));
  busy = true; el.disabled = true;
  try {
    const profiles = await api("profiles");
    if (!valid(state) || !profiles.isOwner || (profiles.active?.id ?? null) !== state.id) return;
    const result = await api("never-break/proposal/create", {change, why});
    if (!valid(state)) return;
    toast(result.proposal?.check?.detail || t("gateway.timings.waiting"));
    if (el.isConnected) closeDlg();
    await state.reload();
  } catch (error) { if (valid(state)) toast(error.message); }
  finally { busy = false; if (el.isConnected) el.disabled = false; }
}

export function initGatewayTimings(reload) {
  markLive(["gateway-timings", "gateway-timings-try", "sw:timing-why"]);
  on("gateway-timings", () => open(reload));
  on("gateway-timings-try", submit);
  const app = document.getElementById("app");
  if (app) new MutationObserver(() => { if (locked()) { generation++; current = null; } }).observe(app, {attributes: true, attributeFilter: ["class"]});
}
