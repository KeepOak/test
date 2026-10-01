/* UI-270 / RES-128: local exploration of already-rendered reply tables.
   Cells keep their existing safe Markdown DOM and links. Neither the reply nor its source is rewritten. */
import { afterDraw } from "../core/dom.js";
import { activeId, S } from "../core/state.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { t, language } from "../../i18n.js";

const records = new WeakMap(), choices = new Map();
let principal;
const hash = (text) => {
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return (n >>> 0).toString(36);
};
function choice(key) {
  let value = choices.get(key);
  if (!value) value = { query: "", column: null, descending: false };
  choices.delete(key); choices.set(key, value);
  while (choices.size > 100) choices.delete(choices.keys().next().value);
  return value;
}
const node = (tag, className, words) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (words !== undefined) el.textContent = words;
  return el;
};
function apply(record) {
  const state = record.state, query = state.query.toLocaleLowerCase(language());
  const body = record.table.tBodies[0];
  let order = record.rows.map((row, index) => ({ row, index }));
  if (state.column !== null && state.column < record.heads.length) {
    const values = order.map((one) => one.row.cells[state.column]?.textContent.trim() ?? "");
    const number = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;
    const present = values.filter(Boolean);
    const numeric = present.length > 0 && present.every((v) => number.test(v) && Number.isFinite(Number(v)));
    const collator = new Intl.Collator(language(), { numeric: true, sensitivity: "base" });
    order.sort((a, b) => {
      const x = values[a.index], y = values[b.index];
      if (!x || !y) return x === y ? a.index - b.index : !x ? 1 : -1;
      const compared = numeric ? Number(x) - Number(y) : collator.compare(x, y);
      return compared ? compared * (state.descending ? -1 : 1) : a.index - b.index;
    });
  }
  let visible = 0;
  for (const { row } of order) {
    row.hidden = query !== "" && !([...row.cells].map((cell) => cell.textContent).join(" ")).toLocaleLowerCase(language()).includes(query);
    if (!row.hidden) visible++;
    body.append(row);
  }
  if (record.input.value !== state.query) record.input.value = state.query;
  record.count.textContent = t("replyTable.count", { shown: visible, total: record.rows.length });
  record.reset.disabled = state.query === "" && state.column === null;
  record.heads.forEach((head, index) => {
    const selected = state.column === index;
    head.setAttribute("aria-sort", selected ? state.descending ? "descending" : "ascending" : "none");
    record.buttons[index].textContent = selected ? state.descending ? "\u2193" : "\u2191" : t("replyTable.sort");
  });
}
function translate(record) {
  record.label.firstChild.textContent = t("replyTable.filter");
  record.input.setAttribute("aria-label", t("replyTable.filter"));
  record.reset.textContent = t("replyTable.reset");
  record.buttons.forEach((button, index) => button.setAttribute("aria-label",
    t("replyTable.sortBy", { column: record.labels[index] || String(index + 1) })));
  record.locale = language();
  apply(record);
}
function enhance(table) {
  if (records.has(table) || table.closest(".card,.cmp6")) return;
  const heads = [...(table.tHead?.rows[0]?.cells ?? [])], rows = [...(table.tBodies[0]?.rows ?? [])];
  // Data-query previews are small; leave oversized or irregular tables as the original Markdown.
  if (!heads.length || heads.length > 64 || !rows.length || rows.length > 1000
    || rows.some((row) => row.cells.length !== heads.length)) return;
  const message = table.closest(".b"), position = [...message.querySelectorAll(".txt table")].indexOf(table);
  const labels = heads.map((head) => head.textContent.trim());
  const key = `${principal ?? ""}:${message.dataset.i15 ?? S.chat ?? "live"}:${position}:${hash(labels.join("|"))}`;
  const state = choice(key), wrap = node("div", "reply-table"), controls = node("div", "acts");
  const label = node("label", "hint", t("replyTable.filter")), input = node("input", "inp");
  input.type = "search"; input.maxLength = 200; input.name = `reply-table-${hash(key)}`;
  input.dataset.sw = "reply-table-filter"; input.dataset.replyTableFilter = "true"; input.setAttribute("aria-label", t("replyTable.filter"));
  label.append(input);
  const reset = node("button", "btn ghost sm", t("replyTable.reset"));
  reset.type = "button"; reset.dataset.act = "reply-table-reset";
  const count = node("span", "hint"); count.setAttribute("role", "status"); count.setAttribute("aria-live", "polite");
  controls.append(label, reset, count);
  table.before(wrap); wrap.append(controls, table);
  table.style.minWidth = "100%"; wrap.style.overflowX = "auto";
  const buttons = heads.map((head, index) => {
    const button = node("button", "btn ghost sm", t("replyTable.sort"));
    button.type = "button"; button.dataset.act = "reply-table-sort"; button.dataset.column = String(index);
    button.setAttribute("aria-label", t("replyTable.sortBy", { column: labels[index] || String(index + 1) }));
    head.append(document.createTextNode(" "), button);
    return button;
  });
  const record = { table, heads, rows, buttons, input, label, labels, reset, count, state, locale: language() };
  records.set(table, record); apply(record);
}
const recordOf = (el) => records.get(el.closest(".reply-table")?.querySelector("table"));
if (globalThis.document) {
  markLive(["reply-table-sort", "reply-table-reset", "sw:reply-table-filter"]);
  on("reply-table-sort", (el) => {
    const record = recordOf(el); if (!record) return;
    const column = Number(el.dataset.column);
    if (!Number.isInteger(column) || column < 0 || column >= record.heads.length) return;
    record.state.descending = record.state.column === column && !record.state.descending;
    record.state.column = column; apply(record);
  });
  on("reply-table-reset", (el) => {
    const record = recordOf(el); if (!record) return;
    Object.assign(record.state, { query: "", column: null, descending: false }); apply(record);
  });
  document.addEventListener("input", (event) => {
    if (!event.target.matches?.("input[data-reply-table-filter]")) return;
    const record = recordOf(event.target); if (!record) return;
    record.state.query = event.target.value.slice(0, 200); apply(record);
  });
  afterDraw(() => {
    const now = activeId();
    const changedOwner = principal !== now;
    if (changedOwner) { choices.clear(); principal = now; }
    for (const table of document.querySelectorAll(".b .txt table")) {
      const record = records.get(table);
      if (record) {
        if (changedOwner) { record.state = { query: "", column: null, descending: false }; apply(record); }
        if (record.locale !== language()) translate(record);
      } else enhance(table);
    }
  });
  globalThis.addEventListener?.("pagehide", () => choices.clear());
}
