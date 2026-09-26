/**
 * What the phone reads from the paired Branch, each through the same route the window uses:
 *   GET /api/state          runs, attention, trunkWaiting, schedules, memory, models, preferences, version
 *   GET /api/policy         the questions waiting for a yes, each with its fingerprint
 *   GET /api/sessions       the conversation list (limit=50), GET /api/trunks the Trunks and rooms
 *   GET /api/usage/glance   what each connection has left      GET /api/reach   this computer's name
 *   GET /api/never-break    the gateway, on or off               GET /api/look    theme and language
 *   GET /api/profiles       whether the one here is the owner    GET /api/lockdown whether Lockdown is on
 * Nothing is kept on the phone: a failed read leaves the last answer (or nothing) and says why.
 */
import { E, get, toast } from "/ph-core.js";

/** Reads one route into E[key]; a refusal is said once, and the last answer stays. */
async function read(key, path, query, pick = (x) => x) {
  try {
    E[key] = pick(await get(path, query));
  } catch (error) {
    if (E[`${key}Said`] !== error.message) toast(error.message);
    E[`${key}Said`] = error.message;
  }
  return E[key];
}
export const loadState = () => read("state", "/api/state");
export const loadWaiting = () => read("waiting", "/api/policy", undefined, (x) => (x.waiting ?? []).filter((q) => !q.parentRunId));
export const loadSessions = () => read("sessions", "/api/sessions", "limit=50", (x) => x.sessions ?? []);
export const loadTrunks = () => read("trunks", "/api/trunks", undefined, (x) => ({ trunks: x.trunks ?? [], rooms: x.rooms ?? [] }));
export const loadGlance = () => read("glance", "/api/usage/glance");
export const loadReach = () => read("reach", "/api/reach", undefined, (x) => ({ machineName: x.machineName ?? "" }));
export const loadGateway = () => read("gateway", "/api/never-break", undefined, (x) => ({ on: x.mode !== undefined && x.mode !== "off" }));
export const loadLook = () => read("look", "/api/look");
export const loadProfiles = () => read("profiles", "/api/profiles");
export const loadLockdown = () => read("lockdown", "/api/lockdown");
export const loadHeartbeat = () => read("heartbeat", "/api/heartbeat");
export const loadDocuments = () => read("documents", "/api/documents", undefined, (x) => x.documents ?? []);
export const loadAccounts = () => read("accounts", "/api/accounts", undefined, (x) => x.pools ?? []);
export const loadChannels = () => read("channels", "/api/channel-setup");
export const loadLocal = () => read("local", "/api/local-models");
export async function loadSession(id) {
  if (!/^[a-f0-9-]{36}$/.test(String(id ?? ""))) return null;
  await read(`session:${id}`, `/api/sessions/${id}`);
  return E[`session:${id}`];
}
export async function loadSessionModel(id) {
  if (!/^[a-f0-9-]{36}$/.test(String(id ?? ""))) return null;
  return read(`model:${id}`, `/api/sessions/${id}/model`);
}

/* ---------- names and lists every screen agrees on ---------- */
const trunks = () => E.trunks?.trunks ?? [];
const rooms = () => E.trunks?.rooms ?? [];
export const trunkOf = (sessionId) => trunks().find((t) => t.chatSessionId === sessionId || (t.retiredChats ?? []).includes(sessionId));
export const roomOf = (sessionId) => rooms().find((r) => r.sessionId === sessionId);
/** A conversation's name: its Trunk's, its room's, or its opening words. */
export function chatName(session) {
  const id = session?.sessionId;
  return trunkOf(id)?.name || roomOf(id)?.name || String(session?.opening ?? session?.preview ?? "").split("\n")[0].slice(0, 60);
}
export const nameFor = (sessionId) => chatName((E.sessions ?? []).find((s) => s.sessionId === sessionId) ?? { sessionId });
/** The questions and Trunk messages waiting for the owner, as the Inbox lists them. */
export const asks = () => E.waiting ?? [];
export const trunkWaiting = () => E.state?.trunkWaiting ?? [];
export const runs = () => E.state?.runs ?? [];
export const working = () => runs().filter((r) => r.status === "running");
export const finished = () => runs().filter((r) => r.status === "completed");
export const needsCount = () => asks().length + trunkWaiting().length;
/** A yes may only name its exact request: a question without a fingerprint is answered in its conversation. */
export const exact = (q) => /^[a-f0-9]{32}$/.test(String(q?.fingerprint ?? ""));
