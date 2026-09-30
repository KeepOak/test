/* Settings › Permissions: three controls that change what Branch guards, each through the engine's own guard.
   - Scan for personal details: POST /api/privacy with pii.outbound "mask" (as it ships) or "off". Off lets personal
     details in messages sent out through unchecked, so the engine answers 409 until the owner says yes (askLoosen).
   - Authenticator code for sensitive tools: on once an authenticator app is set up (GET /api/safety-extras
     codes.enrolled) and the part is not off. Turning it on without one sets it up first: codes/begin gives the key, shown
     once in the dialog to add to the app; the app's first code (codes/finish) ends the setup, then the part is switched
     on. Cancel takes the half-made setup away again (codes/remove). Turning it off needs a code from the app: the engine
     answers 401 without one.
   - Trusted folders › Add: the engine's folders (GET /api/folder-trust), each with what it carries for AI assistants.
     Trust needs the owner's yes (409) and is refused under Lockdown; Don't trust always goes through. */
import { esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast, openDlg, closeDlg } from "../core/ui.js";
import { t } from "../../i18n.js";

const PII = "f15-scan-for-personal-details", CODE = "f15-authenticator-code-for-sensitive-tools";
const W = (key, vars) => t(`window.settings.permissions.${key}`, vars);
let G = null; // { P, load, askLoosen } from the page

export const piiOn = (P) => (P.privacy?.pii?.outbound ?? "off") !== "off";
export const codesOn = (P) => P.safety?.codes?.enrolled === true && (P.safety?.modes?.["code-approvals"] ?? "off") !== "off";

async function setPii(on) {
  const now = G.P.privacy;
  if (!now?.pii) return G.load();
  const body = { ...now, pii: { ...now.pii, outbound: on ? (now.pii.outbound === "off" ? "mask" : now.pii.outbound) : "off" } };
  try { await api("privacy", body); } catch (error) { G.askLoosen(error, body, "privacy"); }
  await G.load();
}

/* ---------- Authenticator codes ---------- */
const codeBox = (id) => `<input class="inp" id="${id}" inputmode="numeric" autocomplete="one-time-code" maxlength="12" aria-label="${esc(W("auth-code"))}">`;
const typed = (id) => (document.getElementById(id)?.value ?? "").trim();
const switchCodes = (mode, code) => api("safety-extras/switch", { part: "code-approvals", mode, ...(code ? { code } : {}) });

async function setCodes(on) {
  const codes = G.P.safety?.codes;
  if (!codes) return G.load();
  if (on && codes.enrolled) { try { await switchCodes("when-needed"); } catch (error) { toast(error.message); } return G.load(); }
  if (on) return beginSetup();
  openDlg({ title: W("auth-off-title"), body: `<p class="lead-b17">${esc(W("auth-off-lead"))}</p>${codeBox("auth-offcode8")}`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn bad" type="button" data-act="auth-off8">${esc(W("auth-turn-off"))}</button>` });
  await G.load();
}
async function beginSetup() {
  let begun;
  try { begun = await api("safety-extras/codes/begin", {}); } catch (error) { toast(error.message); return G.load(); }
  openDlg({ title: W("auth-setup-title"), body: `<p class="lead-b17">${esc(W("auth-setup-lead"))}</p>
      <div class="field"><label>${esc(W("auth-key"))}</label><code class="code15" id="auth-key8">${esc(begun.key)}</code></div>${codeBox("auth-code8")}`,
    foot: `<button class="btn ghost" type="button" data-act="auth-cancel8">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="auth-finish8">${esc(W("auth-turn-on"))}</button>` });
  await G.load();
}
async function finishSetup() {
  const code = typed("auth-code8");
  if (!code) return;
  try {
    await api("safety-extras/codes/finish", { code });
    if ((G.P.safety?.modes?.["code-approvals"] ?? "off") === "off") await switchCodes("when-needed");
  } catch (error) { toast(error.message); return; }
  closeDlg();
  toast(W("auth-on"));
  await G.load();
}
async function cancelSetup() {
  closeDlg();
  // Only a setup that never finished is taken away; one finished meanwhile needs a code, so the engine refuses it.
  if (!G.P.safety?.codes?.enrolled) await api("safety-extras/codes/remove", {}).catch(() => null);
  await G.load();
}
async function turnOff() {
  const code = typed("auth-offcode8");
  if (!code) return;
  try { await switchCodes("off", code); } catch (error) { toast(error.message); return; }
  closeDlg();
  await G.load();
}

/* ---------- Trusted folders ---------- */
const KINDS = [["instructions", "notes"], ["aiToolServers", "servers"], ["skills", "skills"], ["hooks", "hooks"], ["plugins", "plugins"]];
function carries(found) {
  const rows = KINDS.filter(([k]) => (found?.[k] ?? []).length).map(([k, kind]) => {
    const names = found[k], shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? ` ${t("folder-trust.more", { count: names.length - 3 })}` : "";
    return `<li><b>${esc(t(`folder-trust.kind.${kind}`))}</b>: ${esc(shown)}${esc(more)}</li>`;
  });
  return rows.length ? `<ul class="ft-kinds8">${rows.join("")}</ul>` : `<small>${esc(W("holds-nothing"))}</small>`;
}
function folderRow(f) {
  const name = f.project === null ? t("folder-trust.workspace") : t("folder-trust.project-folder", { name: f.project });
  const pick = (decision, words, pressed) => `<button type="button" aria-pressed="${pressed}" data-act="ft-pick8" data-v="${decision}" data-folder="${esc(f.folder)}">${esc(words)}</button>`;
  return `<div class="prow ft-row8"><span class="grow"><b>${esc(name)}</b><small>${esc(t(`folder-trust.state.${f.trust}`))}</small>${carries(f.found)}</span>
    <span class="seg">${pick("trust", W("trust"), f.trust === "trusted")}${pick("distrust", W("dont-trust"), f.trust === "untrusted")}</span></div>`;
}
async function foldersDlg() {
  let view;
  try { view = await api("folder-trust"); } catch (error) { toast(error.message); return; }
  openDlg({ title: t("settings-kit.name.folder-trust"), wide: true,
    body: `<p class="lead-b17">${esc(t("folder-trust.lead"))} ${esc(t(`folder-trust.mode.${view.mode}`))}</p><div class="rows">${view.folders.map(folderRow).join("")}</div>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${esc(W("done"))}</button>` });
}
async function pickFolder(el) {
  const body = { folder: el.dataset.folder ?? "", decision: el.dataset.v };
  try { await api("folder-trust", body); await foldersDlg(); } catch (error) { G.askLoosen(error, body, "folder-trust"); }
}

export function initGuards(page) {
  G = page;
  document.addEventListener("change", (e) => {
    if (e.target?.id === PII) setPii(e.target.checked);
    else if (e.target?.id === CODE) setCodes(e.target.checked);
  });
  on("auth-finish8", () => finishSetup());
  on("auth-cancel8", () => cancelSetup());
  on("auth-off8", () => turnOff());
  on("ft-add8", () => foldersDlg());
  on("ft-pick8", (el) => pickFolder(el));
}
export const guardsLive = ["sw:" + PII, "sw:" + CODE, "ft-add8", "ft-pick8", "auth-finish8", "auth-cancel8", "auth-off8", "sw:auth-code8", "sw:auth-offcode8"];
