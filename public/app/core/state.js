/* Two kinds of state. S is the window's own (what is open, what is typed); E is what the engine said (loaded, never
   invented). Only the few window choices worth keeping between visits are saved, in this browser. */

import { api } from "./api.js";
import { readSessionPages, resetSessionPages, sessionPrincipal } from "./session-pages.js";
import { render } from "./dom.js";
import { t } from "../../i18n.js";

const SAVED_KEY = "branch-window";
const SAVED = ["level", "placesShut", "theme", "sideW", "paneW", "dockW", "rail", "sideHidden", "home19", "panes19", "simple", "simpleFrom", "advLevel"];

export const S = {
  view: "chat",
  chat: null,
  tabs: { inbox: "needs", automations: "scheduled", library: "memory", customize: "trunks" },
  setPage: "general",
  level: "regular",
  simple: false, // RES-704: Simple on (shell/simple.js), what it put away, and the last Advanced or Technical level
  simpleFrom: null,
  advLevel: null,
  drafts: {},
  placesShut: false,
  theme: null,
  sideW: null,
  paneW: null,
  dockW: null,
  rail: false,
  sideHidden: false,
  panes19: null, // RES-703: the panes beside the open conversation, their widths and the active one (chat/panes.js)
  home19: { open: false, sid: null }, // RES-701: the Home panel open or not, and its own conversation (shell/home.js)
  signedIn: true,
};

export const E = {
  state: null,
  stateReadAt: 0,
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
let refreshGeneration = 0;
export async function refresh() {
  const mine = ++refreshGeneration;
  /* One request first: until the engine accepts the window, every refused request counts against sign-in. */
  const state = await api("state");
  const stateReadAt = Date.now();
  if (mine !== refreshGeneration) return;
  const [trunks, profiles] = await Promise.all([
    api("trunks").catch(() => null),
    api("profiles").catch(() => null),
  ]);
  if (mine !== refreshGeneration) return;
  if (resetSessionPages(profiles ?? E.profiles)) E.sessions = [];
  /* A read that failed keeps what the window last had. Emptied, one refused or dropped GET /api/trunks lost every Trunk
     and the modes: "@Ada …" then found no Ada and went out as an ordinary message in a new conversation (trunks-ui on
     CI), and the side list lost its Trunks and conversations until the next read. */
  if (profiles) E.profiles = profiles;
  E.state = state;
  E.stateReadAt = stateReadAt;
  if (trunks) {
    E.trunks = trunks.trunks ?? (Array.isArray(trunks) ? trunks : []);
    E.trunksRead = true; // pass 18: an empty Trunks list is a welcome only when the engine answered
    E.trunkModes = trunks.modes ?? {};
    E.defaultTrunkId = trunks.defaultId ?? null; // the default Trunk answers every chat nobody routed elsewhere
    E.rooms = Array.isArray(trunks.rooms) ? trunks.rooms : [];
    if (Array.isArray(trunks.characters)) E.characters = trunks.characters; // the characters a Trunk can wear (core/art17.js)
  }
  const who = sessionPrincipal(E.profiles);
  const stillHere = () => mine === refreshGeneration && sessionPrincipal(E.profiles) === who && S.signedIn
    && !document.getElementById("app")?.classList.contains("locked-b17");
  const sessions = await readSessionPages(E.profiles, stillHere);
  if (!stillHere()) return;
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
export const level = () => LEVELS[S.level] ?? 0;

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
