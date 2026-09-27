/* A ```chart block in a reply, drawn as the prototype's chart card (artCard): the title, the chart, Open larger, Copy code,
   Save to Library and "The code that drew it". The block holds the chart as JSON, {type: "bar" | "line" | "pie", title,
   data: [{label, value}]}; anything without a number to draw is left as code. The chart is inline SVG built here from
   the parsed numbers and escaped labels only (no script, no link, nothing fetched), so nothing in a reply can run.
   Open larger redraws it in a dialog (window state). Save to Library keeps the drawn picture beside the task that wrote
   the reply (POST /api/artifacts/save), where Library › Made for you lists it (GET /api/artifacts); it is live only when
   the engine's recent tasks (GET /api/state runs) hold the reply, since the file is kept under that task. Copy code
   puts the block's code on the clipboard. */

import { esc } from "../core/dom.js";
import { E, ownerHere } from "../core/state.js";
import { api } from "../core/api.js";
import { on, has } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic, openDlg, toast } from "../core/ui.js";
import { t, language } from "../../i18n.js";

const COLOURS = ["var(--ink)", "var(--accent)", "var(--ink-3)", "var(--line-2)", "var(--ink-2)", "var(--accent-ink)"];
const TEXT = 'font-size="11.5" fill="var(--ink-2)"';

/* The chart a block describes, or null when it has nothing to draw. */
export function readChart(source) {
  let spec;
  try { spec = JSON.parse(source); } catch { return null; }
  const points = (Array.isArray(spec?.data) ? spec.data : [])
    .map((row) => ({ label: String(row?.label ?? ""), value: Number(row?.value) }))
    .filter((p) => p.label && Number.isFinite(p.value)).slice(0, 40);
  if (!points.length) return null;
  const type = ["bar", "line", "pie"].includes(spec.type) ? spec.type : "bar";
  return { type, title: typeof spec.title === "string" ? spec.title.slice(0, 120) : "", points };
}

const num = (v) => Number(v.toFixed(2)).toLocaleString(language());
const span = (points) => {
  const lo = Math.min(0, ...points.map((p) => p.value)), hi = Math.max(0, ...points.map((p) => p.value));
  return [lo, hi === lo ? lo + 1 : hi];
};

/* The prototype's bars: a label on the left, the bar, its value at the end, and five ticks under them. */
function bars(points, w) {
  const left = 96, right = 52, rowH = 30, top = 8, h = top + points.length * rowH + 26;
  const [lo, hi] = span(points);
  const x = (v) => left + ((v - lo) / (hi - lo)) * (w - left - right);
  const ticks = [0, 1, 2, 3, 4, 5].map((i) => lo + ((hi - lo) * i) / 5).map((v) => `<line class="tick" x1="${x(v)}" x2="${x(v)}" y1="${top}" y2="${h - 20}" stroke="var(--line)"/><text x="${x(v)}" y="${h - 6}" text-anchor="middle" ${TEXT}>${esc(num(v))}</text>`).join("");
  const rows = points.map((p, i) => {
    const y = top + i * rowH + 6, a = x(Math.min(0, p.value)), b = x(Math.max(0, p.value));
    return `<text x="${left - 10}" y="${y + 13}" text-anchor="end" ${TEXT}>${esc(p.label)}</text><rect x="${a}" y="${y}" width="${Math.max(1, b - a)}" height="18" rx="4" fill="var(--line-2)"/><text class="val" x="${b + 6}" y="${y + 13}" font-size="11.5" fill="var(--ink)">${esc(num(p.value))}</text>`;
  }).join("");
  return [h, ticks + rows];
}

/* A line through the values, each point marked, its label under it and its value over it. */
function line(points, w) {
  const h = 240, pad = 40, top = 20, bottom = h - 30;
  const [lo, hi] = span(points);
  const x = (i) => pad + (points.length > 1 ? (i * (w - pad * 2)) / (points.length - 1) : (w - pad * 2) / 2);
  const y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const path = points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  const marks = points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.value)}" r="4" fill="var(--ink)"/><text class="val" x="${x(i)}" y="${y(p.value) - 8}" text-anchor="middle" font-size="11.5" fill="var(--ink)">${esc(num(p.value))}</text><text x="${x(i)}" y="${h - 10}" text-anchor="middle" ${TEXT}>${esc(p.label)}</text>`).join("");
  return [h, `<line class="tick" x1="${pad}" x2="${w - pad}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/><polyline points="${path}" fill="none" stroke="var(--ink)" stroke-width="2"/>${marks}`];
}

/* Slices of the positive values, with a key of each label and value beside it. */
function pie(points, w) {
  const shown = points.filter((p) => p.value > 0), total = shown.reduce((n, p) => n + p.value, 0) || 1;
  const r = 90, cx = 110, cy = 110, h = Math.max(230, shown.length * 22 + 20);
  let at = -Math.PI / 2;
  const slices = shown.map((p, i) => {
    const turn = (p.value / total) * Math.PI * 2, end = at + turn, fill = COLOURS[i % COLOURS.length];
    const d = shown.length === 1 ? `M${cx - r},${cy}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0`
      : `M${cx},${cy}L${cx + r * Math.cos(at)},${cy + r * Math.sin(at)}A${r},${r} 0 ${turn > Math.PI ? 1 : 0},1 ${cx + r * Math.cos(end)},${cy + r * Math.sin(end)}Z`;
    at = end;
    return `<path d="${d}" fill="${fill}"/><rect x="${cx + r + 30}" y="${14 + i * 22}" width="12" height="12" rx="3" fill="${fill}"/><text x="${cx + r + 50}" y="${24 + i * 22}" ${TEXT}>${esc(p.label)}</text><text class="val" x="${w - 10}" y="${24 + i * 22}" text-anchor="end" font-size="11.5" fill="var(--ink)">${esc(num(p.value))}</text>`;
  }).join("");
  return [h, slices];
}

export function chartSvg(chart, w = 520) {
  const [h, body] = (chart.type === "line" ? line : chart.type === "pie" ? pie : bars)(chart.points, w);
  return `<svg class="chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" font-family="sans-serif" role="img" aria-label="${esc(chart.title)}">${body}</svg>`;
}

/* The task whose answer holds this block: the file is kept beside it. */
const runOf = (source) => (E.state?.runs ?? []).find((r) => typeof r.output === "string" && r.output.includes(source))?.id ?? "";

const chartKey = (source) => {
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return `chart-${hash >>> 0}-${source.length}`;
};

/* The card for a chart block, or "" when the block has nothing to draw. */
export function chartCard(source) {
  const chart = readChart(source);
  if (!chart) return "";
  const run = runOf(source);
  const save = run ? `data-act="art-save" data-run="${esc(run)}"` : 'data-act="toast"';
  /* Q262: the file would be kept in the owner's Library, so a household person is not offered Save at all. */
  const saveBtn = ownerHere() ? `<button class="btn sm" type="button" ${save}>${t("window.diagram.save-to-library")}</button>` : "";
  return `<div class="card art"><div class="card-h"><b>${esc(chart.title)}</b><span class="pill idle ml">${t("window.chat.art.chart")}</span></div>
    <p class="note">${t("window.chat.art.sealed")}</p>
    ${chartSvg(chart)}
    <div class="acts"><button class="btn sm" type="button" data-act="artbig">${t("window.chat.art.larger")}</button><button class="btn sm" type="button" data-act="art-copy">${t("action.copy-code")}</button>${saveBtn}</div>
    <details data-persist="${chartKey(source)}"><summary>${ic("chev", "s chev")}${t("window.chat.art.code")}</summary><pre>${esc(source)}</pre></details></div>`;
}

/* The chart behind a button: read back from its own card's code, so nothing is kept beside the page. */
const cardChart = (el) => readChart(el.closest(".card.art")?.querySelector("details pre")?.textContent ?? "");

/* The picture as a file of its own: the page's colours written in, since the file has no stylesheet. */
function asFile(chart) {
  const style = getComputedStyle(document.documentElement);
  return chartSvg(chart, 720).replace(/var\((--[\w-]+)\)/g, (whole, name) => style.getPropertyValue(name).trim() || "currentColor");
}
const fileName = (title) => `artifact-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "chart"}.svg`;

async function saveChart(el) {
  const chart = cardChart(el);
  if (!chart) return;
  try { await api("artifacts/save", { runId: el.dataset.run, name: fileName(chart.title), mediaType: "image/svg+xml", code: asFile(chart) }); } catch (error) { toast(error.message); return; }
  toast(t("window.chat.art.saved"));
}

/* Copy code: the block's own code, the chart as the reply wrote it. */
async function copyCode(el) {
  const code = el.closest(".card.art")?.querySelector("details pre")?.textContent ?? "";
  if (!code) return;
  try { await navigator.clipboard.writeText(code); } catch (error) { toast(error.message); return; }
  toast(t("window.chat.art.copied"));
}

if (!has("artbig")) {
  on("art-copy", (el) => copyCode(el));
  on("artbig", (el) => { const chart = cardChart(el); if (chart) openDlg({ title: chart.title, wide: true, body: chartSvg(chart, 700) }); });
  on("art-save", (el) => saveChart(el));
  markLive(["artbig", "art-save", "art-copy"]);
}
