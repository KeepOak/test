/* UI-270: local controls over already escaped Markdown table DOM. No requests or saved data. */
import { t } from "../../i18n.js";

const saved = new Map(), installed = new WeakMap();
let currentScope = "";
const number = (value) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(Number(value));
const words = (cell) => cell?.textContent?.trim() ?? "";

function fingerprint(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}
function remembered(key) {
  if (!saved.has(key)) {
    saved.set(key, { query: "", column: -1, direction: 0 });
    if (saved.size > 32) saved.delete(saved.keys().next().value);
  }
  return saved.get(key);
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function apply(view, finding) {
  const { rows, body, state, heads, buttons, input, clear, status } = view;
  const query = finding ? "" : state.query.toLocaleLowerCase();
  const column = finding ? -1 : state.column, direction = finding ? 0 : state.direction;
  const numeric = column >= 0 && rows.every((r) => !r.cells[column] || number(words(r.cells[column])));
  const ordered = rows.map((row, index) => ({ row, index }));
  if (direction) ordered.sort((a, b) => {
    const left = words(a.row.cells[column]), right = words(b.row.cells[column]);
    const compared = numeric ? Number(left) - Number(right) : left.localeCompare(right, document.documentElement.lang || undefined, { numeric: true });
    return compared * direction || a.index - b.index;
  });
  const fragment = document.createDocumentFragment();
  let visible = 0;
  for (const { row } of ordered) {
    row.hidden = !!query && !row.textContent.toLocaleLowerCase().includes(query);
    if (!row.hidden) visible++;
    fragment.append(row);
  }
  body.append(fragment);
  heads.forEach((head, i) => head.setAttribute("aria-sort", i === column && direction ? direction === 1 ? "ascending" : "descending" : "none"));
  buttons.forEach((button) => { button.disabled = finding; });
  input.disabled = clear.disabled = finding;
  status.textContent = t("conversation.table.rows", { visible, total: rows.length });
}

function decorate(table, key, finding) {
  const body = table.tBodies[0], heads = [...table.tHead?.rows[0]?.cells ?? []];
  const rows = [...body?.rows ?? []];
  if (!body || !heads.length || heads.length > 64 || !rows.length || rows.length > 2000) return;
  if (rows.some((row) => row.cells.length !== heads.length || [...row.cells].some((cell) => cell.colSpan !== 1 || cell.rowSpan !== 1))) return;
  const state = remembered(key), controls = element("div", "reply-table-controls"), wrap = element("div", "reply-table-wrap");
  const label = element("label", "reply-table-filter", t("conversation.table.filter"));
  const input = element("input", "input"); input.id = `reply-table-filter-${fingerprint(key)}`; input.type = "search"; input.maxLength = 256; input.value = state.query;
  const clear = element("button", "btn ghost sm", t("conversation.table.reset")); clear.id = `reply-table-reset-${fingerprint(key)}`; clear.type = "button";
  const status = element("span", "hint"); status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite"); status.setAttribute("aria-atomic", "true");
  const buttons = heads.map((head, column) => {
    const button = element("button", "reply-table-sort", "↕"); button.id = `reply-table-sort-${fingerprint(key)}-${column}`; button.type = "button";
    button.setAttribute("aria-label", t("conversation.table.sort", { column: words(head) || String(column + 1) }));
    head.scope = "col"; head.append(button);
    button.addEventListener("click", () => {
      state.direction = state.column === column ? state.direction === 1 ? -1 : state.direction === -1 ? 0 : 1 : 1;
      state.column = state.direction ? column : -1; apply(view, view.finding);
    });
    return button;
  });
  const view = { body, rows, heads, buttons, input, clear, status, state, finding, scope: currentScope };
  input.addEventListener("input", () => { state.query = input.value.slice(0, 256); apply(view, view.finding); });
  clear.addEventListener("click", () => { state.query = input.value = ""; state.column = -1; state.direction = 0; apply(view, view.finding); });
  label.append(input); controls.append(label, clear, status);
  table.replaceWith(wrap); wrap.append(controls, table); installed.set(table, view);
  apply(view, finding);
}

/** Scope changes discard filters; Find sees all source rows in their original order. */
export function afterReplyTables(main, scope, finding) {
  if (scope !== currentScope) { saved.clear(); currentScope = scope; }
  const tables = [...main.querySelectorAll("#conversation .b .txt table")].slice(0, 32);
  tables.forEach((table, index) => {
    const view = installed.get(table);
    if (view) {
      const changed = view.scope !== scope;
      if (changed) { Object.assign(view.state, { query: "", column: -1, direction: 0 }); view.input.value = ""; view.scope = scope; }
      if (changed || view.finding !== finding) { view.finding = finding; apply(view, finding); }
      return;
    }
    const text = table.textContent ?? "";
    if (text.length > 1000000) return;
    const message = table.closest("[data-i15]"), ordinal = message ? [...message.querySelectorAll("table")].indexOf(table) : index;
    decorate(table, `${message?.dataset.i15 ?? "row"}:${ordinal}:${fingerprint(text)}`, finding);
  });
}
