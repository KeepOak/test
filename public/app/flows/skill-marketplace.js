import { $, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { openDlg, closeDlg, toast } from "../core/ui.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { reloadTools, showTool } from "../places/customize.js";

const M = { sources: [], list: null, review: null, page: 0, query: "", busy: false };
const button = (act, text, id = "") => `<button class="btn" type="button" data-act="${act}" data-v="${esc(id)}">${esc(text)}</button>`;
function sourcesView() {
  return `<p>Choose registry sources you want to browse. Adding an address grants no publisher trust.</p>`
    + M.sources.map(s => `<div class="ctl"><b>${esc(s.label)}</b><small>${esc(s.url)}</small>${button("sm-browse", "Browse", s.id)}${button("sm-remove", "Remove source", s.id)}</div>`).join("")
    + `<label class="fld">Source name<input class="inp" id="sm-label" maxlength="80"></label><label class="fld">HTTPS registry index<input class="inp" id="sm-url" maxlength="2000" placeholder="https://example.org/registry.json"></label>${button("sm-add", "Add source")}`;
}
function browseView() {
  const list = M.list;
  return `<p>${esc(list.source.label)} · ${list.total} results. Publisher text is untrusted.</p><p>Signing key: ${esc(list.key.status)} ${esc(list.key.published ?? "none")}</p>`
    + (list.key.published && list.key.status !== "pinned" ? button("sm-pin-review", "Review publisher-key trust") : "")
    + `<label class="fld">Search skills<input class="inp" id="sm-query" maxlength="200" value="${esc(M.query)}"></label>${button("sm-search", "Search")}`
    + list.skills.map(s => `<div class="ctl"><b>${esc(s.name)}</b><small>${esc(s.description)}</small><small>Signature: ${esc(s.signed)} · ${esc(s.version ?? "no version")}</small>${s.signed !== "invalid" ? button("sm-inspect", "Inspect document", s.id) : "Signature or trusted key mismatch; install blocked"}</div>`).join("")
    + `<div class="acts">${M.page ? button("sm-prev", "Previous") : ""}${M.page + list.skills.length < list.total ? button("sm-next", "Next") : ""}${button("sm-home", "Sources")}</div>`;
}
function reviewView(confirming = false) {
  const r = M.review;
  const findings = r.findings.map(f => `<li>Line ${f.line}: ${esc(f.reason)} <code>${esc(f.excerpt)}</code></li>`).join("");
  return `<p>${esc(r.metadata.name)} · source ${esc(r.source.url)}</p><p>Document URL: ${esc(r.entry.url)}</p><p>SHA-256: <code>${esc(r.entry.sha256)}</code></p><p>Signature: ${esc(r.entry.signed)}. ${esc(r.note)}</p>`
    + `<p>${findings ? "Scan findings:" : "No findings from this static scanner; this is not a safety guarantee."}</p>${findings ? `<ul>${findings}</ul>` : ""}`
    + `<details open><summary>Exact document to install</summary><pre>${esc(r.document)}</pre></details>`
    + `<p>Installs inactive. Scripts, references and package files are not fetched by this single-document registry protocol. Review before activating later.</p>`
    + (r.canInstall ? button(confirming ? "sm-approve" : "sm-confirm", confirming ? "Approve this inactive install" : "Review install confirmation") : "Your skill policy blocks this document.")
    + button("sm-back", "Back to results");
}
function draw(body) { openDlg({ title: "Skill marketplace", wide: true, body, foot: button("dlg-close", "Close") }); }
async function perform(work) {
  if (M.busy) return;
  M.busy = true;
  try { await work(); } catch (error) { toast(error.message); } finally { M.busy = false; }
}
export async function openSkillMarketplace() {
  return perform(async () => { M.sources = (await api("skill-marketplace")).sources; M.list = null; M.review = null; draw(sourcesView()); });
}
async function browse(id, page = 0) {
  M.page = page;
  M.list = await api("skill-marketplace/browse", { source: id, query: M.query, offset: page, limit: 20 });
  M.review = null;
  draw(browseView());
}
export function initSkillMarketplace() {
  markLive(["sk-lib", "sm-add", "sm-remove", "sm-browse", "sm-search", "sm-inspect", "sm-confirm", "sm-approve", "sm-back", "sm-home", "sm-prev", "sm-next", "sm-pin-review", "sm-pin", "sw:sm-label", "sw:sm-url", "sw:sm-query"]);
  on("sk-lib", openSkillMarketplace);
  on("sm-add", () => perform(async () => { M.sources = (await api("skill-marketplace/sources", { label: $("#sm-label").value, url: $("#sm-url").value })).sources; draw(sourcesView()); }));
  on("sm-remove", el => perform(async () => { M.sources = (await api("skill-marketplace/remove", { source: el.dataset.v })).sources; draw(sourcesView()); }));
  on("sm-browse", el => perform(() => browse(el.dataset.v)));
  on("sm-search", () => perform(() => { M.query = $("#sm-query").value; return browse(M.list.source.id); }));
  on("sm-prev", () => perform(() => browse(M.list.source.id, Math.max(0, M.page - 20))));
  on("sm-next", () => perform(() => browse(M.list.source.id, M.page + 20)));
  on("sm-inspect", el => perform(async () => { M.review = await api("skill-marketplace/inspect", { source: M.list.source.id, skillId: el.dataset.v }); draw(reviewView()); }));
  on("sm-confirm", () => draw(reviewView(true)));
  on("sm-approve", () => perform(async () => {
    const installed = await api("skill-marketplace/install", { ticket: M.review.ticket, approve: true });
    M.review = null; closeDlg(); await reloadTools(); showTool("skills", installed.id); toast("Installed inactive. Review before activating.");
  }));
  on("sm-back", () => { M.review = null; draw(browseView()); });
  on("sm-home", openSkillMarketplace);
  on("sm-pin-review", () => draw(`<p>Trust this publisher signing key only after verifying its fingerprint independently. A signature proves publisher identity, not safety.</p><p>Source: ${esc(M.list.source.url)}</p><pre>${esc(M.list.key.published)}</pre>${button("sm-pin", "Approve this publisher key")}`));
  on("sm-pin", () => perform(async () => { await api("skill-marketplace/trust", { source: M.list.source.id, fingerprint: M.list.key.published, approve: true }); await browse(M.list.source.id, M.page); }));
}
