import { esc } from "../core/dom.js";
import { ownerHere, S } from "../core/state.js";
import { api } from "../core/api.js";
import { openDlg, closeDlg, dialog, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t, language } from "../../i18n.js";

let saving = false;
let generation = 0;
const button = (act, label, extra = "") => `<button class="btn sm" type="button" data-act="${act}" ${extra}>${esc(label)}</button>`;
const close = () => button("dlg-close", t("delight.ach.close"));
function field(id, label, type = "text", value = "", extra = "") {
  return `<div class="field"><label for="pw-${id}">${esc(label)}</label><input class="inp" id="pw-${id}" type="${type}" value="${esc(value)}" required ${extra}></div>`;
}

export async function openPriceWatches() {
  if (!ownerHere()) return;
  const ticket = ++generation, view = S.view, before = dialog();
  try {
    const { monitors } = await api("monitors");
    if (ticket !== generation || !ownerHere() || S.view !== view || dialog() !== before) return;
    const rows = monitors.map((watch) => `<div class="prow"><span class="grow"><b>${esc(watch.label)}</b><small>${esc(watch.target)}</small>
      ${watch.price ? `<small>${esc(watch.price.item)} · ${esc(watch.price.currency)} ${watch.lastPrice?.amount ?? "?"} · ${t("pricewatch.below")} ${watch.price.below}</small>` : ""}</span>
      ${watch.price ? button("pricewatch-history", t("pricewatch.history"), `data-id="${esc(watch.id)}"`) : ""}</div>`).join("");
    openDlg({ title: t("window.places.automations17.watches"), body: rows || `<p>${t("pricewatch.empty")}</p>`,
      foot: close() + button("pricewatch-new", t("pricewatch.add")) });
  } catch (error) { if (ownerHere()) toast(error.message); }
}

export function newPriceWatch() {
  if (!ownerHere() || saving) return;
  generation += 1;
  const body = `<div id="price-watch-new"><p>${t("pricewatch.help")}</p>`
    + field("item", t("pricewatch.item"), "text", "", 'maxlength="120"')
    + field("url", t("pricewatch.url"), "url", "", 'maxlength="2048"')
    + field("label", t("pricewatch.label"), "text", "", 'maxlength="80"')
    + field("marker", t("pricewatch.marker"), "text", "$", 'maxlength="8"')
    + field("currency", t("pricewatch.currency"), "text", "USD", 'pattern="[A-Za-z]{3}" maxlength="3"')
    + field("below", t("pricewatch.threshold"), "number", "", 'min="0.001" max="1000000000" step="0.001"')
    + field("decimals", t("pricewatch.decimals"), "number", "2", 'min="0" max="3" step="1"')
    + `<div class="field"><label for="pw-separator">${t("pricewatch.format")}</label><select class="inp" id="pw-separator"><option value=".">1,234.56</option><option value=",">1.234,56</option></select></div>`
    + field("every", t("pricewatch.every"), "number", "360", 'min="5" max="43200" step="1"') + "</div>";
  openDlg({ title: t("pricewatch.add"), body, foot: close() + button("pricewatch-save", t("action.save")) });
}

async function savePriceWatch(el) {
  const box = document.getElementById("price-watch-new");
  if (!ownerHere() || !box || saving) return;
  for (const input of box.querySelectorAll("input")) if (!input.checkValidity()) { input.reportValidity(); return; }
  const value = (key) => box.querySelector(`#pw-${key}`).value.trim();
  const price = { item: value("item"), label: value("label"), currencyMarker: value("marker"), currency: value("currency").toUpperCase(),
    below: Number(value("below")), decimals: Number(value("decimals")), decimalSeparator: value("separator") };
  saving = true; el.disabled = true;
  try {
    await api("monitors", { url: value("url"), label: price.item, every: Number(value("every")), notifyVia: "activity", price });
    if (ownerHere() && document.contains(box)) { closeDlg(); await openPriceWatches(); }
  } catch (error) { if (ownerHere() && document.contains(box)) toast(error.message); }
  finally { saving = false; el.disabled = false; }
}

async function showPrices(el) {
  if (!ownerHere()) return;
  const ticket = ++generation, view = S.view, before = dialog();
  try {
    const { currency, prices } = await api(`monitors/${encodeURIComponent(el.dataset.id)}/prices`);
    if (ticket !== generation || !ownerHere() || S.view !== view || dialog() !== before) return;
    const rows = [...prices].reverse().map((point) => `<tr><td>${esc(new Date(point.at).toLocaleString(language()))}</td><td>${esc(currency)} ${point.amount}</td></tr>`).join("");
    openDlg({ title: t("pricewatch.history"), body: `<p>${t("pricewatch.retained")}</p><table><thead><tr><th>${t("pricewatch.observed")}</th><th>${t("pricewatch.price")}</th></tr></thead><tbody>${rows}</tbody></table>`, foot: close() });
  } catch (error) { if (ownerHere()) toast(error.message); }
}

export function initPriceWatches() {
  markLive(["sw:pw-item", "sw:pw-url", "sw:pw-label", "sw:pw-marker", "sw:pw-currency", "sw:pw-below", "sw:pw-decimals", "sw:pw-separator", "sw:pw-every", "pricewatch-new", "pricewatch-save", "pricewatch-history"]);
  on("pricewatch-new", () => newPriceWatch());
  on("pricewatch-save", (el) => savePriceWatch(el));
  on("pricewatch-history", (el) => showPrices(el));
}
