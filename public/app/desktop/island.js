const $ = id => document.getElementById(id);
async function request(path, body, method = body === undefined ? "GET" : "POST", bytes = false) {
  const response = await fetch(`/api/${path}`, { method, cache: "no-store", headers: {
    "x-branch-origin": "window", ...(body === undefined ? {} : { "content-type": bytes ? body.type || "application/octet-stream" : "application/json" }),
  }, ...(body === undefined ? {} : { body: bytes ? body : JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `Request refused (${response.status})`), { status: response.status });
  return data;
}
const api = (path, body, method) => request(path, body, method);
const apiBytes = (path, bytes) => request(path, bytes, "POST", true);
let scope = "", files = [], refreshing = false, busy = false, epoch = 0;
const message = text => { $("status").textContent = text; };
const item = text => { const li = document.createElement("li"); li.textContent = text; return li; };
function clearFiles() { files = []; $("files").replaceChildren(); window.branchIsland?.clear().catch(() => {}); }
async function current(expected = scope) {
  try {
    const state = await api("desktop/island");
    if (expected && expected !== state.scope) { retire("The person using Branch changed. Drop the files again."); throw new Error("The person using Branch changed. Drop the files again."); }
    return state;
  } catch (error) { if (error.status === 403 || error.status === 423) retire(error.message); throw error; }
}
function retire(reason) {
  ++epoch; scope = ""; clearFiles(); $("owner").hidden = true;
  $("tasks").replaceChildren(); $("trunk").replaceChildren();
  $("presence").textContent = "Unknown until the engine answers.";
  $("usage-summary").textContent = "Recorded usage unavailable."; $("usage-history").replaceChildren(); $("usage-basis").textContent = "";
  $("meeting").textContent = "Unavailable until you refresh a connected calendar.";
  message(reason);
}
async function refresh() {
  if (refreshing || busy || document.hidden) return;
  refreshing = true;
  const generation = epoch;
  try {
    const state = await current();
    const [power, resources] = await Promise.all([api("never-break"), window.branchIsland.stats()]);
    await current(state.scope);
    if (generation !== epoch) return;
    scope = state.scope; $("owner").hidden = false;
    const presence = state.presence;
    $("presence").textContent = presence ? `Engine connected · recent active task records: ${presence.running} working, ${presence.waiting} waiting for an answer, ${presence.paused} paused${presence.running + presence.waiting + presence.paused === 0 ? " · idle" : ""}.` : "Engine connected · presence counts unavailable.";
    $("tasks").replaceChildren(...(state.tasks.length ? state.tasks.map(task => item(`${task.title} · ${task.status}`)) : [item("No tasks running")]));
    const selected = $("trunk").value;
    $("trunk").replaceChildren(...state.trunks.map(trunk => { const option = document.createElement("option"); option.value = trunk.id; option.textContent = trunk.name; return option; }));
    if (state.trunks.some(trunk => trunk.id === selected)) $("trunk").value = selected;
    $("awake").checked = !!power.config?.keepAwake;
    $("power").textContent = power.keepAwakeRuntime?.error || (power.keepAwakeRuntime?.active ? "Keep awake is active." : power.config?.keepAwake ? "Requested; applies while the desktop gateway is running." : "Keep awake is off.");
    const gb = bytes => (bytes / 1073741824).toFixed(1);
    $("resources").textContent = `Computer CPU ${resources.cpu === null ? "unavailable" : `${Math.round(resources.cpu)}%`} · memory ${gb(resources.memoryUsed)} / ${gb(resources.memoryTotal)} GB`;
    message("Ready");
  } catch (error) { retire(error.message); } finally { refreshing = false; }
}
async function operation(action) {
  if (busy) return;
  busy = true;
  const captured = scope, generation = epoch;
  for (const button of document.querySelectorAll("main button")) button.disabled = true;
  try { await current(captured); await action(captured, generation); }
  catch (error) { message(error.message); }
  finally { busy = false; for (const button of document.querySelectorAll("main button")) button.disabled = false; }
}
async function usage(captured, generation) {
  $("usage-summary").textContent = "Reading stored receipts…"; $("usage-history").replaceChildren();
  $("usage-basis").textContent = "";
  let result;
  try { result = await api("desktop/island/usage"); await current(captured); }
  catch (error) { if (generation === epoch) $("usage-summary").textContent = `Recorded usage unavailable: ${error.message}`; throw error; }
  if (generation !== epoch || result.scope !== captured) return;
  const money = period => !period.tasks ? "No recorded tasks" : !period.priced ? "Cost unknown (no saved price)"
    : `~$${period.estimatedCost.toFixed(2)}${period.unpriced ? ` plus ${period.unpriced} unpriced tasks` : ""}`;
  const tokens = period => `${period.input.toLocaleString()} input / ${period.output.toLocaleString()} output tokens`;
  $("usage-summary").textContent = `Today: ${money(result.today)} · ${tokens(result.today)}. This month: ${money(result.month)} · ${tokens(result.month)}.`;
  $("usage-history").replaceChildren(...result.history.map(day => item(`${day.date}: ${money(day)} · ${tokens(day)}`)));
  $("usage-basis").textContent = `${result.costBasis}. ${result.tokenBasis}. ${result.dayBasis}. Last ${result.history.length} recorded days; read ${new Date(result.measuredAt).toLocaleTimeString()}.`;
  message("Recorded usage refreshed.");
}
const base64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onerror = () => reject(new Error(`Cannot read ${file.name}`));
  reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(file);
});
async function library(captured) {
  if (!files.length) throw new Error("Drop files first.");
  let kept = 0;
  for (const file of [...files]) {
    const content = await base64(file); await current(captured);
    await api("documents", { name: file.name, content }); await current(captured); kept++;
    files = files.filter(candidate => candidate !== file);
  }
  clearFiles(); message(`${kept} files kept in Library.`);
}
async function send(captured) {
  const trunkId = $("trunk").value;
  if (!files.length || !trunkId) throw new Error("Drop files and choose an available Trunk.");
  const uploads = [];
  try {
    for (const file of [...files]) {
      await current(captured);
      const result = await apiBytes(`attachments/upload?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || "application/octet-stream")}`, file);
      uploads.push(result.upload); await current(captured);
    }
    const { sessionId } = await api("trunks/conversations", { trunkId }); await current(captured);
    await api("run", { sessionId, prompt: "Please review the attached files.", uploads });
    clearFiles(); message("Files sent to the chosen Trunk. Open Branch to follow the task.");
  } catch (error) {
    for (const upload of uploads) await api(`attachments/upload?id=${encodeURIComponent(upload)}`, undefined, "DELETE").catch(() => {});
    throw error;
  }
}
async function meeting(captured, generation) {
  $("meeting").textContent = "Meeting unavailable while the calendar is being refreshed.";
  const provider = $("calendar").value;
  const result = await api(`personal/${provider}/events`, {}); await current(captured);
  if (generation !== epoch) return;
  const events = result.events ?? result.result?.events;
  if (!Array.isArray(events)) throw new Error("Calendar results unavailable. Open Branch to review any approval request.");
  const timestamp = event => Date.parse(provider === "microsoft" && !/(Z|[+-]\d\d:\d\d)$/.test(event.starts) ? `${event.starts}Z` : event.starts);
  const next = events.filter(event => event.starts?.includes("T") && timestamp(event) >= Date.now()).sort((a, b) => timestamp(a) - timestamp(b))[0];
  if (result.ok === false) throw new Error(result.error || "Calendar unavailable. Open Branch to review any approval request.");
  $("meeting").textContent = next ? `${next.title} · ${new Date(timestamp(next)).toLocaleString()}` : "No upcoming timed meeting returned for the next 24 hours.";
  message("Calendar refreshed.");
}
$("drop").addEventListener("dragover", event => { event.preventDefault(); $("drop").classList.add("over"); });
$("drop").addEventListener("dragleave", () => $("drop").classList.remove("over"));
$("drop").addEventListener("drop", event => {
  event.preventDefault(); $("drop").classList.remove("over");
  if (busy || !scope || !event.isTrusted) return;
  const incoming = [...event.dataTransfer.files];
  if (incoming.length > 20 || incoming.some(file => file.size > 20 * 1024 * 1024)) { message("Drop up to 20 files, each at most 20 MB."); return; }
  files = incoming; $("files").replaceChildren(...files.map(file => item(file.name))); message("Choose what to do with these files.");
});
$("library").onclick = () => operation(library);
$("send").onclick = () => operation(send);
$("meeting-refresh").onclick = () => operation(meeting);
$("usage-refresh").onclick = () => operation(usage);
$("copy").onclick = () => operation(async captured => { if (!files.length) throw new Error("Drop files first."); const result = await window.branchIsland.copy(); await current(captured); clearFiles(); message(`${result.copied} files copied.`); });
$("clear").onclick = clearFiles;
$("open").onclick = () => window.branchIsland.open();
$("awake").onchange = () => operation(async captured => { await api("never-break", { keepAwake: $("awake").checked }); await current(captured); message("Keep-awake choice saved."); });
document.addEventListener("visibilitychange", () => { if (document.hidden) retire("Mini bar hidden."); else refresh(); });
addEventListener("pagehide", () => retire("Mini bar closed."));
setInterval(refresh, 3000); refresh();
