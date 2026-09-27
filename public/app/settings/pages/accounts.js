/* Settings › Accounts: the engine's accounts in the order it uses them (GET /api/accounts), moving one up, the account
   menu (flows/account.js) and, at Advanced, selecting several and acting on all of them. Never shows a key. */
import { level } from "../../core/state.js";
import { esc, renderNow } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { ic, toast } from "../../core/ui.js";
import { logo } from "../../core/logos.js";
import { A, allAccounts, loadAccounts, ownerOnly } from "../../flows/account.js";
import { accounts17 } from "../p17-more.js";
import { t } from "../../../i18n.js";

/* Which accounts are ticked while "Select several" is on (window state), by pool and id; null when it is off. */
let picked = null;
const key = (a) => `${a.pool}/${a.id}`;

export function load() { return loadAccounts(); }

function row(a, i, list) {
  const ids = `data-pool="${esc(a.pool)}" data-id="${esc(a.id)}"`;
  const tick = picked ? `<input type="checkbox" class="chk15" data-sw="acc15" data-acc15="${esc(key(a))}" ${picked.includes(key(a)) ? "checked" : ""} aria-label="${t("window.settings.accounts.select-label", { label: esc(a.label) })}">` : "";
  const top = i === 0 || list[i - 1].pool !== a.pool;
  return `<div class="prow">${tick}${logo(a.pool, a.poolName, 32)}<span class="grow"><b>${esc(a.label)}</b><small>${esc(a.poolName)}</small></span>${a.first ? `<span class="pill ok">${t("glance.usedNext")}</span>` : ""}`
    + `<button class="icon-btn" type="button" aria-label="${t("accounts.action.up")}" data-act="acct-up" ${ids} ${top ? "disabled" : ownerOnly()} data-css="width:28px;height:28px">${ic("up", "s")}</button>`
    + `<button class="icon-btn" type="button" aria-label="${t("window.settings.accounts.more-for-label", { label: esc(a.label) })}" data-act="acct-menu" ${ids} data-css="width:28px;height:28px">${ic("more", "s")}</button></div>`;
}

function bulkBar() {
  if (!picked) return "";
  const n = picked.length, off = n ? ownerOnly() : "disabled";
  return `<div class="bulk15" role="toolbar" aria-label="${t("window.settings.accounts.with-the-selected-accounts")}"><b>${n ? t("window.settings.accounts.count-selected", { count: n }) : t("window.settings.accounts.tick-the-accounts")}</b><span class="grow"></span><button class="btn ghost sm" type="button" data-act="acbulk15" data-v="top" ${off}>${t("window.settings.accounts.move-to-the-top")}</button><button class="btn ghost sm" type="button" data-act="acbulk15" data-v="pause" ${off}>${t("autonomy.pause")}</button><button class="btn ghost sm danger15" type="button" data-act="acbulk15" data-v="remove" ${off}>${t("accounts.action.sign-out")}</button></div>`;
}

export function draw() {
  const list = allAccounts();
  const lev = level();
  if (lev < 1) picked = null;
  let html = `<h1>${t("settings.page.accounts")}</h1><p class="lede">${t("window.settings.accounts.your-model-accounts-the-order-branch")}</p>`;
  if (A.view) html += `<div class="status"><span class="sdot ${list.length ? "" : "bad"}"></span><div><b>${list.length} ${t("window.settings.accounts.accounts-signed-in")}</b><p>${t("window.settings.accounts.branch-never-sees-your-passwords-each")}</p></div></div>`;
  /* Every change here is the owner's (the engine refuses a household person), so on a household profile they are greyed. */
  const mine = ownerOnly();
  const sel = lev >= 1 ? `<button type="button" class="link15 acsel15" data-act="acsel15" ${mine}>${picked ? t("first-run-steps.done") : t("window.settings.accounts.select-several")}</button>` : "";
  html += `<div class="sec"><h2${lev >= 1 ? ' class="h2row15"' : ""}>${t("window.settings.accounts.order-branch-uses-them-in-sel", { sel })}</h2>${bulkBar()}<div class="rows">${list.map(row).join("")}</div>`;
  html += `<div class="acts acadd-bf3" data-css="margin-top:12px"><button class="btn pri" type="button" data-act="addacct" ${mine}>${ic("plus", "s")}${t("window.settings.accounts.add-an-account")}</button>`;
  html += (A.view?.pools ?? []).map((p) => `<button class="btn" type="button" data-act="addacct" data-v="${esc(p.pool)}" ${mine}>${t("window.settings.accounts.another-value-account", { value: esc(p.name ?? p.pool) })}</button>`).join("");
  html += `</div></div>`;
  html += `<div class="sec"><h2>${t("window.settings.accounts.when-one-runs-out")}</h2>`
    + `<div class="ctl"><b>${t("window.settings.accounts.move-to-the-next-account-in")}</b><input class="sw" type="checkbox" id="ac-next" aria-label="${t("window.settings.accounts.move-to-the-next-account-in")}" data-sw="set"><small>${t("window.settings.accounts.only-between-accounts-you-own-and")}</small></div>`
    + `<div class="ctl"><b>${t("window.settings.accounts.fall-back-to-this-computer")}</b><input class="sw" type="checkbox" id="ac-fall" aria-label="${t("window.settings.accounts.fall-back-to-this-computer")}" data-sw="set"><small>${t("window.settings.accounts.keeps-working-on-the-local-model")}</small></div></div>`;
  html += `<div class="sec"><h2>keepoak.com</h2><div class="ko-card"><span class="ko-mark" aria-hidden="true"></span><span class="grow"><b>${t("window.settings.accounts.your-keepoak-com-account")}</b><small>${t("window.settings.accounts.have-a-keepoak-computer-or-a")}</small></span><span class="pill idle" title="${t("window.settings.accounts.branch-does-not-link-to-keepoak")}">${t("window.settings.accounts.proposal")}</span></div>`
    + `<ul class="may6"><li>${ic("check", "s")}${t("window.settings.accounts.your-keepoak-computer-joins-the-computer")}</li><li>${ic("check", "s")}${t("window.settings.accounts.your-theme-saved-colours-and-season")}</li><li>${ic("check", "s")}${t("window.settings.accounts.your-team-workspace-members-shared-trunks")}</li><li>${ic("check", "s")}${t("window.settings.accounts.conversations-memory-and-keys-stay-on")}</li></ul>`
    + `<div class="acts"><button class="btn pri" type="button" data-act="ko-start">${t("window.settings.accounts.connect-your-keepoak-com-account")}</button></div></div>`;
  return html + accounts17(lev);
}

async function moveUp(el) {
  try { await api("accounts/update", { pool: el.dataset.pool, account: el.dataset.id, move: "up" }); } catch (error) { toast(error.message); }
  await loadAccounts();
}

/* Move to the top: the engine moves one place per request, so each ticked account climbs until only ticked ones of
   its own connection are above it. Pause: { disabled: true }. Sign out: POST /api/accounts/remove. */
async function bulk(v) {
  const chosen = allAccounts().filter((a) => picked?.includes(key(a)));
  const n = chosen.length;
  try {
    if (v === "top") await toTop(chosen);
    else for (const a of chosen) {
      await api(v === "pause" ? "accounts/update" : "accounts/remove", v === "pause" ? { pool: a.pool, account: a.id, disabled: true } : { pool: a.pool, account: a.id });
    }
    toast(v === "top" ? t("window.settings.accounts.moved-count-to-the-top", { count: n }) : v === "pause" ? t("window.settings.accounts.paused-count-branch-skips-them-until", { count: n }) : t("window.settings.accounts.signed-out-of-count", { count: n }));
  } catch (error) { toast(error.message); }
  picked = null;
  await loadAccounts();
}

async function toTop(chosen) {
  for (const pool of new Set(chosen.map((a) => a.pool))) {
    const mine = chosen.filter((a) => a.pool === pool);
    const order = (A.view.pools.find((p) => p.pool === pool)?.accounts ?? []).map((a) => a.id);
    const wanted = mine.map((a) => a.id).sort((x, y) => order.indexOf(x) - order.indexOf(y));
    for (const [place, id] of wanted.entries()) {
      for (let at = order.indexOf(id); at > place; at--) {
        await api("accounts/update", { pool, account: id, move: "up" });
        [order[at - 1], order[at]] = [order[at], order[at - 1]];
      }
    }
  }
}

export function init() {
  load();
  on("acct-up", (el) => moveUp(el));
  on("acsel15", () => { picked = picked ? null : []; renderNow(); });
  on("acbulk15", (el) => bulk(el.dataset.v));
  document.addEventListener("change", (e) => {
    const k = e.target.dataset?.acc15;
    if (k == null || !picked) return;
    picked = e.target.checked ? [...new Set([...picked, k])] : picked.filter((x) => x !== k);
    renderNow();
  });
  markLive(["acct-up", "acsel15", "acbulk15", "sw:acc15"]);
}

export const live = { "acct-up": true, "acsel15": true, "acbulk15": true };
