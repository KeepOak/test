/* Two kinds of state. S is the window's own (what is open, what is typed); E is what the engine said (loaded, never
   invented). Only the few window choices worth keeping between visits are saved, in this browser. */

import { api } from "./api.js";
import { render } from "./dom.js";
import { t } from "../../i18n.js";

const SAVED_KEY = "branch-window";
const SAVED = ["level", "placesShut", "theme", "sideW", "paneW", "dockW", "rail", "sideHidden"];

export const S = {
  view: "chat",
  chat: null,
  tabs: { inbox: "needs", automations: "scheduled", library: "memory", customize: "trunks" },
  setPage: "general",
  level: "regular",
  drafts: {},
  placesShut: false,
  theme: null,
  sideW: null,
  paneW: null,
  dockW: null,
  rail: false,
  sideHidden: false,
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

export function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || "{}");
    for (const key of SAVED) if (key in saved) S[key] = saved[key];
  } catch { /* a broken save is ignored */ }
}
export function save() {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(Object.fromEntries(SAVED.map((k) => [k, S[k]])))); } catch { /* storage refused */ }
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
  E.profiles = profiles;
  E.state = state;
  E.trunks = trunks?.trunks ?? (Array.isArray(trunks) ? trunks : []);
  E.trunkModes = trunks?.modes ?? {};
  E.rooms = Array.isArray(trunks?.rooms) ? trunks.rooms : [];
  if (Array.isArray(trunks?.characters)) E.characters = trunks.characters; // the characters a Trunk can wear (core/art17.js)
  E.sessions = sessions?.sessions ?? [];
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
export const personHere = () => E.profiles?.active?.name || roleLabel("owner");
/* Whether the one at the window is the owner, as the engine says (GET /api/profiles isOwner). Owner-only controls are drawn
   only then: not while the answer is missing, and never for a household person (they are not theirs to use, not "coming soon"). */
export const ownerHere = () => E.profiles?.isOwner === true;

/* The level control: Regular 0, Advanced 1, Technical 2. */
export const LEVELS = { regular: 0, advanced: 1, technical: 2 };
export const level = () => LEVELS[S.level] ?? 0;

/* A conversation that is a Trunk's own (or one it retired) or a room's is named and drawn for it, as the prototype's
   rowHtml and av(c) do: the Trunk's face, or a room's stack of two member faces (GET /api/trunks rooms[].members). */
const ownTrunkOf = (id) => (id ? E.trunks.find((t) => t.chatSessionId === id || (t.retiredChats ?? []).includes(id)) : undefined);
const roomOf = (id) => (id ? E.rooms.find((r) => r.sessionId === id) : undefined);
export const ownName = (id) => ownTrunkOf(id)?.name || roomOf(id)?.name || "";
export const roomFace = (room) => ({ kind: "room", members: (room?.members ?? []).map((m) => E.trunks.find((t) => t.id === m)).filter(Boolean) });
export const chatFace = (id) => ownTrunkOf(id) ?? (roomOf(id) ? roomFace(roomOf(id)) : { kind: "main" });

/* The engine's own ask that has a new Trunk introduce itself carries system: "trunk-intro" (src/trunks/index.ts). A
   conversation saved before that marker has the ask unmarked, so only a message with no marker is matched by its words. */
const OLD_INTRO = "Introduce yourself to the owner in two or three short sentences: your name, your role, and what you can help with. This is the first message of your own conversation.";
export const trunkIntro = (m) => m.role === "user" && (m.system === "trunk-intro" || (!m.system && m.content === OLD_INTRO));
