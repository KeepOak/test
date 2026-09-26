import { randomUUID } from "node:crypto";
import { z } from "zod";
import { optionalFields } from "../feature-switches.js";
import { reasoningEfforts } from "../models.js";
import { SpecialistStyleSchema } from "../specialist-styles.js";
import type { Store } from "../store.js";
import { AvatarSchema, settleAvatar } from "./avatar.js";
import { characters } from "./characters.js";
import { TrunkLookSchema } from "./look.js"; // phase2/shell
import { StartsInSchema } from "./starts-in.js"; // Q44

/** The painted characters a Trunk can wear (the window's Look tab), by id, read from the art Branch ships (./characters.ts). */
export const trunkCharacters: readonly string[] = characters().map((character) => character.id);
/** The eyes its pebble face is drawn with (the prototype's Round, Wide and Sleepy). */
export const trunkEyes = ["round", "wide", "sleepy"] as const;

/**
 * R17-001 (T-01): the Trunk record. A Trunk is a named, long-lived agent that belongs to the owner.
 * It is not a household person (src/people/, src/profiles.ts) and not a specialist (a reusable set
 * of instructions in src/knowledge.ts), though a specialist can be brought across as a Trunk.
 *
 * Trunks are kept in the `governance` table under `trunk:<id>`, beside teams, so no new table is
 * needed. Every reach a Trunk has beyond talking starts off (T-15): no chat apps, no commands, no
 * connected tool servers.
 */
export const TrunkCreateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  title: z.string().trim().max(80).default(""),
  description: z.string().trim().max(1000).default(""),
}).strict();

export const TrunkSchema = TrunkCreateSchema.extend({
  avatar: AvatarSchema.optional(),
  /** phase2/shell: its colour, face, shape and movement (src/trunks/look.ts); absent looks as it always did. */
  look: TrunkLookSchema.optional(),
  /**
   * Q44: the computer it starts in, by its id in the device book; null or absent means this computer.
   * Optional so a record saved before it existed reads as it always did, and an older build, which
   * only picks the fields it knows, carries it over untouched (src/trunks/starts-in.ts).
   */
  startsIn: StartsInSchema.optional(),
  /**
   * DG-105: a colour the owner picked as a value (the sample's palette, or any colour), in lower case. It is
   * drawn only while `look.colour` is null, so a colour chosen later, even by a build from before this field
   * (which keeps the field it does not know and writes `look.colour`), always wins. Kept outside `look`, whose
   * record older builds check strictly.
   */
  chosenColour: z.string().regex(/^#[0-9a-f]{6}$/i, "Choose a colour such as #1f5139").transform((value) => value.toLowerCase()).nullable().optional(),
  /**
   * Pass 17: the painted character it wears in place of the pebble (a still and loops the window draws from the
   * catalogue in ./characters.ts, GET /api/trunks `characters`), or null for the classic pebble. Kept outside `look`
   * for the same reason as `chosenColour`.
   */
  character: z.string().refine((id) => trunkCharacters.includes(id), "Branch draws no character by that name").nullable().optional(),
  /** The eyes its pebble face is drawn with; null or absent is round. Kept outside `look` for the same reason. */
  eyes: z.enum(trunkEyes).nullable().optional(),
  /** The model preset it answers with; empty follows the conversation, then the owner's default. */
  model: z.string().trim().max(64).default(""),
  reasoning: z.enum(reasoningEfforts).nullable().default(null),
  /** Its own character and working instructions (its SOUL), given as text. */
  instructions: z.string().max(8000).default(""),
  /** The voice it reads its answers in; empty uses the owner's own voice setting. */
  voice: z.string().trim().max(80).default(""),
  style: SpecialistStyleSchema.default("default"),
  /** Tool permissions it may use; empty means the owner's ordinary set, less anything its reach keeps off. */
  permissions: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  /** Skills it should reach for first. */
  skills: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  /** Connected tool servers (MCP) it may use, by their id. None by default. */
  mcpServers: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  /** Whether it also reads the facts the owner marked as shared; what it learns itself is always its own. */
  sharedFacts: z.boolean().default(true),
  /** R17-005: keys copied from the owner by default; sign-in accounts are never copied. */
  keys: z.object({
    copyFromOwner: z.boolean().default(true),
    /** Which account of each connection it uses, by connection id. */
    accounts: z.record(z.string().max(64), z.string().max(64)).default({}),
  }).strict().default({ copyFromOwner: true, accounts: {} }),
  /** R17-013 (T-15): what it may reach. Every part starts off. */
  reach: z.object({
    channels: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
    commands: z.boolean().default(false),
  }).strict().default({ channels: [], commands: false }),
  hidden: z.boolean().default(false),
  section: z.string().trim().max(40).default(""),
  pinned: z.boolean().default(false),
  order: z.number().int().min(0).max(10000).default(0),
}).strict();
export const TrunkEditSchema = optionalFields(TrunkSchema);
export type TrunkFields = z.infer<typeof TrunkSchema>;

export interface Trunk extends TrunkFields {
  id: string;
  /** The @name it answers to; unique among the owner's Trunks. */
  handle: string;
  /** Its permanent, pinned conversation (T-03). */
  chatSessionId: string;
  /** Earlier chats, newest first, kept in history after the owner retired them. */
  retiredChats: string[];
  /** Workflows it was taught by being shown (T-13). */
  taught: { workflowId: string; name: string; runId: string }[];
  /** The specialist it was brought across from, when it was. */
  fromSpecialist?: string;
  /**
   * eng-trunk-controls: paused by the owner. A paused Trunk starts nothing new (src/trunks/pause.ts).
   * Kept off TrunkSchema so only the pause and resume routes change it, never the generic edit.
   */
  paused?: boolean;
  pausedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Words that already mean someone in a room, so no Trunk may take them as its @name. */
export const reservedHandles = new Set(["you", "owner", "user", "all", "everyone", "branch", "trunk", "here"]);

export function slug(name: string): string {
  const base = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return base || "trunk";
}

/** A Trunk saved before a field existed reads with that field's default: a Trunk from before voices has none (""). */
function settled(data: unknown): Trunk {
  const trunk = data as Trunk;
  return typeof trunk.voice === "string" ? trunk : { ...trunk, voice: "" };
}

export class TrunkRecords {
  constructor(private readonly store: Store, private readonly owner: string) {}

  list(): Trunk[] {
    return this.store.list("governance", this.owner).filter((r) => r.id.startsWith("trunk:"))
      .map((r) => settled(r.data))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order || a.name.localeCompare(b.name));
  }
  find(id: string): Trunk | undefined {
    const data = this.store.get("governance", this.owner, `trunk:${id}`)?.data;
    return data ? settled(data) : undefined;
  }
  get(id: string): Trunk {
    const trunk = this.find(id);
    if (!trunk) throw Object.assign(new Error("There is no Trunk with that id"), { status: 404 });
    return trunk;
  }
  /** A Trunk by its @name, its name or its title; a name two Trunks share is refused rather than guessed. */
  resolve(target: string): Trunk {
    const wanted = target.trim().replace(/^@/, "").toLowerCase();
    const all = this.list();
    const byHandle = all.find((t) => t.handle === wanted);
    if (byHandle) return byHandle;
    const named = all.filter((t) => t.name.toLowerCase() === wanted || slug(t.name) === wanted || (t.title && t.title.toLowerCase() === wanted));
    if (named.length === 1) return named[0]!;
    const roster = all.map((t) => `@${t.handle}`).join(", ") || "none yet";
    if (named.length > 1) throw new Error(`More than one Trunk is called "${target}". Use its @name: ${roster}`);
    throw new Error(`No Trunk is called "${target}". The Trunks are: ${roster}`);
  }
  put(trunk: Trunk): Trunk {
    this.store.save("governance", this.owner, `trunk:${trunk.id}`, { ...trunk });
    return trunk;
  }
  remove(id: string): boolean {
    return this.store.delete("governance", this.owner, `trunk:${id}`);
  }
  /** A new Trunk with its fields settled, its @name chosen and the chat it will live in. */
  build(fields: TrunkFields, chatSessionId: string, extra: Partial<Trunk> = {}): Trunk {
    const now = new Date().toISOString();
    return {
      ...fields, avatar: settleAvatar(fields.avatar, fields.name), id: randomUUID(), handle: this.freeHandle(fields.name),
      chatSessionId, retiredChats: [], taught: [], createdAt: now, updatedAt: now, ...extra,
    };
  }
  /** The saved Trunk with the owner's changes laid over it. The @name follows a rename. */
  edit(id: string, input: unknown): Trunk {
    const current = this.get(id);
    const change = TrunkEditSchema.parse(input) as Partial<TrunkFields>;
    const fields = TrunkSchema.parse({ ...pick(current), ...change });
    const renamed = fields.name !== current.name;
    return this.put({ ...current, ...fields, avatar: settleAvatar(fields.avatar, fields.name),
      handle: renamed ? this.freeHandle(fields.name, id) : current.handle, updatedAt: new Date().toISOString() });
  }
  private freeHandle(name: string, self?: string): string {
    const taken = new Set(this.list().filter((t) => t.id !== self).map((t) => t.handle));
    const base = slug(name);
    for (let n = 1; n < 1000; n++) {
      const handle = n === 1 ? base : `${base}-${n}`;
      if (!taken.has(handle) && !reservedHandles.has(handle)) return handle;
    }
    throw new Error("Too many Trunks share that name");
  }
}

/** Only the owner-editable fields of a saved Trunk. */
export function pick(trunk: Trunk): TrunkFields {
  const keys = Object.keys(TrunkSchema.shape) as (keyof TrunkFields)[];
  return Object.fromEntries(keys.filter((key) => trunk[key] !== undefined).map((key) => [key, trunk[key]])) as unknown as TrunkFields;
}
