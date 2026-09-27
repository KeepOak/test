/* "Name your new computer" (the prototype's drawNameDev: dev-glyph, dev-col, dev-save), opened once a computer is let in
   (flows/pair.js). The name the computer sent is filled in; "How it shows" is one of the engine's four glyphs and the
   colour one of the window's six swatches. Save sends all three to POST /api/devices/<id>/rename {name, glyph, color};
   the engine keeps the glyph and colour beside its device list, and GET /api/devices hands them back, so the computer
   is drawn with them in Settings › Computer. Cancel keeps the name it came with and no look. */

import { $, esc } from "../core/dom.js";
import { openDlg, closeDlg, toast, COLOURS } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { onPaired } from "./pair.js";
import { t } from "../../i18n.js";

/* The prototype's glyphs, by the engine's names (src/devices/book.ts deviceGlyphs). */
const GL = [["laptop", "window.flows.name-device.laptop", '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>'],
  ["desktop", "window.flows.name-device.desktop", '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>'],
  ["server", "window.flows.name-device.server", '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/><path d="M8 7.5h.1M8 16.5h.1"/>'],
  ["phone", "window.flows.name-device.phone", '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>']];
export const glyphSvg = (glyph) => { const g = GL.find(([k]) => k === glyph); return g ? `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${g[2]}</svg>` : ""; };
const HEX = /^#[0-9a-fA-F]{6}$/;
export const hexOr = (color) => (HEX.test(String(color ?? "")) ? color : null);

let N = null; // { id, name, glyph, color }

function draw() {
  const d = N;
  const glyphs = GL.map(([k, l]) => `<button class="gl" type="button" data-act="dev-glyph" data-v="${k}" aria-pressed="${d.glyph === k}"${d.glyph === k ? ` data-css="color:${d.color}"` : ""}>${glyphSvg(k)}${t(l)}</button>`).join("");
  const swatches = COLOURS.slice(0, 6).map((c) => `<button class="swatch" type="button" data-css="background:${c}" aria-label="${esc(t("window.flows.name-device.colour-c", { c }))}" aria-pressed="${d.color === c}" data-act="dev-col" data-v="${c}"></button>`).join("");
  openDlg({ title: t("window.flows.name-device.title"),
    body: `<div class="field"><label for="dev-name">${t("window.flows.name-device.name")}</label><input class="inp" id="dev-name" value="${esc(d.name)}" maxlength="80"></div><div class="field"><label>${t("window.flows.name-device.how-it-shows")}</label><div class="glyphs">${glyphs}</div></div><div class="field"><label>${t("window.flows.name-device.colour")}</label><div class="swatches">${swatches}</div></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("first-run-steps.restore-no")}</button><button class="btn pri" type="button" data-act="dev-save">${t("action.save")}</button>` });
}
const keepName = () => { const box = $("#dev-name"); if (N && box) N.name = box.value; };

/* Opened by pairing once the owner let a computer in; the device's id is the engine's. */
export function nameNewComputer(id, name) {
  N = { id, name, glyph: "desktop", color: COLOURS[4] };
  draw();
}

async function save() {
  keepName();
  const name = N.name.trim();
  if (!name) { $("#dev-name")?.setAttribute("aria-invalid", "true"); return; }
  let saved;
  try { saved = (await api(`devices/${encodeURIComponent(N.id)}/rename`, { name, glyph: N.glyph, color: N.color })).device; } catch (error) { toast(error.message); return; }
  N = null;
  closeDlg();
  for (const listener of onPaired) listener();
  toast(t("pair.paired", { name: saved.name }));
}

export function init() {
  markLive(["dev-glyph", "dev-col", "dev-save", "sw:dev-name"]);
  on("dev-glyph", (el) => { keepName(); N.glyph = el.dataset.v; draw(); });
  on("dev-col", (el) => { keepName(); N.color = hexOr(el.dataset.v) ?? N.color; draw(); });
  on("dev-save", () => save());
}
