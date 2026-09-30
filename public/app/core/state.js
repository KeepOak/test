/* Two kinds of state. S is the window's own (what is open, what is typed); E is what the engine said (loaded, never
   invented). Only the few window choices worth keeping between visits are saved, in this browser. */

import { api } from "./api.js";
import { render } from "./dom.js";
import { t } from "../../i18n.js";
import { modeValue, revealModeValue } from "./interface-mode.js";

const SAVED_KEY = "branch-window";
const SAVED = ["level", "placesShut", "theme", "sideW", "paneW", "dockW", "rail", "sideHidden", "home19", "simple", "advLevel"];

export const S = {
  view: "chat",
  chat: null,
  tabs: { inbox: "needs", automations: "scheduled", library: "memory", customize: "trunks" },
  setPage: "general",
  level: "regular",
  simple: false, // Simple masks display choices; their underlying preferences are preserved.
  advLevel: null,
  drafts: {},
  placesShut: false,
  theme: null,
  sideW: null,
  paneW: null,
  dockW: null,
  rail: false,
  sideHidden: false,
  home19: { open: false, sid: null }, // RES-701: the Home panel open or not, and its own conversation (shell/home.js)
  signedIn: true,
};

export const E = {
  state: null,
  trunks: [],
  trunkModes: {},
  rooms: [],
  sessions: [],
  conversation: null,
  profiles: null,
  loaded: false,
};

const interfaceScope = () => JSON.stringify([E.profiles?.active?.id ?? null, E.profiles?.isOwner ?? null]);
export const displayPreference = (key, preference) => modeValue(S.simple === true, key, preference, interfaceScope());
export const revealDisplay = (key, value) => revealModeValue(S.simple === true, key, value, interfaceScope());
/* Existing pane writers keep their contract; Simple writes are temporary reveals, never a snapshot to restore. */
let panePreference = null;
Object.defineProperty(S, "pane", { enumerable: true, get: () => displayPreference("pane", panePreference),
  set: (value) => { if (!revealDisplay("pane", value)) panePreference = value; } });

function migrateSimple(saved) {
  const kept = saved.simpleFrom;
  if (!kept || typeof kept !== "object" || Array.isArray(kept)) return false;
  if (saved.simple === true) {
    if (saved.level === "regular" && ["regular", "advanced", "technical"].includes(kept.level)) S.level = kept.level;
    if (S.home19?.open === false && typeof kept.home19 === "boolean") S.home19 = { ...S.home19, open: kept.home19 };
    if (typeof kept.pane === "string" || kept.pane === null) panePreference = kept.pane;
    if (typeof kept.setPage === "string") S.setPage = kept.setPage;
  }
  return true; // Saving drops the legacy snapshot even when Simple is already off.
}

export function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || "{}");
    for (const key of SAVED) if (key in saved) S[key] = saved[key];
    // The side panel is not a saved choice, but one Simple put out of sight comes back after a reload in Simple.
    if (saved.simple === true && (typeof saved.simplePane === "string" || saved.simplePane === null)) panePreference = saved.simplePane;
    if (migrateSimple(saved)) save();
  } catch { /* a broken save is ignored */ }
}
export function save() {
  const kept = Object.fromEntries(SAVED.map((k) => [k, S[k]]));
  if (S.simple === true) kept.simplePane = panePreference;
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(kept)); } catch { /* storage refused */ }
}

/* The engine's picture of things: state, the Trunks and the conversation list. */
export async function refresh() {
  /* One request first: until the engine accepts the window, every refused request counts against sign-in. */
  const state = await api("state");
  const [trunks, sessions, profiles] = await Promise.all([
    api("trunks").catch(() => null),
    api("sessions?limit=50").catch(() => null),
    api("profiles").catch(() => null),
  ]);
  /* A read that failed keeps what the window last had. Emptied, one refused or dropped GET /api/trunks lost every Trunk
     and the modes: "@Ada …" then found no Ada and went out as an ordinary message in a new conversation (trunks-ui on
     CI), and the side list lost its Trunks and conversations until the next read. */
  if (profiles) E.profiles = profiles;
  E.state = state;
  if (trunks) {
    E.trunks = trunks.trunks ?? (Array.isArray(trunks) ? trunks : []);
    E.trunksRead = true; // pass 18: an empty Trunks list is a welcome only when the engine answered
    E.trunkModes = trunks.modes ?? {};
    E.defaultTrunkId = trunks.defaultId ?? null; // the default Trunk answers every chat nobody routed elsewhere
    E.rooms = Array.isArray(trunks.rooms) ? trunks.rooms : [];
    if (Array.isArray(trunks.characters)) E.characters = trunks.characters; // the characters a Trunk can wear (core/art17.js)
  }
  if (sessions) {
    E.sessions = sessions.sessions ?? [];
    E.putAway = { archived: sessions.archived ?? 0, deleted: sessions.deleted ?? 0 }; // chat/putaway.js: Archived, Recently Deleted
  }
  E.loaded = true;
  render();
}

/* Who is using Branch now: GET /api/profiles answers `active` as the person's profile ({ id, name, … }), or null for the
   owner, whose name is the engine's owner label. */
export const activeId = () => E.profiles?.active?.id ?? null;
/* A role's name (owner, adult, child) in the window's language (household.role.*), once the engine has said which roles there are. */
export const roleLabel = (role) => {
  const engine = E.profiles?.roleLabels?.[role]?.label;
  if (!engine) return "";
  const key = `household.role.${role}`, words = t(key);
  return words === key ? engine : words;
};
/* A project's name; the one the engine makes for everybody ("Default", src/projects.ts) is named in the window's language. */
export const projectName = (p) => (p?.id === "default" && p.name === "Default" ? t("look.badge.default") : p?.name ?? "");
/* Q050: how many things wait for the person, counted once each by the engine (GET /api/state needsYou): the sidebar's
   Inbox, the Inbox's Needs you, Overview and Health all read this one number, never a sum of lists of their own. */
export const needsYou = () => (Number.isInteger(E.state?.needsYou) ? E.state.needsYou : 0);
export const personHere = () => E.profiles?.active?.name || E.profiles?.owner?.name || roleLabel("owner"); // your-profile: the owner's own name once given
/* Whether the one at the window is the owner, as the engine says (GET /api/profiles isOwner). Owner-only controls are drawn
   only then: not while the answer is missing, and never for a household person (they are not theirs to use, not "coming soon"). */
export const ownerHere = () => E.profiles?.isOwner === true;

/* The level control: Regular 0, Advanced 1, Technical 2. */
export const LEVELS = { regular: 0, advanced: 1, technical: 2 };
export const level = () => LEVELS[displayPreference("level", S.level)] ?? 0;

/* A conversation that is a Trunk's own (or one it retired) or a room's is named and drawn for it, as the prototype's
   rowHtml and av(c) do: the Trunk's face, or a room's stack of two member faces (GET /api/trunks rooms[].members). */
export const ownTrunkOf = (id) => (id ? E.trunks.find((t) => t.chatSessionId === id || (t.retiredChats ?? []).includes(id)) : undefined);
const roomOf = (id) => (id ? E.rooms.find((r) => r.sessionId === id) : undefined);
export const ownName = (id) => ownTrunkOf(id)?.name || roomOf(id)?.name || "";
export const roomFace = (room) => ({ kind: "room", members: (room?.members ?? []).map((m) => E.trunks.find((t) => t.id === m)).filter(Boolean) });
export const defaultTrunk = () => E.trunks.find((trunk) => trunk.id === E.defaultTrunkId);
export const threadTrunk = (id) => E.trunks.find((trunk) => trunk.id === E.sessions.find((session) => session.sessionId === id)?.trunkId);
export const chatFace = (id) => ownTrunkOf(id) ?? (roomOf(id) ? roomFace(roomOf(id)) : threadTrunk(id) ?? defaultTrunk() ?? { kind: "unassigned" });

/* The engine's own ask that has a new Trunk introduce itself carries system: "trunk-intro" (src/trunks/index.ts). A
   conversation saved before that marker has the ask unmarked, so only a message with no marker is matched by its words. */
const OLD_INTRO = "Introduce yourself to the owner in two or three short sentences: your name, your role, and what you can help with. This is the first message of your own conversation.";
export const trunkIntro = (m) => m.role === "user" && (m.system === "trunk-intro" || (!m.system && m.content === OLD_INTRO));
