/* Public MCP discovery is requested explicitly. Results are metadata; no install command is generated or run. */
import { $, esc, paint } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { openDlg, toast } from "../core/ui.js";
import { t } from "../../i18n.js";

let active = 0;
let search = "", nextCursor = null, busy = false;

function openRegistry() {
  active++;
  search = ""; nextCursor = null; busy = false;
  openDlg({ title: "MCP Registry", wide: true,
    body: `<p class="hint">${esc(t("window.flows.conn.own"))} · registry.modelcontextprotocol.io</p><label class="fld"><span>${esc(t("action.search"))}</span><input class="inp" id="mcp-registry-q" maxlength="200" autocomplete="off"></label><div class="acts"><button class="btn" type="button" data-act="mcp-registry-search">${esc(t("action.search"))}</button></div><div id="mcp-registry-results" aria-live="polite"></div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${esc(t("first-run-steps.done"))}</button>` });
}

function resultsBody(page) {
  const rows = page.entries.map((entry) => `<div class="prow"><span class="grow"><b>${esc(entry.title)}</b><small>${esc(entry.name)} · ${esc(entry.version)} · ${esc(entry.status)}</small><p>${esc(entry.description)}</p>${entry.packages.map((pkg) => `<small>${esc(pkg.registryType)} · ${esc(pkg.identifier)}${pkg.version ? ` · ${esc(pkg.version)}` : ""}</small>`).join("")}</span></div>`).join("");
  const more = page.nextCursor ? `<button class="btn sm" type="button" data-act="mcp-registry-next">${esc(t("action.next"))}</button>` : "";
  return `${rows || `<p class="empty">${esc(t("window.flows.conn.nothing"))}</p>`}${more}`;
}

async function queryRegistry(next = false) {
  if (busy || !$("#mcp-registry-q")) return;
  const term = next ? search : $("#mcp-registry-q").value.trim();
  if (!term || (next && !nextCursor)) return;
  const generation = active;
  busy = true;
  const result = $("#mcp-registry-results");
  paint(result, `<p class="hint">${esc(t("live.working"))}</p>`);
  try {
    const page = await api("mcp/registry/search", { search: term, ...(next ? { cursor: nextCursor } : {}) });
    if (generation !== active || result !== $("#mcp-registry-results")) return;
    search = term; nextCursor = page.nextCursor;
    greyOut(paint(result, resultsBody(page)));
  } catch (error) {
    if (generation === active && result === $("#mcp-registry-results")) {
      nextCursor = null;
      paint(result, `<p class="hint">${esc(error.message)}</p>`);
      toast(error.message);
    }
  } finally { if (generation === active) busy = false; }
}

export function initPublicRegistry() {
  markLive(["mcp-registry-open", "mcp-registry-search", "mcp-registry-next", "sw:mcp-registry-q"]);
  on("mcp-registry-open", openRegistry);
  on("mcp-registry-search", () => queryRegistry());
  on("mcp-registry-next", () => queryRegistry(true));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target?.id === "mcp-registry-q") queryRegistry();
  });
}
