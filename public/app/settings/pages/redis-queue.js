/* Owner-configured Redis coordination. Opening this page reads local metadata only. */
import { esc, render } from "../../core/dom.js";
import { E, ownerHere, activeId } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { settingsRow, switchRow, linkRow } from "../row-kit.js";

let data = null, draft = null, status = null, message = "", busy = false, epoch = 0;
let request = null, id = crypto.randomUUID(), prompt = "", seconds = 60;
const actor = () => JSON.stringify([ownerHere(), activeId(), E.profiles?.owner?.name]);
const path = "interop/redis-queue";
const held = () => busy || !data || Boolean(data.heldReason);
const disabled = (on) => on ? " disabled" : "";
const action = (name, label, off, extra = "") => `<button type="button" class="btn sm" data-act="redis-${name}"${disabled(off)} ${extra}>${esc(label)}</button>`;

function clear() {
  epoch++; request?.abort(); request = null; data = draft = status = null; message = ""; busy = false;
  id = crypto.randomUUID(); prompt = ""; seconds = 60;
}

async function ask(name, body) {
  if (!ownerHere() || busy) return;
  const who = actor(), version = ++epoch;
  request?.abort(); request = new AbortController(); busy = true; message = ""; render();
  try {
    const result = await api(name, body, undefined, request.signal);
    if (!ownerHere() || actor() !== who || epoch !== version) return;
    return result;
  } catch (error) {
    if (ownerHere() && actor() === who && epoch === version && error.name !== "AbortError") {
      if ([403, 423].includes(error.status)) clear();
      message = error.message; render();
    }
  } finally { if (epoch === version) { busy = false; request = null; render(); } }
}

function useView(view) {
  if (!view || !ownerHere()) return;
  data = view;
  if (!draft) draft = view.settings.mode === "on" ? { ...view.settings }
    : { mode: "off", endpoint: "", fleet: crypto.randomUUID(), project: view.activeProject, tokenName: "REDIS_FLEET_TOKEN" };
  render();
}

export async function load() { if (ownerHere()) useView(await ask(path + "/control")); else clear(); }

async function operate(operation, extra = {}) {
  if (held()) return;
  const result = await ask(path + "/control", { operation, ...extra });
  if (!result || !ownerHere()) return;
  if (operation === "status") {
    status = result;
    if (result.waiting === undefined) message = `Queue status: ${result.status ?? "unknown"}; no counts were verified.`;
  }
  else message = result.status === "claimed" ? "Lease acquired. This page has not executed the job."
    : `Redis result: ${result.status ?? "unknown"}${result.id ? ` (${result.id})` : ""}.`;
  if (operation === "submit" && ["submitted", "existing", "completed"].includes(result.status)) { prompt = ""; id = crypto.randomUUID(); }
  const note = message;
  useView(await ask(path + "/control"));
  if (ownerHere()) { message = note; render(); }
}

async function save() {
  if (!ownerHere() || !draft || busy) return;
  const value = draft.mode === "off" ? { mode: "off" } : { ...draft };
  const result = await ask(path, value);
  if (!result || !ownerHere()) return;
  status = null; draft = result.mode === "on" ? { ...result } : { ...draft, mode: "off" };
  useView(await ask(path + "/control"));
}

export function init() {
  on("redis-save", save);
  on("redis-status", () => operate("status"));
  on("redis-claim", () => operate("claim", { leaseSeconds: seconds }));
  on("redis-submit", () => operate("submit", { id, prompt }));
  on("redis-new", () => { if (ownerHere() && !busy) { id = crypto.randomUUID(); prompt = ""; render(); } });
  on("redis-release", (button) => operate("release", { handle: button.dataset.handle }));
  on("redis-complete", (button) => {
    const check = document.getElementById("redis-verified-" + button.dataset.handle);
    if (check?.checked) return operate("complete", { handle: button.dataset.handle, verified: true });
    message = "Confirm you independently verified the work is finished before marking its lease complete."; render();
  });
  document.addEventListener("input", edit);
  return load();
}

function edit(event) {
  if (!ownerHere() || !draft || busy) return;
  const field = event.target;
  if (field.id === "redis-prompt") prompt = field.value;
  else if (field.id === "redis-seconds") seconds = Number(field.value);
  else if (field.id === "redis-enabled") draft.mode = field.checked ? "on" : "off";
  else if (field.dataset?.redisField) draft[field.dataset.redisField] = field.value;
}

function textField(field, title, description) {
  return settingsRow({ title, description, configPath: `redis-fleet-queue.${field}`,
    control: `<input class="inp" type="text" aria-label="${esc(title)}" data-redis-field="${field}" value="${esc(draft[field])}" maxlength="${field === "endpoint" ? 500 : 64}" autocomplete="off"${disabled(busy)}>` });
}

function configuration() {
  return `<section class="sec"><h2>Redis connection</h2>`
    + switchRow({ title: "Redis coordination", description: "Off by default. Saving on permits explicit queue calls; Fleet must also be enabled in Customize. No connection is made by saving.",
      id: "redis-enabled", checked: draft.mode === "on", attributes: disabled(busy), configPath: "redis-fleet-queue.mode" })
    + textField("endpoint", "HTTPS REST endpoint", "Use the root URL of a Redis REST compatible service. No path, credentials, query or fragment. Existing network policy and DNS-pinned TLS apply.")
    + textField("fleet", "Fleet ID", "A UUID shared by participating computers with the same owner identity. Different owner identities or fleet IDs use separate queues.")
    + textField("project", "Locker project", `Only the current active project can supply the named token. Current project: ${data.activeProject}.`)
    + textField("tokenName", "Locker token name", "An environment-style name such as REDIS_FLEET_TOKEN. Save its value in the project's existing locker; this page never reads or displays that value.")
    + linkRow({ title: "Save connection settings", description: "Changes apply immediately and cancel active calls. They do not provision Redis, send a job or require an engine restart.",
      label: "Save", action: "redis-save", attributes: disabled(busy) })
    + `<p class="hint">Named token: ${data.tokenConfigured ? "present in the current project's locker" : "not available for this configuration"}. ${esc(data.heldReason)}</p></section>`;
}

function queue() {
  const count = status?.waiting !== undefined ? `${status.waiting} waiting; ${status.leased} leased. Expired leases count as leased until reclaimed.`
    : "Not checked. Refresh sends one explicit Redis request; there is no background polling.";
  return `<section class="sec"><h2>Queue operations</h2><p role="status">${esc(count)}</p>`
    + linkRow({ title: "Queue status", description: "Read waiting and leased counts from the configured fleet. At most 100 pending plus leased jobs; data expires after seven days without queue activity.",
      label: "Refresh status", action: "redis-status", attributes: disabled(held()) })
    + settingsRow({ title: "Lease duration", description: "15–300 seconds, default 60. A crashed consumer's job becomes available again after expiry. This page never runs a claimed job.",
      control: `<input class="inp" id="redis-seconds" type="number" min="15" max="300" step="1" value="${esc(seconds)}" aria-label="Lease duration in seconds"${disabled(held())}>` })
    + linkRow({ title: "Claim one job", description: "Acquire a bounded data lease. Execution requires fresh local permissions and approval. Up to five expired leases are reclaimed per claim.",
      label: "Claim", action: "redis-claim", attributes: disabled(held()) })
    + settingsRow({ title: "Queue prompt data", description: "Sending uploads scrubbed text to the owner's configured service; it does not start a task. Maximum 8,000 characters and 12,000 serialized bytes. Do not include unknown secrets.", wrapControl: false,
      control: `<textarea class="inp" id="redis-prompt" maxlength="8000" rows="4" aria-label="Prompt data to queue"${disabled(held())}>${esc(prompt)}</textarea>` })
    + settingsRow({ title: "Submission ID", description: "This stable UUID makes retries of the same payload idempotent while retained. After an ambiguous failure keep the same ID and text; never blindly repeat external work.",
      control: `<code>${esc(id)}</code>${action("submit", "Send data", held())}${action("new", "New submission", busy)}` })
    + `</section>`;
}

function leases() {
  return `<section class="sec"><h2>Leases held by this control process</h2><p class="hint">Tokens stay in the backend. Locking or changing connection settings forgets these controls; Redis leases still expire. Leases do not establish exactly-once external effects.</p>`
    + (data.leases.length ? data.leases.map(lease => settingsRow({ title: `Job ${lease.id}`,
      description: `Redis expiry: ${new Date(lease.expiresAt).toISOString()}. Release returns data to the queue; completion only records your assertion. No job is executed here.`, wrapControl: false,
      control: `<pre>${esc(lease.prompt)}</pre><label><input type="checkbox" id="redis-verified-${esc(lease.handle)}"${disabled(held())}> I independently verified the work is finished</label>`
        + action("release", "Release", held(), `data-handle="${esc(lease.handle)}"`)
        + action("complete", "Mark complete", held(), `data-handle="${esc(lease.handle)}"`) })).join("")
      : `<p>No leases are held here. Other fleet consumers' lease tokens and job bodies are not exposed.</p>`) + `</section>`;
}

export function draw() {
  if (!ownerHere()) { if (data || draft || request) clear(); return `<p>This page belongs to the owner. Switch to the unlocked owner's profile.</p>`; }
  if (!data || !draft) return `<p role="status">${esc(message || "Reading local Redis settings…")}</p>`;
  return `<p class="hint">Optional distributed coordination. Automatic fleet execution and authority transport are not implemented.</p>`
    + `<p role="status" aria-live="polite">${esc(busy ? "Waiting for the owner API…" : message)}</p>` + configuration() + queue() + leases();
}
