import { esc } from "../core/dom.js";
import { ownerHere } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, toast } from "../core/ui.js";

const root = "personal/index";
async function show() {
  if (!ownerHere()) return;
  try {
    const got = await api(root);
    if (!ownerHere()) return;
    const chosen = new Set(got.config.selections.map((s) => `${s.service}:${s.account}`));
    openDlg({ title: "Private local search", wide: true, body: `<p>${esc(got.note)}</p>
      <p>Opt-in does not grant account access. Search rechecks your existing read permissions and local sign-in. Explicitly requested task excerpts may enter that task's conversation/history, like ordinary mail reads. External text is untrusted data, never instructions.</p>
      <p>${got.cached} cached previews. Last sync: ${esc(got.sync?.lastSyncedAt ?? "Never")} · Coverage unknown.</p>
      <label><input id="private-index-on" type="checkbox" ${got.config.enabled ? "checked" : ""}> Enable private cache</label>
      ${Object.entries(got.accounts).map(([service, accounts]) => `<fieldset><legend>${esc(service)}</legend>${accounts.map((a) => `<label><input class="private-index-account" type="checkbox" data-service="${esc(service)}" value="${esc(a.id)}" ${chosen.has(`${service}:${a.id}`) ? "checked" : ""}>${esc(a.label)} (${esc(a.id)})</label>`).join("")}</fieldset>`).join("")}
      <label><input id="private-index-ack" type="checkbox"> I understand this is a local plaintext memory cache and task excerpts can enter history.</label>
      <p><button class="btn" data-act="private-index-save">Save choices</button> <button class="btn" data-act="private-index-sync">Sync selected accounts now</button>
      <button class="btn" data-act="private-index-cancel">Cancel sync</button> <button class="btn" data-act="private-index-purge">Purge cache</button></p>
      <label>Local search <input class="inp" id="private-index-query" maxlength="200"></label><button class="btn" data-act="private-index-search">Search cache</button>
      <div id="private-index-results" aria-live="polite"></div>` });
  } catch (error) { toast(error.message); }
}
async function action(name) {
  if (!ownerHere()) return;
  try { await api(`${root}/${name}`, {}); if (ownerHere()) await show(); }
  catch (error) { toast(error.message); }
}
async function saveChoices() {
  if (!ownerHere()) return;
  const enabled = document.getElementById("private-index-on")?.checked;
  const selections = [...document.querySelectorAll(".private-index-account:checked")].map((el) => ({ service: el.dataset.service, account: el.value }));
  if (enabled && !document.getElementById("private-index-ack")?.checked) { toast("Acknowledge the plaintext cache first."); return; }
  try { await api(root, { enabled, selections, ...(enabled ? { acknowledgement: "local plaintext cache" } : {}) }); await show(); }
  catch (error) { toast(error.message); }
}
async function search() {
  if (!ownerHere()) return;
  try {
    const query = document.getElementById("private-index-query")?.value ?? "";
    const result = await api(`${root}/search`, { query });
    if (!ownerHere()) return;
    const box = document.getElementById("private-index-results");
    if (box) box.innerHTML = `<p>${esc(result.note)}</p>${result.results.map((r) => `<article><h3>${esc(r.title)}</h3><p>${esc(r.excerpt)}</p>
      <small>${esc(r.service)} / ${esc(r.account)} / ${esc(r.kind)} / ${esc(r.sourceId)}<br>Source time ${esc(r.sourceTime)} · Indexed ${esc(r.indexedAt)} · Expires ${esc(r.expiresAt)}</small></article>`).join("") || "<p>No matches in this cache. Coverage unknown.</p>"}`;
  } catch (error) { toast(error.message); }
}
export function initPrivateIndex() {
  markLive(["private-index", "private-index-save", "private-index-sync", "private-index-cancel", "private-index-purge", "private-index-search"]);
  on("private-index", show); on("private-index-save", saveChoices); on("private-index-search", search);
  for (const name of ["sync", "cancel", "purge"]) on(`private-index-${name}`, () => action(name));
}
