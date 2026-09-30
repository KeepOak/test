import { z } from "zod";
import type { Trunks } from "./index.js";
import { characters } from "./characters.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { currentPerson } from "../people/context.js";
import { TrunkOffError, TrunkPartSchema, trunkLabels, trunkParts } from "./settings.js";
import { errorText, validationText } from "../request-errors.js";

/**
 * The web side of R17-A: the owner's routes under /api/trunks. They sit behind the same key and host
 * rules as everything else. A short-lived "run" key may only talk to a Trunk and to a room, and stop
 * a room (src/short-lived-keys.ts); every other change is the owner's.
 */
export const handlesTrunksPath = (path: string): boolean => path === "/api/trunks" || path.startsWith("/api/trunks/");

export class TrunksHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface TrunksHttpDeps {
  trunks: Trunks;
  method: string;
  readBody: () => Promise<unknown>;
  person: { id: string; name: string } | null;
  requireOwner: (what: string) => void;
}

const SwitchSchema = z.object({ part: TrunkPartSchema, mode: z.enum(["off", "when-needed", "on"]) }).strict();
const TextSchema = z.object({ text: z.string().trim().min(1).max(16000) }).strict();
/** eng-trunk-controls: resume takes nothing. */
const EmptySchema = z.object({}).strict().nullable().optional();
const trunkPath = /^\/api\/trunks\/([a-f0-9-]{36})(?:\/(remove|say|seen|retire|avatar|export|keys|routines|watch|teach|pause|resume|computers|default|files|secrets|inbox))?$/;
const roomPath = /^\/api\/trunks\/rooms\/([a-f0-9-]{36})(?:\/(remove|send|stop|answer|revoke|artifacts|typing))?$/; // phase2/rooms: revoke; chatlook: typing
const routinePath = /^\/api\/trunks\/routines\/([a-f0-9-]{36})\/remove$/;
/** mac7/residuals (integration): Answer / Not now on a Trunk's message that waits for the owner. */
const messagePath = /^\/api\/trunks\/messages\/([a-f0-9-]{36})\/(answer|decline)$/;
/** phase2/rooms: who answers in a conversation (src/trunks/conversations.ts). */
const conversationPath = /^\/api\/trunks\/conversations(?:\/([a-f0-9-]{36})(?:\/(room))?)?$/;

async function conversationRoute(deps: TrunksHttpDeps, id: string | undefined, action: string | undefined): Promise<unknown> {
  const { trunks } = deps, post = deps.method === "POST";
  if (!post && id && !action && deps.person) {
    const room = trunks.rooms.forPerson(deps.person.id).find((candidate) => candidate.sessionId === id);
    if (!room) {
      deps.requireOwner("Trunk conversations");
      throw new TrunksHttpError(403, "This private room is only for its members");
    }
    return trunks.conversations.sharedRoomInfo(room);
  }
  deps.requireOwner("Trunk conversations");
  trunks.require("trunks");
  if (!id) {
    if (!post) return undefined;
    trunks.require("conversations");
    return trunks.startConversation(await deps.readBody());
  }
  if (!post) return trunks.conversations.info(id);
  if (!action) {
    // Integration review: giving a conversation back to your assistant works with the switch off too,
    // so a Trunk chosen before it was switched off never holds the conversation for good.
    const body = await deps.readBody();
    if ((body as { trunkId?: unknown } | null)?.trunkId !== null) trunks.require("conversations");
    return trunks.conversations.choose(id, body);
  }
  trunks.require("conversations");
  trunks.require("rooms");
  return { room: trunks.conversations.room(id, await deps.readBody()) };
}

/** trunk-rooms-live: what the room said, where working together shows only the one reply (never the plan or a part). */
function said(room: ReturnType<Trunks["rooms"]["get"]>) {
  const together = new Set(room.events.filter((e) => e.kind === "user" && e.rule === "together").map((e) => e.seq));
  return room.events.filter((e) => e.kind === "user" || (e.kind === "member" && (e.final || !together.has(e.discussion ?? -1))));
}
function roomSummary(room: ReturnType<Trunks["rooms"]["get"]>) {
  return { id: room.id, name: room.name, members: room.members, people: room.people, needsYou: room.needsYou, pinned: room.pinned,
    section: room.section, order: room.order, picture: room.picture, sessionId: room.sessionId, rule: room.rule, pattern: room.pattern,
    agents: room.agents, // a2a-rooms
    latest: said(room).at(-1)?.text.slice(0, 160) ?? null,
    at: room.updatedAt };
}

function householdRoomView(view: ReturnType<Trunks["rooms"]["view"]>) {
  const { context: _context, memberSessions: _memberSessions, ...shared } = view;
  return { ...shared, owner: false, waiting: [], allowed: [] };
}

/** Trunk look: `characters` are the ones a Trunk can wear, so every face drawn from this list (a person's rooms too) finds its art. */
function overview(trunks: Trunks, person: TrunksHttpDeps["person"]) {
  const modes = trunks.modes();
  if (person) {
    trunks.require("rooms");
    const home = trunks.personDefault();
    // Each room also names the Trunks in it (as the room itself does for them), so a person's own
    // card can say which Trunks they may reach without seeing the owner's whole list.
    return { modes, labels: [], trunks: home ? [home.trunk] : [], defaultId: home?.trunk.id ?? null, rooms: trunks.rooms.forPerson(person.id)
      .map((room) => ({ ...roomSummary(room), roster: trunks.rooms.roster(room) })), characters: characters() };
  }
  return { modes, labels: trunkParts.map((part) => ({ part, label: trunkLabels[part] })),
    ...(modes.trunks === "off" ? { trunks: [], rooms: [] } : trunks.roster()), characters: characters(),
    defaultId: modes.trunks === "off" ? null : trunks.defaultTrunk()?.id ?? null }; // defaulttrunk
}

async function topRoute(deps: TrunksHttpDeps, path: string): Promise<unknown> {
  const { trunks, method } = deps, post = method === "POST";
  if (path === "/api/trunks" && !post) return overview(trunks, deps.person);
  deps.requireOwner("Trunks");
  if (path === "/api/trunks") return { trunk: trunks.create(await deps.readBody()) };
  if (!post) return undefined;
  if (path === "/api/trunks/switch") {
    const { part, mode } = SwitchSchema.parse(await deps.readBody());
    return { modes: trunks.setMode(part, { mode }) };
  }
  if (path === "/api/trunks/import") return { trunk: trunks.importFile(await deps.readBody()) };
  // eng-trunk-controls: pause every Trunk (a running task finishes unless `now`), or let them all start work again.
  if (path === "/api/trunks/pause-all") return trunks.pause.pauseAll(await deps.readBody());
  if (path === "/api/trunks/resume-all") {
    EmptySchema.parse(await deps.readBody());
    return trunks.pause.resumeAll();
  }
  if (path === "/api/trunks/from-specialist") {
    const { specialistId } = z.object({ specialistId: z.string().uuid() }).strict().parse(await deps.readBody());
    return { trunk: trunks.fromSpecialist(specialistId) };
  }
  if (path === "/api/trunks/rooms") {
    trunks.require("rooms");
    return { room: trunks.rooms.create(await deps.readBody()) };
  }
  const routine = routinePath.exec(path);
  if (routine) return trunks.routines.remove(routine[1]!);
  const message = messagePath.exec(path);
  if (message) return message[2] === "answer" ? { waiting: trunks.messages.answer(message[1]!) } : trunks.messages.decline(message[1]!);
  return undefined;
}

/** Q44: the saved Trunk, and how many messages already waiting will not be sent now that it starts elsewhere. */
function edited(trunks: TrunksHttpDeps["trunks"], id: string, body: unknown) {
  const trunk = trunks.edit(id, body), waiting = trunks.waitingElsewhere(trunk);
  return { trunk, ...(waiting ? { waiting } : {}) };
}

async function trunkRoute(deps: TrunksHttpDeps, id: string, action: string | undefined): Promise<unknown> {
  const personal = deps.person ? deps.trunks.personDefault() : null;
  if (personal?.records.find(id) && action === "files")
    return deps.method === "POST" ? personal.files.edit(id, await deps.readBody()) : personal.files.view(id);
  deps.requireOwner("Trunks");
  const { trunks } = deps, post = deps.method === "POST";
  if (action === "inbox") {
    if (deps.method !== "GET") throw new Error("Use GET to read a Trunk's Inbox");
    return trunks.inbox(id);
  }
  if (!action) return post ? edited(trunks, id, await deps.readBody()) : details(trunks, id);
  if (action === "export") return trunks.exportFile(id);
  if (action === "keys") return trunks.keys(id);
  if (action === "files") return post ? trunks.files.edit(id, await deps.readBody()) : trunks.files.view(id);
  // P17-D §9: the computers it may use and how many tasks at once; reading names the owner's computers, so both are the owner's.
  if (action === "computers") return post ? trunks.computerRule.set(id, await deps.readBody()) : trunks.computerRule.view(id);
  // RES-260: its own secrets, by name only; the owner's alone.
  if (action === "secrets") return post ? trunks.secrets(id).change(await deps.readBody()) : trunks.secrets(id).list();
  if (!post) return undefined;
  switch (action) {
    case "remove": return trunks.remove(id);
    case "say": return trunks.say(id, TextSchema.parse(await deps.readBody()).text);
    case "seen": return trunks.markSeen(id);
    case "retire": return { trunk: trunks.retireChat(id) };
    case "avatar": return { trunk: await trunks.setAvatar(id, await deps.readBody()) };
    case "routines": return { routine: trunks.routines.create(id, await deps.readBody()) };
    case "watch": return trunks.teaching.watch(id);
    case "teach": return trunks.teaching.save(id, await deps.readBody());
    case "pause": return trunks.pause.pause(id, await deps.readBody()); // eng-trunk-controls
    case "resume": EmptySchema.parse(await deps.readBody()); return trunks.pause.resume(id);
    // defaulttrunk: Customize › Trunks › Default. Takes nothing; the Trunk is the one in the address.
    case "default": EmptySchema.parse(await deps.readBody()); return { trunk: trunks.setDefault(id), defaultId: id };
    default: return undefined;
  }
}

function details(trunks: Trunks, id: string) {
  trunks.require("trunks");
  const trunk = trunks.records.get(id);
  return { trunk, routines: trunks.routines.list(id), receipts: trunks.messages.receipts(id).slice(0, 20),
    watching: trunks.teaching.watching(id), keys: trunks.keys(id) };
}

async function roomRoute(deps: TrunksHttpDeps, id: string, action: string | undefined): Promise<unknown> {
  const { trunks } = deps, rooms = trunks.rooms, post = deps.method === "POST";
  trunks.require("rooms");
  rooms.requireAccess(id, deps.person?.id ?? null);
  if (!action && !post) {
    // chatlook: reading it counts as being here, for whoever is at a window: the app's, or a person's own key. A
    // script's short-lived key reads the room without putting anyone in it.
    const atWindow = !startedWithShortLivedKey() || currentPerson() !== null;
    const view = rooms.view(id, atWindow ? { profileId: deps.person?.id ?? null } : undefined);
    return deps.person ? householdRoomView(view) : { ...view, owner: true };
  }
  if (action === "send" && post) return rooms.send(id, await deps.readBody(), deps.person);
  if (action === "artifacts" && post) return { artifact: rooms.addArtifact(id, await deps.readBody(), deps.person) };
  // chatlook: "is typing", for whoever the room admits; who it is comes from who is at the window, never the body.
  if (action === "typing" && post) { EmptySchema.parse(await deps.readBody()); return rooms.typing(id, deps.person?.id ?? null); }
  deps.requireOwner("Changing a private room");
  if (!action) return { room: rooms.edit(id, await deps.readBody()) };
  if (!post) return undefined;
  if (action === "remove") return rooms.remove(id);
  if (action === "stop") return rooms.stop(id);
  if (action === "revoke") return rooms.revoke(id, await deps.readBody()); // phase2/rooms (integration review)
  return { answered: rooms.answer(id, await deps.readBody()) };
}

const notFound = (): never => { throw new TrunksHttpError(404, "There is nothing at that address"); };

/** Answers one request under /api/trunks. */
export async function trunksApi(deps: TrunksHttpDeps, path: string): Promise<unknown> {
  try {
    const conversation = conversationPath.exec(path); // phase2/rooms
    if (conversation) return await conversationRoute(deps, conversation[1], conversation[2]) ?? notFound();
    const room = roomPath.exec(path);
    const trunk = room ? null : trunkPath.exec(path);
    const answer = room ? await roomRoute(deps, room[1]!, room[2])
      : trunk ? await trunkRoute(deps, trunk[1]!, trunk[2])
        : await topRoute(deps, path);
    if (answer === undefined) throw new TrunksHttpError(404, "There is nothing at that address");
    return answer;
  } catch (error) {
    if (error instanceof TrunksHttpError) throw error;
    if (error instanceof TrunkOffError) throw new TrunksHttpError(409, error.message);
    if (error instanceof z.ZodError) throw new TrunksHttpError(400, validationText(error));
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") throw new TrunksHttpError(status, errorText(error));
    throw new TrunksHttpError(400, errorText(error));
  }
}
