/* Only the engine's bounded catalogue fields: no arbitrary JSON, launch file, locker, or secret editor. */
import { esc } from "../core/dom.js";
import { E, activeId } from "../core/state.js";
import { api, token } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, toast } from "../core/ui.js";
import { gsel } from "../core/gsel.js";
import { controlRow } from "./row-kit.js";
import { fieldHelp } from "./field-help.js";
import { t } from "../../i18n.js";

let session = null, serial = 0, pending = null, started = false;
const locked = () => document.getElementById("app")?.classList.contains("locked");
const snapshot = () => ({ profile: E.profiles, id: activeId(), credential: token.get() });
const valid = state => session === state && E.profiles === state.profile && activeId() === state.id && token.get() === state.credential && E.profiles?.isOwner === true && !locked();
const word = (key, fallback) => t(key) === key ? fallback : t(key);

export function catalogueLink() {
  return controlRow(`<b>${esc(t("settings.catalogue.title"))}</b><span class="right"><button class="btn sm" type="button" data-act="settings-catalogue">${esc(t("ov.open"))}</button></span><small>${esc(t("settings.catalogue.about"))}</small>`);
}

function input(row, i) {
  const kind = row.field.kind, id = `catalogue-${serial}-${i}`;
  if (kind.type === "number") return `<input class="inp" type="number" id="${id}" min="${kind.min}" max="${kind.max}" step="${kind.fractions ? "any" : "1"}" value="${typeof row.field.value === "number" ? row.field.value : ""}" aria-label="${esc(row.title)}">`;
  const values = kind.type === "switch" ? ["off", "when-needed", "on"] : kind.type === "yes-no" ? [false, true] : kind.options;
  return gsel({ id, label: row.title, options: values.map(value => [String(value), String(value)]), value: String(row.field.value) });
}

function draw(state) {
  if (!valid(state)) return;
  const body = state.rows.map((row, i) => {
    const { spec, field } = row, why = spec.refused || (field.pinned ? t("settings.catalogue.pinned") : "");
    const control = why ? `<span>${esc(why)}</span>` : `${input(row, i)}<button class="btn sm" type="button" data-act="catalogue-save" data-i="${i}">${esc(t("settings.catalogue.save"))}</button>${field.kind.unset ? `<button class="btn ghost sm" type="button" data-act="catalogue-unset" data-i="${i}">${esc(field.kind.unset)}</button>` : ""}`;
    const path = `settings-kit.${spec.key}.${field.field}`;
    const note = [field.note, fieldHelp(path), field.kind.type === "number" ? `${field.kind.min}–${field.kind.max}` : "", spec.key === "listen-address" ? t("settings.catalogue.listen-restart") : ""].filter(Boolean).join(" ");
    return controlRow(`<b>${esc(row.title)}</b><span class="right">${control}</span><small>${esc(note)}</small>`, { configPath: path, help: note });
  }).join("");
  markLive(["catalogue-save", "catalogue-unset", ...state.rows.map((_, i) => `sw:catalogue-${serial}-${i}`)]);
  openDlg({ title: t("settings.catalogue.title"), wide: true, body: `<p>${esc(t("settings.catalogue.count", { count: state.rows.length }))}</p>${body}` });
}

async function freshOwner(state) {
  if (!valid(state)) throw new Error(t("settings.catalogue.changed"));
  const profiles = await api("profiles");
  if (!valid(state) || !profiles.isOwner || (profiles.active?.id ?? null) !== state.id) throw new Error(t("settings.catalogue.changed"));
}

async function open() {
  if (E.profiles?.isOwner !== true || locked()) return toast(t("settings.catalogue.owner"));
  const state = { ...snapshot(), rows: [] }; session = state; pending = null; serial++;
  try {
    await freshOwner(state);
    const kit = await api("settings-kit");
    if (!valid(state)) return;
    state.rows = kit.settings.flatMap(spec => spec.fields.filter(field => ["switch", "yes-no", "choice", "number"].includes(field.kind?.type)).map(field => ({spec, field, title: `${word(spec.t, spec.name)} · ${word(field.t, field.label)}`})));
    draw(state);
  } catch (error) { if (session === state) toast(error.message); }
}

async function save(el, unset = false) {
  const state = session, row = state?.rows[Number(el.dataset.i)];
  if (!row || pending || row.spec.refused || row.field.pinned || !valid(state)) return;
  const box = document.getElementById(`catalogue-${serial}-${el.dataset.i}`), kind = row.field.kind;
  const value = unset ? kind.unset : kind.type === "yes-no" ? box.value === "true" : kind.type === "number" ? (box.value.trim() === "" ? NaN : Number(box.value)) : box.value;
  if (kind.type === "number" && !unset && (!Number.isFinite(value) || value < kind.min || value > kind.max || (!kind.fractions && !Number.isInteger(value)))) return toast(t("settings.catalogue.range"));
  pending = { state, row, value }; el.disabled = true;
  try { await apply(pending, false); }
  catch (error) {
    if (valid(state) && /less careful/.test(error.message)) {
      openDlg({title: t("settings-kit.loosens"), body: `<p>${esc(error.message)}</p>`, foot: `<button class="btn ghost" type="button" data-act="catalogue-cancel">${esc(t("mode.cancel"))}</button><button class="btn" type="button" data-act="catalogue-confirm">${esc(t("settings-kit.confirm"))}</button>`});
    } else { if (valid(state)) toast(error.message); if (pending?.state === state) pending = null; }
  }
  finally { if (el.isConnected) el.disabled = false; }
}

async function apply(change, confirmed) {
  const { state, row, value } = change;
  await freshOwner(state);
  const result = await api("settings-kit/apply", { plan: {source: "set", key: row.spec.key, field: row.field.field, value}, accept: [`${row.spec.key}.${row.field.field}`], confirmLoosening: confirmed });
  if (!valid(state)) { if (pending?.state === state) pending = null; return; }
  const refusal = result.skipped?.[0]?.why || result.refused?.[0]?.why || result.refused?.[0]?.reason;
  pending = null;
  if (refusal) toast(refusal);
  await open();
}

export function initCatalogueEditor() {
  if (started) return;
  started = true;
  markLive(["settings-catalogue", "catalogue-confirm", "catalogue-cancel"]);
  on("settings-catalogue", open);
  on("catalogue-save", el => save(el));
  on("catalogue-unset", el => save(el, true));
  on("catalogue-cancel", () => { const state = session; pending = null; if (valid(state)) draw(state); });
  on("catalogue-confirm", async () => { const change = pending; if (!change || !valid(change.state)) return; pending = null; try { await apply(change, true); } catch (error) { toast(error.message); } });
  const app = document.getElementById("app");
  if (app) new MutationObserver(() => { if (locked()) { session = null; pending = null; } }).observe(app, {attributes: true, attributeFilter: ["class"]});
}
