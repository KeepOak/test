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
import { ownerHere } from "../core/state.js";
import { t } from "../../i18n.js";

const SERVICES = [["google", "personal.google.name", "accounts.google.com"], ["microsoft", "personal.microsoft.name", "login.microsoftonline.com"]];
/* What the owner has typed and not saved yet, by field id, so a redraw never takes the words. */
const M = { signin: {}, busy: false, typed: {} };
const typed = (id, saved) => esc(M.typed[id] ?? saved ?? "");
/* Reuse the password controls during a draw of Accounts: a late read must not discard input. No secret goes into
   markup or draft state, and these transient node references are released at the end of that same draw. */
let passwordControls = [];
afterDraw(() => {
  for (const control of passwordControls) {
    const fresh = document.getElementById(control.id);
    if (fresh && fresh !== control && ownerHere()) fresh.replaceWith(control);
  }
  passwordControls = [];
});

/* The saved settings and whether each service is signed in; a refusal says why and leaves that service out. */
export async function loadMore() {
  if (!ownerHere()) return;
  await Promise.all(SERVICES.map(async ([service]) => {
    try { M.signin[service] = await api(`personal/signin/${service}`); } catch (error) { toast(error.message); delete M.signin[service]; }
  }));
  renderNow();
}

function service([id, name]) {
  const got = M.signin[id];
  if (!got) return "";
  const s = got.settings ?? {};
  const state = got.status?.signedIn ? `<span class="pill ok"><i></i>${t("personal.signin.yes")}</span>` : `<span class="pill idle"><i></i>${t("personal.signin.no")}</span>`;
  return `<div class="more18-svc"><div class="th"><b>${t(name)}</b>${state}</div>`
    + `<label class="fld"><span>${t("personal.signin.client")}</span><input class="inp" id="more18-${id}-client" value="${typed(`more18-${id}-client`, s.clientId)}" autocomplete="off"></label>`
    + `<label class="fld"><span>${t("personal.signin.secret-value")}</span><input class="inp" type="password" id="more18-${id}-secret" value="" autocomplete="new-password" spellcheck="false"></label>`
    + (id === "google" || id === "microsoft" ? `<label class="fld"><span>Allow calendar changes after confirmation</span><input type="checkbox" id="more18-${id}-calendar" ${s.calendarWrite ? "checked" : ""}></label><p class="hint">Save, then sign in again to allow event changes. Each change asks once. Calendar reminders are set for 24 hours before.</p>` : "")
    + (id === "google" || id === "microsoft" ? `<label class="fld"><span>Allow sending mail after preview and confirmation</span><input type="checkbox" id="more18-${id}-send" ${s.mailSend ? "checked" : ""}></label><p class="hint">Save, then sign in again to allow sending. Branch shows a local draft preview and asks Send? for each message.</p>` : "")
    + `<div class="acts"><button class="btn sm" type="button" data-act="more18-save" data-v="${id}">${t("personal.save")}</button><button class="btn pri sm" type="button" data-act="more18-signin" data-v="${id}">${t("personal.signin.go")}</button></div></div>`;
}

/* The two sections, drawn at the foot of Settings › Accounts; the owner's alone. */
export function moreSections() {
  if (!ownerHere()) return "";
  passwordControls = SERVICES.map(([id]) => document.getElementById(`more18-${id}-secret`)).filter(Boolean);
  return `<div class="sec more18"><h2>${t("window.flows.setup.email")}</h2><p class="hint">${t("window.flows.setup.email-hint")}</p>${SERVICES.map(service).join("")}</div>`
    + `<div class="sec more18"><h2>${t("first-run-steps.restore-title")}</h2><p class="hint">${t("first-run-steps.restore-purpose")}</p>`
    + `<div class="acts"><button class="btn" type="button" data-act="more18-restore" ${M.busy ? "disabled" : ""}>${ic("folder", "s")}${M.busy ? t("first-run-steps.restore-working") : t("window.flows.setup.backup")}</button></div>`
    + `<input type="file" id="more18-file" accept=".json,application/json" hidden></div>`;
}

/* The client id is saved; a client secret typed is sent once into the locker and the field emptied, and one left empty
   keeps whatever secret is already saved. */
async function save(id) {
  const client = document.getElementById(`more18-${id}-client`), secret = document.getElementById(`more18-${id}-secret`);
  if (!client || !secret) return false;
  const value = secret.value.trim();
  try {
    const calendar = document.getElementById(`more18-${id}-calendar`);
    const send = document.getElementById(`more18-${id}-send`);
    await api(`personal/signin/${id}`, { clientId: client.value.trim(), ...(calendar ? { calendarWrite: calendar.checked } : {}), ...(send ? { mailSend: send.checked } : {}) });
    delete M.typed[client.id];
    if (value) await api(`personal/signin/${id}/secret`, { value });
    secret.value = "";
    return true;
  } catch (error) { toast(error.message); return false; }
}

/* Only an https address on the service's own sign-in host is opened; the engine builds it from the service's own
   address (src/personal/signin.ts describeSignIn), so anything else is not followed. */
function safeAddress(url, host) {
  try { const u = new URL(url); return u.protocol === "https:" && u.hostname === host ? u.href : null; } catch { return null; }
}

async function signIn(id) {
  if (!(await save(id))) return;
  const host = SERVICES.find(([s]) => s === id)?.[2];
  let started;
  try { started = await api(`personal/signin/${id}/start`, {}); } catch (error) { toast(error.message); return; }
  const address = safeAddress(started?.url, host);
  if (!address) return;
  const opened = typeof window.branchDesktop?.openExternal === "function" ? window.branchDesktop.openExternal(address) : window.open(address, "_blank", "noopener");
  await Promise.resolve(opened).catch((error) => toast(error.message));
  toast(t("personal.signin.opened"));
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
  markLive(["more18-save", "more18-signin", "more18-restore", "sw:more18-file", ...SERVICES.flatMap(([id]) => [`sw:more18-${id}-client`, `sw:more18-${id}-secret`])]);
  on("more18-save", async (el) => { if (await save(el.dataset.v)) { toast(t("accounts.saved")); await loadMore(); } });
  on("more18-signin", (el) => signIn(el.dataset.v));
  on("more18-restore", () => document.getElementById("more18-file")?.click());
  document.addEventListener("input", (e) => { if (/^more18-\w+-client$/.test(e.target?.id ?? "")) M.typed[e.target.id] = e.target.value; }); // never the secret
  document.addEventListener("change", (e) => {
    if (e.target?.id !== "more18-file" || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    e.target.value = "";
    restore(file);
  });
}
