import { api } from "../core/api.js";
import { E } from "../core/state.js";
import { $, esc } from "../core/dom.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openDlg, toast } from "../core/ui.js";

let ticket = 0, config = null, proposal = null, workspace = null, command = null, busy = false;
let credentialNames = [], initialized = false;
const owner = () => E.profiles?.isOwner === true;
const foot = (action, label) => `<button class="btn ghost" data-act="dlg-close">Close</button><button class="btn pri" data-act="${action}">${label}</button>`;
async function request(path, body, next) {
  if (!owner() || busy || !document.getElementById("daytona-wizard")) return;
  const mine = ticket; busy = true;
  try {
    const answer = await api(path, body);
    if (mine === ticket && owner() && document.getElementById("daytona-wizard")) next(answer);
  } catch (error) { if (mine === ticket && owner()) toast(error.message); }
  finally { busy = false; }
}
function dialog(title, body, action, label) {
  openDlg({ title, body: `<div id="daytona-wizard">${body}</div>`, foot: foot(action, label) });
}
async function open() {
  if (!owner()) return;
  const mine = ++ticket; config = null; proposal = null; command = null;
  try {
    const state = await api("daytona");
    if (mine !== ticket || !owner()) return;
    workspace = state.workspace;
    if (workspace && workspace.phase !== "deleted") { status(); return; }
    dialog("Where · Cloud workspace", `<p>Daytona: a separate disposable Linux workspace. This computer and its conversations stay here.</p><p>KeepOak and Modal execution are unavailable. SSH uses the existing Other computers settings.</p><p>No host files, account sign-ins or keys are copied. Outbound sandbox network is blocked. A fresh sandbox is billed by Daytona.</p><label>Region <select class="inp" id="dt-region"><option>us</option><option>eu</option></select></label><label>Snapshot <input class="inp" id="dt-snapshot" value="daytona-small" maxlength="101"></label><label>Destroy after minutes <input class="inp" id="dt-ttl" type="number" min="5" max="60" value="30"></label>`, "dt-signins", "Next: Sign-ins");
    credentialNames = state.credentialNames;
  } catch (error) { toast(error.message); }
}
function signins() {
  if (!owner()) return;
  config = { target: $("#dt-region")?.value, snapshot: $("#dt-snapshot")?.value, ttlMinutes: Number($("#dt-ttl")?.value) };
  dialog("Sign-ins · Daytona", `<p>Select the name of a Daytona API key saved in Settings → Sign-ins. No key is displayed or sent to the sandbox.</p><select class="inp" id="dt-secret">${credentialNames.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}</select><p>Check makes one account metadata request and creates nothing.</p>`, "dt-check", "Check connection");
}
function status() {
  dialog("Daytona workspace", `<p><b>${esc(workspace.name)}</b></p><p>State: ${esc(workspace.state ?? workspace.phase)}. Destruction deadline: ${esc(new Date(workspace.expiresAt).toLocaleString())}.</p><p>Refresh reconciles an uncertain creation or deletion; it never creates or restarts a sandbox.</p><button class="btn" data-act="dt-refresh">Refresh state</button><button class="btn" data-act="dt-stop">Review stop</button><button class="btn" data-act="dt-delete">Review delete</button><label>Command (cloud shell only)<textarea class="inp" id="dt-command" maxlength="4000"></textarea></label><p id="dt-output" role="status"></p>`, "dt-run", "Run through approval policy");
}
function lifecycle(action) {
  command = null;
  dialog(`Review ${action}`, `<p>${action === "delete" ? "Permanently destroy all files in" : "Stop (and immediately auto-delete)"} <b>${esc(workspace.name)}</b>?</p><p>All cloud work is disposable; nothing is copied back.</p>`, `dt-confirm-${action}`, `Confirm ${action}`);
}
export function initDaytona() {
  if (initialized) return;
  initialized = true;
  const actions = ["cloudnew17d", "dt-signins", "dt-check", "dt-prepare", "dt-create", "dt-refresh", "dt-run", "dt-run-confirm", "dt-stop", "dt-delete", "dt-confirm-stop", "dt-confirm-delete"];
  markLive(actions); on("cloudnew17d", open); on("dt-signins", signins);
  on("dt-check", () => {
    config = { ...config, secret: $("#dt-secret")?.value };
    void request("daytona/check", config, () => dialog("Check · Connected", "<p>API key accepted. No sandbox created. Review paid creation next.</p>", "dt-prepare", "Review creation"));
  });
  on("dt-prepare", () => request("daytona/prepare", config, (answer) => {
    proposal = answer; dialog("Confirm paid creation", `<p>${esc(answer.question)}</p>`, "dt-create", "Create paid sandbox");
  }));
  on("dt-create", () => request("daytona/create", { token: proposal?.token }, (answer) => { workspace = answer; status(); }));
  on("dt-refresh", () => request("daytona/reconcile", {}, (answer) => { workspace = answer; status(); }));
  for (const action of ["stop", "delete"]) {
    on(`dt-${action}`, () => lifecycle(action));
    on(`dt-confirm-${action}`, () => request("daytona/lifecycle", { action, name: workspace.name, confirm: true }, (answer) => {
      dialog("Request accepted", `<p>${esc(answer.note)}</p>`, "dt-refresh", "Verify completion");
    }));
  }
  const run = (confirm) => request("daytona/run", { ...command, confirm }, (answer) => {
    if (answer.status === "asked") dialog("Review exact command", `<pre>${esc(command.command)}</pre><p>${esc(answer.question)}</p>`, "dt-run-confirm", "Approve this command");
    else dialog("Cloud command result", `<pre>${esc(JSON.stringify(answer, null, 2))}</pre>`, "dt-refresh", "Refresh state");
  });
  on("dt-run", () => { command = { workspace: workspace.name, command: $("#dt-command")?.value, timeout: 30 }; void run(false); });
  on("dt-run-confirm", () => run(true));
}
