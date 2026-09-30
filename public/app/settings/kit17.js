import { fieldHelp } from "./field-help.js";
import { segmentedRow } from "./row-kit.js";
/* Settings rows that are the engine's own settings (parity B5). Two engine stores back them:
   the settings kit: GET /api/settings-kit lists every setting with its value; POST /api/settings-kit/apply
     { plan: { source: "set", key, field, value }, accept: ["key.field"] } changes one field. A change that makes Branch
     less careful is refused unless confirmLoosening is sent, so it is sent first without it; the engine's own words are
     then shown in a confirm, and only its "Yes, make it less careful" sends it again. Lockdown and pins refuse in their
     own words. Every change is recorded (Settings › Branch itself › Every change) and can be rolled back there.
   the knobs: GET /api/knobs; POST /api/knobs { card, values } saves the named fields of one card, keeping the rest.
   A page lists its switches and number boxes in a table { id: binding } and hands its change events to changed(); its
   segmented controls carry data-act="kitseg17" or "knobseg17" with the value as JSON. After every answer both stores
   are read again and the page is drawn from what the engine now says. */
import { esc, render } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast, openDlg, closeDlg } from "../core/ui.js";
import { t } from "../../i18n.js";

export const K = { kit: null, knobs: null };
let pending = null;

/** Reads both stores; the knobs are the owner's alone, so a household person reads only the kit. */
export async function loadKit() {
  const owner = E.profiles?.isOwner !== false;
  const [kit, knobs] = await Promise.all([api("settings-kit").catch((error) => { toast(error.message); return null; }),
    owner ? api("knobs").catch((error) => { toast(error.message); return null; }) : null]);
  Object.assign(K, { kit, knobs });
  render();
}

export const spec = (key) => K.kit?.settings?.find((s) => s.key === key) ?? null;
export const kitVal = (key, field = "mode") => spec(key)?.fields?.find((f) => f.field === field)?.value;
/** A switch is on for any engine value but off (a yes/no is itself). */
export const kitOn = (key, field = "mode") => { const v = kitVal(key, field); return v === true || (typeof v === "string" && v !== "off"); };
export const knob = (card, field) => K.knobs?.values?.[card]?.[field];

const refusal = (done) => done.skipped?.[0]?.why ?? done.refused?.[0]?.why ?? done.refused?.[0]?.reason;

/** One field of the kit; a loosening waits for the owner's yes in a confirm that shows the engine's words. */
export async function kitSet(key, field, value, confirmLoosening = false) {
  try {
    const done = await api("settings-kit/apply", { plan: { source: "set", key, field, value }, accept: [`${key}.${field}`], ...(confirmLoosening ? { confirmLoosening } : {}) });
    if (!done.applied?.length && refusal(done)) toast(refusal(done));
    if (done.overview) K.kit = done.overview;
  } catch (error) {
    if (!confirmLoosening && /less careful/.test(error.message)) {
      pending = { key, field, value };
      openDlg({ title: spec(key)?.name ?? "", body: `<p data-css="margin:0">${esc(error.message)}</p>`,
        foot: `<button class="btn ghost" type="button" data-act="kitkeep17">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="kitconf17">${t("settings-kit.confirm")}</button>` });
    } else toast(error.message);
  }
  await loadKit();
}

/** Named fields of one knobs card. */
export async function knobSet(card, values) {
  try { K.knobs = await api("knobs", { card, values }); } catch (error) { toast(error.message); }
  await loadKit();
}

/* A binding is { key, field, on, off } for a kit switch (on/off default to "on"/"off", or true/false for a yes/no),
   { key, field, num: true } for a kit number, or { card, field, get(v), set(box) } for a knob number or switch. */
export function changed(el, table) {
  const b = table[el?.id];
  if (!b) return;
  if (b.card) {
    const value = b.set(el);
    if (value === undefined) { render(); return; }
    knobSet(b.card, { [b.field]: value });
    return;
  }
  if (b.num) {
    if (!/^\d+$/.test(el.value.trim())) { render(); return; }
    kitSet(b.key, b.field, Number(el.value));
    return;
  }
  const yesNo = typeof kitVal(b.key, b.field) === "boolean";
  kitSet(b.key, b.field, el.checked ? (b.on ?? (yesNo ? true : "on")) : (b.off ?? (yesNo ? false : "off")));
}

/** A number box drawn from a knob: empty until the engine has said what it keeps; "" when it keeps none. */
export const numBox = (id, title, value, unit = "") =>
  `<span class="right num15"><input class="inp" id="${esc(id)}" value="${esc(value ?? "")}" aria-label="${esc(title)}">${unit ? `<small>${esc(unit)}</small>` : ""}</span>`;

/** A segmented control on a kit field: opts are [value, label]; the pressed one is the engine's value. */
export const kitSeg = (title, sub, key, field, opts) => segmentedRow({title, description: sub, help: fieldHelp(`settings-kit.${key}.${field}`), configPath: `settings-kit.${key}.${field}`, options: opts, action: "kitseg17", valueAttribute: false, selected: v => Boolean(K.kit) && JSON.stringify(kitVal(key, field)) === JSON.stringify(v), attributes: v => `data-key="${esc(key)}" data-field="${esc(field)}" data-j="${esc(JSON.stringify(v))}"`});

/** A segmented control on a knob: opts are [value, label]; `cur` is the engine's value. */
export const knobSeg = (title, sub, card, field, opts, cur) => segmentedRow({title, description: sub, help: fieldHelp(`knobs.${card}.${field}`), configPath: `knobs.${card}.${field}`, options: opts, action: "knobseg17", valueAttribute: false, selected: v => Boolean(K.knobs) && JSON.stringify(cur) === JSON.stringify(v), attributes: v => `data-card="${esc(card)}" data-field="${esc(field)}" data-j="${esc(JSON.stringify(v))}"`});

let started = false;
export function initKit() {
  if (started) return;
  started = true;
  on("kitseg17", (el) => kitSet(el.dataset.key, el.dataset.field, JSON.parse(el.dataset.j)));
  on("knobseg17", (el) => {
    const value = JSON.parse(el.dataset.j);
    /* Thinking effort is kept per connection: the one in use gets the level, the others keep theirs. */
    if (el.dataset.field === "effortByModel") {
      const id = E.state?.models?.defaultPreset;
      if (!id) return;
      knobSet("reasoning", { effortByModel: { ...(knob("reasoning", "effortByModel") ?? {}), [id]: value } });
    } else knobSet(el.dataset.card, { [el.dataset.field]: value });
  });
  on("kitconf17", () => { const p = pending; pending = null; closeDlg(); if (p) kitSet(p.key, p.field, p.value, true); });
  on("kitkeep17", () => { pending = null; closeDlg(); render(); });
  markLive(["kitseg17", "knobseg17", "kitconf17", "kitkeep17"]);
  // Nothing is read here: this runs before the window is signed in, and each page that reads the stores (General,
  // Permissions) reads them as it opens.
}
