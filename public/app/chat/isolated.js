import { api } from "../core/api.js";
import { isolatedWindow as context, isolatedActor } from "../core/isolated-context.js";
import { S, E, refresh, ownerHere } from "../core/state.js";
import { esc, render } from "../core/dom.js";
import { on, has } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { toast } from "../core/ui.js";

let sessions = [], messages = [], sessionId = null, busy = false, error = "";
const active = () => !!context.profileId;
export const isolatedChatActive = active;

async function route(body, version = context.revision) {
  const id = context.profileId;
  if (!id) throw new Error("No isolated context is selected.");
  const profiles = await api("profiles");
  if (version !== context.revision || isolatedActor(profiles) !== context.actor || !profiles.profiles?.some((p) => p.id === id))
    throw new Error("Profile context changed. Return and select the gateway again.");
  const result = await api(`profile-gateways/${id}/route`, body);
  const after = await api("profiles");
  if (isolatedActor(after) !== context.actor) throw new Error("Profile changed; isolated response discarded.");
  if (version !== context.revision || result.profileId !== id) throw new Error("Isolated context changed; response discarded.");
  return result.result;
}

export async function enterIsolatedChat(id, name) {
  if (!ownerHere() || active()) return;
  const profiles = await api("profiles");
  if (!profiles.isOwner || !profiles.profiles.some((p) => p.id === id)) throw new Error("Select an existing household profile as owner.");
  const state = await api(`profile-gateways/${id}`);
  if (!state.running?.ok) throw new Error("Start this gateway and wait until it is ready.");
  const latest = await api("profiles");
  if (isolatedActor(latest) !== isolatedActor(profiles)) throw new Error("Profile changed during selection.");
  Object.assign(context, { profileId: id, name: profiles.profiles.find((p) => p.id === id)?.name ?? name, actor: isolatedActor(profiles), revision: context.revision + 1 });
  sessions = []; messages = []; sessionId = null; error = "";
  S.view = "chat"; S.chat = null; render();
  await readSessions();
}

async function readSessions() {
  const version = context.revision;
  try { const result = await route({ operation: "sessions" }, version); sessions = result.sessions ?? []; error = ""; }
  catch (failure) { if (version === context.revision) error = failure.message; }
  if (version === context.revision) render();
}

export function drawIsolatedChat() {
  const list = sessions.map((s) => `<button class="btn sm" type="button" data-act="ig-open" data-id="${esc(s.sessionId)}" ${busy ? "disabled" : ""}>${esc(s.title || s.preview || s.sessionId)}</button>`).join("");
  const rows = messages.map((m) => `<article><b>${esc(m.role)}</b><p data-css="white-space:pre-wrap">${esc(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? m.text ?? ""))}</p></article>`).join("");
  return `<div class="scroll"><h2>${esc(context.name)} · Independent gateway</h2><p>Separate conversations and memory. Global tools, sharing, uploads and owner services are unavailable here.</p>
    <div class="acts"><button class="btn" data-act="ig-exit" ${busy ? "disabled" : ""}>Return to logical profile</button><button class="btn" data-act="ig-refresh" ${busy ? "disabled" : ""}>Refresh conversations</button><button class="btn" data-act="ig-new" ${busy ? "disabled" : ""}>New isolated conversation</button></div>
    <nav aria-label="Isolated conversations">${list}</nav><p role="status">${esc(error || (busy ? "Waiting for this gateway…" : ""))}</p>${rows}
    <label>Message this isolated profile<textarea id="ig-prompt" ${busy ? "disabled" : ""}></textarea></label><button class="btn pri" data-act="ig-send" ${busy ? "disabled" : ""}>Send to isolated gateway</button></div>`;
}

async function send() {
  const prompt = document.getElementById("ig-prompt")?.value.trim();
  if (!active() || busy || !prompt) return;
  const version = context.revision;
  busy = true; error = ""; render();
  try {
    const result = await route({ operation: "run", prompt, ...(sessionId ? { sessionId } : {}) }, version);
    const id = result.sessionId ?? result.run?.sessionId;
    if (!id) throw new Error("Gateway returned no conversation ID. Refresh its conversations.");
    sessionId = id;
    const view = await route({ operation: "read", sessionId }, version);
    messages = view.messages ?? [];
    await readSessions();
  } catch (failure) { if (version === context.revision) error = failure.message; }
  finally { if (version === context.revision) { busy = false; render(); } }
}

export function initIsolatedChat() {
  if (has("ig-send")) return;
  on("ig-send", send); on("ig-refresh", readSessions);
  on("ig-new", () => { if (!busy) { sessionId = null; messages = []; render(); } });
  on("ig-open", async (el) => {
    if (!active() || busy) return;
    const version = context.revision, id = el.dataset.id;
    busy = true; render();
    try { const view = await route({ operation: "read", sessionId: id }, version); sessionId = id; messages = view.messages ?? []; render(); }
    catch (failure) { toast(failure.message); }
    finally { if (version === context.revision) { busy = false; render(); } }
  });
  on("ig-exit", async () => {
    if (busy) return;
    Object.assign(context, { profileId: null, name: "", actor: null, revision: context.revision + 1 });
    sessions = []; messages = []; sessionId = null; S.chat = null; S.view = "chat";
    try { await refresh(); } catch (failure) { toast(failure.message); }
    render();
  });
  markLive(["ig-send", "ig-refresh", "ig-new", "ig-open", "ig-exit"]);
}
