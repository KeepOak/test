/* Automations › Procedures › Run: a saved procedure run by hand, only after the owner has read everything it will do.
   The dialog lists, as the engine keeps them, each step's exact call, each check, each clean-up call and how many tries
   (GET /api/flows-boards/recipes). Run then sends POST /api/flows-boards/recipes/<id>/run, which carries the lot out
   with the owner's own permissions (src/flows-boards/index.ts runChecked, the tool gate's "owner" mode): an "ask first"
   rule is not asked again, because pressing Run after reading it is the owner's yes, while a refusing rule, Branch's
   own files, Lockdown and an untrusted folder still stop it. Only a verified procedure replays; the engine says so. */
import { esc } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { toast, openDlg, closeDlg } from "../core/ui.js";
import { t } from "../../i18n.js";

const W = (key, vars) => t(`window.places.automations.${key}`, vars);
const callText = (tool, args) => { const text = args && Object.keys(args).length ? `${tool} ${JSON.stringify(args)}` : tool; return text.length > 160 ? `${text.slice(0, 159)}…` : text; };
const list = (items) => (items.length ? `<ol class="rr-list8">${items.map((item) => `<li><code>${esc(item)}</code></li>`).join("")}</ol>` : `<p class="hint">${esc(W("rr-none"))}</p>`);
const checkText = (check) => ("script" in check ? `code.run (${check.language})` : callText(check.tool, check.args)) + (check.contains ? ` → "${check.contains}"` : "");

async function openRun(el) {
  const record = (E.state?.procedures ?? []).find((p) => p.id === el.dataset.id);
  if (!record) return;
  let plan;
  try { plan = ((await api("flows-boards/recipes")).procedures ?? []).find((p) => p.id === record.id)?.checks; } catch (error) { toast(error.message); return; }
  const steps = (record.data?.definition?.steps ?? []).map((s) => callText(s.tool, s.arguments ?? s.args));
  const tries = 1 + (plan?.retries ?? 0);
  openDlg({ title: W("rr-title", { name: record.data?.definition?.name ?? "" }), wide: true,
    body: `<p class="lead-b17">${esc(W("rr-lead"))}</p><h3>${esc(W("rr-steps"))}</h3>${list(steps)}
      <h3>${esc(W("rr-checks"))}</h3>${list((plan?.checks ?? []).map(checkText))}
      <h3>${esc(W("rr-cleanup"))}</h3>${list((plan?.cleanup ?? []).map((c) => callText(c.tool, c.args)))}
      <p class="hint">${esc(W(tries === 1 ? "rr-tries-one" : "rr-tries", { n: tries }))}</p>`,
    foot: `<button class="btn ghost" type="button" data-act="dlg-close">${t("mode.cancel")}</button><button class="btn pri" type="button" data-act="recipe-run-go" data-id="${esc(record.id)}">${esc(W("rr-run"))}</button>` });
}

async function run(el) {
  closeDlg();
  try {
    const done = await api(`flows-boards/recipes/${encodeURIComponent(el.dataset.id)}/run`, { inputs: {} });
    toast(done.status === "passed" ? W("rr-passed", { n: done.attempts }) : `${W("rr-failed")} ${(done.reasons ?? []).join(" ")}`);
  } catch (error) { toast(error.message); }
}

export function initRecipeRun() {
  on("recipe-run", (el) => openRun(el));
  on("recipe-run-go", (el) => run(el));
}
export const recipeRunLive = ["recipe-run", "recipe-run-go"];
