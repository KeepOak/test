import { controlRow } from "../row-kit.js";
/* Settings › Accounts: the engine's accounts in the order it uses them (GET /api/accounts), moving one up, the account
   menu (flows/account.js) and, at Advanced, selecting several and acting on all of them. Never shows a key. */
import { level, E, refresh } from "../../core/state.js";
import { esc, renderNow } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { ic, toast } from "../../core/ui.js";
import { logo } from "../../core/logos.js";
import { A, allAccounts, loadAccounts, ownerOnly, accountDetail } from "../../flows/account.js";
import { accounts17 } from "../p17-more.js";
import { t } from "../../../i18n.js";
import { moreSections, loadMore, initMore } from "../more18.js"; // Finish setting up's "Two more things": email and calendar, a backup

/* Which accounts are ticked while "Select several" is on (window state), by pool and id; null when it is off. */
let picked = null;
const key = (a) => `${a.pool}/${a.id}`;

export function load() { loadMore(); return loadAccounts(); }

/* QA retest 2026-09-28 (m8): "used next" is said of the account the next answer comes from: the first of the list of
   the model that answers now (GET /api/accounts pools[].answering), or that model itself when it is on this computer. A
   list whose model is not the one answering keeps its order without the pill. */
function row(a, i, list) {
  const ids = `data-pool="${esc(a.pool)}" data-id="${esc(a.id)}"`;
  const tick = picked ? `<input type="checkbox" class="chk15" data-sw="acc15" data-acc15="${esc(key(a))}" ${picked.includes(key(a)) ? "checked" : ""} aria-label="${t("window.settings.accounts.select-label", { label: esc(a.label) })}">` : "";
  const top = i === 0 || list[i - 1].pool !== a.pool;
  /* A paused account (Pause below: { disabled: true }) says so and has Resume, the same route with { disabled: false }. */
  const paused = a.disabled ? `<span class="pill idle">${t("dashboard.standing.paused")}</span><button class="btn ghost sm" type="button" data-act="acct-resume" ${ids} ${ownerOnly()}>${t("autonomy.resume")}</button>` : "";
  return `<div class="prow">${tick}${logo(a.pool, a.poolName, 32)}<span class="grow"><b>${esc(a.label)}</b><small>${esc(accountDetail(a, a.poolName))}</small></span>${a.first && a.answering && !a.disabled ? `<span class="pill ok">${t("glance.usedNext")}</span>` : ""}${paused}`
    + `<button class="icon-btn" type="button" aria-label="${t("accounts.action.up")}" data-act="acct-up" ${ids} ${top ? "disabled" : ownerOnly()} data-css="width:28px;height:28px">${ic("up", "s")}</button>`
    + `<button class="icon-btn" type="button" aria-label="${t("window.settings.accounts.more-for-label", { label: esc(a.label) })}" data-act="acct-menu" ${ids} data-css="width:28px;height:28px">${ic("more", "s")}</button></div>`;
}

/* A model on this computer answers like an account and needs no sign-in (GET /api/state models.presets, local): listed
   after the accounts with "On this computer", without Move up or the account menu, which are an account's. */
const localPresets = () => (E.state?.models?.presets ?? []).filter((p) => p.local);
const localRow = (p) => `<div class="prow">${logo(p.provider, p.name, 32)}<span class="grow"><b>${esc(p.name)}</b><small>${t("glance.local")}</small></span>${E.state?.activeModel?.presetId === p.id ? `<span class="pill ok">${t("glance.usedNext")}</span>` : ""}</div>`;
/* Whether an account can answer now: a sign-in only while it is signed in (GET /api/accounts pools[].signedIn); a key or a
   program's account is counted as the engine lists it. */
const answers = (a) => a.ready === true;

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
  /* Q070 follow-up: the count is what can answer now: signed-in sign-ins, keys and programs' accounts, and each model on
     this computer; a signed-out sign-in is listed but not counted. */
  const count = list.filter(answers).length + localPresets().length;
  if (A.view) html += `<div class="status"><span class="sdot ${count ? "" : "bad"}"></span><div><b>${count} ${t("window.settings.accounts.accounts-signed-in")}</b><p>${t("window.settings.accounts.branch-never-sees-your-passwords-each")}</p></div></div>`;
  /* Every change here is the owner's (the engine refuses a household person), so on a household profile they are greyed. */
  const mine = ownerOnly();
  const sel = lev >= 1 ? `<button type="button" class="link15 acsel15" data-act="acsel15" ${mine}>${picked ? t("first-run-steps.done") : t("window.settings.accounts.select-several")}</button>` : "";
  html += `<div class="sec"><h2${lev >= 1 ? ' class="h2row15"' : ""}>${t("window.settings.accounts.order-branch-uses-them-in-sel", { sel })}</h2>${bulkBar()}<div class="rows">${list.map(row).join("")}${localPresets().map(localRow).join("")}</div>`;
  html += `<div class="acts acadd-bf3" data-css="margin-top:12px"><button class="btn pri" type="button" data-act="addacct" ${mine}>${ic("plus", "s")}${t("window.settings.accounts.add-an-account")}</button>`;
  html += (A.view?.pools ?? []).map((p) => `<button class="btn" type="button" data-act="addacct" data-v="${esc(p.pool)}" ${mine}>${t("window.settings.accounts.another-value-account", { value: esc(p.name ?? p.pool) })}</button>`).join("");
  html += `</div></div>`;
  html += whenOneRunsOut();
  html += `<div class="sec"><h2>keepoak.com</h2><div class="ko-card"><span class="ko-mark" aria-hidden="true"></span><span class="grow"><b>${t("window.settings.accounts.your-keepoak-com-account")}</b><small>${t("window.settings.accounts.have-a-keepoak-computer-or-a")}</small></span><span class="pill idle" title="${t("window.settings.accounts.branch-does-not-link-to-keepoak")}">${t("window.settings.accounts.proposal")}</span></div>`
    + `<ul class="may6"><li>${ic("check", "s")}${t("window.settings.accounts.your-keepoak-computer-joins-the-computer")}</li><li>${ic("check", "s")}${t("window.settings.accounts.your-theme-saved-colours-and-season")}</li><li>${ic("check", "s")}${t("window.settings.accounts.your-team-workspace-members-shared-trunks")}</li><li>${ic("check", "s")}${t("window.settings.accounts.conversations-memory-and-keys-stay-on")}</li></ul>`
    + `<div class="acts"><button class="btn pri" type="button" data-act="ko-start">${t("window.settings.accounts.connect-your-keepoak-com-account")}</button></div></div>`;
  return html + accounts17(lev) + moreSections();
}

/* When one runs out, both the engine's own settings. The design's line under "Move to the next account" ("only between
   accounts you own…") is left out: the engine does the opposite for sign-ins (it never moves work between the owner's
   own plans; that rule was replaced on 2026-09-27 by the account pools below).
   Move to the next account (owner decision 2026-09-27, Hermes Agent's credential pools): each list's own switch
   (GET /api/accounts pools[].autoSwitch; POST /api/accounts/pool { pool, autoSwitch } for every list), on while every
   list is; with no connection holding two accounts it has nothing to move between, so it is greyed with that reason
   (window.why.ac-next). How the next one is picked is each list's strategy, set for all of them (POST /api/accounts/pool
   { pool, strategy }): fill first ("priority"), round robin, least used. The note under them is the owner's plain words
   on what switching means.
   Fall back to this computer: the models on this computer in the fallback order (GET /api/state models.fallbackOrder;
   POST /api/models { fallbackOrder }); an account out of credit or at its plan limit then carries on there (src/runtime.ts
   fallBack). With no model on this computer: greyed with that reason (window.why.ac-fall). It ships off: a local model
   works this computer hard. */
const localIds = () => (E.state?.models?.presets ?? []).filter((p) => p.local).map((p) => p.id);
const fallOn = () => (E.state?.models?.fallbackOrder ?? []).some((id) => localIds().includes(id));
function whenOneRunsOut() {
  const box = (id, label, on, why) => `<input class="sw" type="checkbox" ${why ? `data-why="${why}"` : `id="${id}" data-sw="set"`} ${ownerOnly()} ${on ? "checked" : ""} aria-label="${label}">`;
  const several = (A.view?.pools ?? []).filter((p) => p.accounts.length > 1);
  const next = t("window.settings.accounts.move-to-the-next-account-in"), fall = t("window.settings.accounts.fall-back-to-this-computer");
  return `<div class="sec"><h2>${t("window.settings.accounts.when-one-runs-out")}</h2>`
    + `${controlRow(`<b>${next}</b>${box("ac-next", next, several.length > 0 && several.every((p) => p.autoSwitch), several.length ? "" : "ac-next")}<small>${esc(t("settings.help.account-next"))}</small>`)}`
    + (several.length ? `${controlRow(`<b>${t("window.settings.accounts.strategy")}</b><span class="right"><span class="seg" role="group" aria-label="${t("window.settings.accounts.strategy")}">${STRATEGIES.map(([v, k]) => `<button type="button" data-act="ac-strategy" data-v="${v}" aria-pressed="${several.every((p) => p.strategy === v)}" ${ownerOnly()}>${t(k)}</button>`).join("")}</span></span><small>${t("window.settings.accounts.strategy-hint")}</small>`)}` : "")
    + `<p class="hint">${t("window.settings.accounts.switch-note")}</p>`
    + `${controlRow(`<b>${fall}</b>${box("ac-fall", fall, fallOn(), localIds().length ? "" : "ac-fall")}<small>${t("window.settings.accounts.keeps-working-on-the-local-model")}</small>`)}</div>`;
}
const STRATEGIES = [["priority", "window.settings.accounts.fill-first"], ["round-robin", "window.settings.accounts.round-robin"], ["least-used", "window.settings.accounts.least-used"]];
async function setPools(values) {
  try { for (const p of A.view?.pools ?? []) await api("accounts/pool", { pool: p.pool, ...values }); } catch (error) { toast(error.message); }
  await loadAccounts();
}

async function setFall(on) {
  const kept = (E.state?.models?.fallbackOrder ?? []).filter((id) => !localIds().includes(id));
  try { await api("models", { fallbackOrder: on ? [...kept, ...localIds()] : kept }); await refresh(); } catch (error) { toast(error.message); }
  renderNow();
}

/* Resume: a paused account answers again (POST /api/accounts/update { pool, account, disabled: false }). */
async function resume(el) {
  try { await api("accounts/update", { pool: el.dataset.pool, account: el.dataset.id, disabled: false }); } catch (error) { toast(error.message); }
  await loadAccounts();
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
  initMore();
  on("acct-up", (el) => moveUp(el));
  on("acct-resume", (el) => resume(el));
  on("ac-strategy", (el) => setPools({ strategy: el.dataset.v }));
  on("acsel15", () => { picked = picked ? null : []; renderNow(); });
  on("acbulk15", (el) => bulk(el.dataset.v));
  document.addEventListener("change", (e) => {
    if (e.target.id === "ac-fall") return void setFall(e.target.checked);
    if (e.target.id === "ac-next") return void setPools({ autoSwitch: e.target.checked });
    const k = e.target.dataset?.acc15;
    if (k == null || !picked) return;
    picked = e.target.checked ? [...new Set([...picked, k])] : picked.filter((x) => x !== k);
    renderNow();
  });
  markLive(["acct-up", "acct-resume", "acsel15", "acbulk15", "sw:acc15", "sw:ac-fall", "sw:ac-next", "ac-strategy"]);
}

export const live = { "acct-up": true, "acct-resume": true, "acsel15": true, "acbulk15": true, "sw:ac-fall": true, "sw:ac-next": true, "ac-strategy": true };
