/* Settings › Accounts, the two things Overview's "Finish setting up" row "Two more things" promises (prototype FIN18
   'more' opens this page), each real:
   - Email and calendar: the owner's own Google and Microsoft sign-ins (src/personal/signin.ts). The client id of the
     owner's own app is saved with POST /api/personal/signin/<service>; its client secret, when typed, goes only one way,
     into the engine's secrets locker with POST /api/personal/signin/<service>/secret (the owner's alone). The field is
     never filled from the engine or stored in window state; unsaved input stays only in its password control until
     sent or the page is closed, so a saved secret is never shown back. Sign in is POST
     /api/personal/signin/<service>/start, whose address is opened only when it is https on that service's own sign-in
     host. Whether it is signed in is GET /api/personal/signin/<service> status.signedIn.
   - Bring back your Branch: a backup file (GET /api/backup's own format) sent to POST /api/restore. The engine brings
     it back only into a Branch with no conversations yet and says so otherwise; nothing here replaces what is there
     (the route's replace=1 is never used). What it holds back for the owner's yes waits in Data & usage. */
import { esc, renderNow, afterDraw } from "../core/dom.js";
import { api, apiBytes } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { ic, toast } from "../core/ui.js";
import { ownerHere, E, S } from "../core/state.js";
import { viewFence } from "../core/view-fence.js";
import { sessionPrincipal } from "../core/session-pages.js";
import { t } from "../../i18n.js";

const SERVICES = [["google", "personal.google.name", "accounts.google.com"], ["microsoft", "personal.microsoft.name", "login.microsoftonline.com"], ["spotify", "personal.spotify.name", "accounts.spotify.com"]];
/* What the owner has typed and not saved yet, by field id, so a redraw never takes the words. */
const M = { signin: {}, busy: false, typed: {}, checking: {}, home: null, mail: null, accounts: [], mcp: [], connectorHealth: {} };
let scopeIdentity = null, generation = 0, lockObserver = null;
const connectionEpochs = new Map();
const usable = () => ownerHere() && S.signedIn === true && !E.state?.lock?.locked
  && !document.getElementById("app")?.classList.contains("locked-b17");
const scopeNow = () => JSON.stringify([sessionPrincipal(E.profiles), S.signedIn, S.project, S.view, S.setPage,
  E.state?.lock?.locked === true, document.getElementById("app")?.classList.contains("locked-b17") === true]);
function forgetScope() {
  ++generation;
  Object.assign(M, { signin: {}, checking: {}, typed: {}, home: null, mail: null, accounts: [], mcp: [], connectorHealth: {} });
  passwordControls = [];
}
function ensureScope() {
  const next = scopeNow();
  if (next !== scopeIdentity) { forgetScope(); scopeIdentity = next; }
}
const lockedMutation = records => records.some(record => /(?:^|\s)locked-b17(?:\s|$)/.test(record.oldValue ?? ""));
function accountFence(name) {
  ensureScope();
  const mine = generation, context = scopeIdentity, sameView = viewFence(`account-health:${name}`);
  return () => {
    if (lockedMutation(lockObserver?.takeRecords() ?? [])) forgetScope();
    ensureScope();
    return mine === generation && context === scopeIdentity && usable() && sameView();
  };
}
function connectionBinding(id) {
  const entry = () => SERVICES.some(([service]) => service === id) ? M.signin[id]
    : id === "home" ? M.home : id === "mail" ? M.mail
    : id.startsWith("mcp:") ? M.mcp.find(server => server.id === id.slice(4)) : M.accounts;
  const identity = value => JSON.stringify([value?.settings ?? value,
    value?.status ? [value.status.signedIn, value.status.expiresAt, value.status.scope] : null]);
  const original = entry(), saved = identity(original);
  return () => entry() === original && identity(entry()) === saved;
}
const typed = (id, saved) => esc(M.typed[id] ?? saved ?? "");
/* Reuse the password controls during a draw of Accounts: a late read must not discard input. No secret goes into
   markup or draft state, and these transient node references are released at the end of that same draw. */
let passwordControls = [];
afterDraw(() => {
  ensureScope();
  for (const control of passwordControls) {
    const fresh = document.getElementById(control.id);
    if (fresh && fresh !== control && ownerHere()) fresh.replaceWith(control);
  }
  passwordControls = [];
});

/* The saved settings and whether each service is signed in; a refusal says why and leaves that service out. */
export async function loadMore() {
  ensureScope();
  if (!usable()) return;
  ++generation;
  M.checking = {};
  const fresh = accountFence("load");
  await Promise.all(SERVICES.map(async ([service]) => {
    try { const got = await api(`personal/signin/${service}`); if (fresh()) M.signin[service] = got; }
    catch (error) { if (fresh()) { toast(error.message); delete M.signin[service]; } }
  }));
  if (!fresh()) return;
  try { const got = await api("personal/home"); if (fresh()) M.home = got; } catch { if (fresh()) M.home = null; }
  if (!fresh()) return;
  try { const got = await api("personal/mail"); if (fresh()) M.mail = got; } catch { if (fresh()) M.mail = null; }
  if (!fresh()) return;
  try { const got = await api("connectors/accounts"); if (fresh()) M.accounts = got.accounts ?? []; } catch { if (fresh()) M.accounts = []; }
  if (!fresh()) return;
  try { const got = await api("mcp/servers"); if (fresh()) M.mcp = got.servers ?? []; } catch { if (fresh()) M.mcp = []; }
  if (!fresh()) return;
  M.connectorHealth = {};
  renderNow();
}

/* Saved token/password connections have explicit metadata checks independent of configuration. */
function connectorCheck(id, name, configured) {
  if (!configured) return "";
  const checks = M.connectorHealth[id]?.checks ?? [];
  return `<div class="sec more18"><h2>${esc(t(name))}</h2><button class="btn sm" type="button" data-act="more18-connector-test" data-v="${esc(id)}" ${M.checking[id] ? "disabled" : ""}>${t(M.checking[id] ? "live.working" : "action.test-this-connection")}</button>`
    + `<div aria-live="polite">${checks.map((check) => `<p class="hint">${esc(check.capability)} · ${esc(t(check.ok ? "flowsBoards.recipes.passed" : "task.failed"))}${check.reason ? ` · ${esc(check.reason)}` : ""}</p>`).join("")}</div></div>`;
}

async function testConnector(id) {
  ensureScope();
  const mcp = /^mcp:([a-z][a-z0-9-]{0,29})$/.exec(id);
  if (!usable() || (!mcp && !["home", "mail", "github", "linear"].includes(id)) || M.checking[id]) return;
  M.checking[id] = true;
  delete M.connectorHealth[id];
  renderNow();
  const sameScope = accountFence(`connector:${id}`), sameConnection = connectionBinding(id);
  const fresh = () => sameScope() && sameConnection();
  if (!fresh()) return;
  try {
    const endpoint = mcp ? `mcp/servers/${mcp[1]}/test`
      : ["github", "linear"].includes(id) ? `connectors/accounts/${id}/test` : `personal/${id}/test`;
    const result = await api(endpoint, {});
    if (fresh()) M.connectorHealth[id] = result.health;
  } catch (error) { if (fresh()) toast(error.message); }
  finally { if (fresh()) { M.checking[id] = false; renderNow(); } }
}

function service([id, name]) {
  const got = M.signin[id];
  if (!got) return "";
  const s = got.settings ?? {};
  const state = got.status?.signedIn ? `<span class="pill ok"><i></i>${t("personal.signin.yes")}</span>` : `<span class="pill idle"><i></i>${t("personal.signin.no")}</span>`;
  const health = got.status?.health;
  const checks = health ? `<div aria-live="polite">${health.checks.map((check) => `<p class="hint">${esc(check.capability)} · ${esc(t(check.ok ? "flowsBoards.recipes.passed" : "task.failed"))}${check.reason ? ` · ${esc(check.reason)}` : ""}</p>`).join("")}<small>${esc(new Date(health.checkedAt).toLocaleString())}</small></div>` : "";
  return `<div class="more18-svc"><div class="th"><b>${t(name)}</b>${state}</div>`
    + `<label class="fld"><span>${t("personal.signin.client")}</span><input class="inp" id="more18-${id}-client" value="${typed(`more18-${id}-client`, s.clientId)}" autocomplete="off"></label>`
    + `<label class="fld"><span>${t("personal.signin.secret-value")}</span><input class="inp" type="password" id="more18-${id}-secret" value="" autocomplete="new-password" spellcheck="false"></label>`
    + `<div class="acts"><button class="btn sm" type="button" data-act="more18-save" data-v="${id}">${t("personal.save")}</button><button class="btn pri sm" type="button" data-act="more18-signin" data-v="${id}">${t("personal.signin.go")}</button><button class="btn sm" type="button" data-act="more18-test" data-v="${id}" ${!got.status?.signedIn || M.checking[id] ? "disabled" : ""}>${t(M.checking[id] ? "live.working" : "action.test-this-connection")}</button></div>${checks}</div>`;
}

/* Explicit metadata reads show what this sign-in can do. A refused read never signs the owner out. */
async function testConnection(id) {
  ensureScope();
  if (!usable() || !SERVICES.some(([service]) => service === id) || M.checking[id]) return;
  M.checking[id] = true;
  if (M.signin[id]?.status) M.signin[id].status.health = null;
  renderNow();
  const sameScope = accountFence(`signin:${id}`), sameConnection = connectionBinding(id), epoch = connectionEpochs.get(id) ?? 0;
  const fresh = () => sameScope() && sameConnection() && (connectionEpochs.get(id) ?? 0) === epoch;
  if (!fresh()) return;
  let published = false;
  try {
    const checked = await api(`personal/signin/${id}/test`, {});
    if (fresh() && M.signin[id]) {
      // A permitted token refresh changes expiry. Publish its result and finish this same operation atomically.
      M.signin[id].status = checked.status;
      M.checking[id] = false;
      published = true;
      renderNow();
    }
  } catch (error) { if (fresh()) toast(error.message); }
  finally { if (!published && fresh()) { M.checking[id] = false; renderNow(); } }
}

/* The two sections, drawn at the foot of Settings › Accounts; the owner's alone. */
export function moreSections() {
  ensureScope();
  if (!usable()) return "";
  passwordControls = SERVICES.map(([id]) => document.getElementById(`more18-${id}-secret`)).filter(Boolean);
  return `<div class="sec more18"><h2>${t("window.flows.setup.email")}</h2><p class="hint">${t("window.flows.setup.email-hint")}</p>${SERVICES.filter(([id]) => id !== "spotify").map(service).join("")}</div>`
    + `<div class="sec more18"><h2>${t("personal.spotify.name")}</h2>${service(SERVICES[2])}</div>`
    + connectorCheck("home", "personal.home.title", M.home?.settings?.url)
    + connectorCheck("mail", "personal.mail.title", M.mail?.settings?.host && M.mail?.settings?.user)
    + M.accounts.filter((id) => ["github", "linear"].includes(id)).map((id) => connectorCheck(id, id === "github" ? "GitHub" : "Linear", true)).join("")
    + M.mcp.filter((server) => server.on && /^[a-z][a-z0-9-]{0,29}$/.test(server.id)).map((server) => connectorCheck(`mcp:${server.id}`, server.name, true)).join("")
    + `<div class="sec more18"><h2>${t("first-run-steps.restore-title")}</h2><p class="hint">${t("first-run-steps.restore-purpose")}</p>`
    + `<div class="acts"><button class="btn" type="button" data-act="more18-restore" ${M.busy ? "disabled" : ""}>${ic("folder", "s")}${M.busy ? t("first-run-steps.restore-working") : t("window.flows.setup.backup")}</button></div>`
    + `<input type="file" id="more18-file" accept=".json,application/json" hidden></div>`;
}

/* The client id is saved; a client secret typed is sent once into the locker and the field emptied, and one left empty
   keeps whatever secret is already saved. */
async function save(id) {
  ensureScope();
  if (!usable() || !SERVICES.some(([service]) => service === id)) return false;
  connectionEpochs.set(id, (connectionEpochs.get(id) ?? 0) + 1);
  M.checking[id] = false;
  const fresh = accountFence(`save:${id}`);
  const client = document.getElementById(`more18-${id}-client`), secret = document.getElementById(`more18-${id}-secret`);
  if (!client || !secret) return false;
  const sameConnection = connectionBinding(id), clientInput = client.value, secretInput = secret.value;
  const sameInputs = () => fresh() && sameConnection() && document.getElementById(client.id) === client
    && document.getElementById(secret.id) === secret && client.value === clientInput && secret.value === secretInput;
  if (!sameInputs()) return false;
  const value = secret.value.trim();
  try {
    await api(`personal/signin/${id}`, { clientId: client.value.trim() });
    if (!sameInputs()) return false;
    delete M.typed[client.id];
    if (value) await api(`personal/signin/${id}/secret`, { value });
    if (!sameInputs()) return false;
    secret.value = "";
    return true;
  } catch (error) { if (sameInputs()) toast(error.message); return false; }
}

/* Only an https address on the service's own sign-in host is opened; the engine builds it from the service's own
   address (src/personal/signin.ts describeSignIn), so anything else is not followed. */
function safeAddress(url, host) {
  try { const u = new URL(url); return u.protocol === "https:" && u.hostname === host ? u.href : null; } catch { return null; }
}

async function signIn(id) {
  const sameScope = accountFence(`start:${id}`), sameConnection = connectionBinding(id);
  const fresh = () => sameScope() && sameConnection();
  if (!(await save(id))) return;
  if (!fresh()) return;
  const host = SERVICES.find(([s]) => s === id)?.[2];
  let started;
  try { started = await api(`personal/signin/${id}/start`, {}); } catch (error) { if (fresh()) toast(error.message); return; }
  if (!fresh()) return;
  const address = safeAddress(started?.url, host);
  if (!address) return;
  const opened = typeof window.branchDesktop?.openExternal === "function" ? window.branchDesktop.openExternal(address) : window.open(address, "_blank", "noopener");
  await Promise.resolve(opened).catch((error) => { if (fresh()) toast(error.message); });
  if (fresh()) toast(t("personal.signin.opened"));
}

/* The backup file goes to the engine as it is; its answer (how much came back, or why nothing did) is said. Setup's
   Welcome offers the same (flows/setup.js). True when it came back. */
export async function sendBackup(file) {
  try {
    const done = await apiBytes("restore", new Blob([file], { type: "application/json" }));
    const desktop = typeof window.branchDesktop === "object" && window.branchDesktop;
    toast(t(desktop ? "first-run-steps.restore-done" : "first-run-steps.restore-done-browser", { count: Number(done?.rows) || 0 }));
    return true;
  } catch (error) { toast(error.message); return false; }
}

async function restore(file) {
  M.busy = true;
  renderNow();
  await sendBackup(file);
  M.busy = false;
  renderNow();
}

export function initMore() {
  const app = document.getElementById("app");
  if (app) { lockObserver = new MutationObserver(records => { if (lockedMutation(records)) forgetScope(); ensureScope(); });
    lockObserver.observe(app, { attributes: true, attributeFilter: ["class"], attributeOldValue: true }); }
  markLive(["more18-save", "more18-signin", "more18-test", "more18-connector-test", "more18-restore", "sw:more18-file", ...SERVICES.flatMap(([id]) => [`sw:more18-${id}-client`, `sw:more18-${id}-secret`])]);
  on("more18-save", async (el) => { if (await save(el.dataset.v)) { toast(t("accounts.saved")); await loadMore(); } });
  on("more18-signin", (el) => signIn(el.dataset.v));
  on("more18-test", (el) => testConnection(el.dataset.v));
  on("more18-connector-test", (el) => testConnector(el.dataset.v));
  on("more18-restore", () => document.getElementById("more18-file")?.click());
  document.addEventListener("input", (e) => { if (/^more18-\w+-client$/.test(e.target?.id ?? "")) M.typed[e.target.id] = e.target.value; }); // never the secret
  document.addEventListener("change", (e) => {
    if (e.target?.id !== "more18-file" || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    e.target.value = "";
    restore(file);
  });
}
