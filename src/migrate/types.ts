import { createHash } from "node:crypto";
import { z } from "zod";

/** The assistants Branch can bring things over from. */
export const moveInSources = ["claude-code", "codex", "hermes", "openclaw", "opencode", "chatgpt"] as const;
export const MoveInSourceSchema = z.enum(moveInSources);
export type MoveInSource = z.infer<typeof MoveInSourceSchema>;
export const sourceNames: Record<MoveInSource, string> = {
  "claude-code": "Claude Code", codex: "Codex CLI", hermes: "Hermes Agent", openclaw: "OpenClaw", opencode: "OpenCode", chatgpt: "ChatGPT",
};

/** What one thing found is, in the order the preview shows them. */
export const itemKinds = ["chat", "project", "memory", "instructions", "skill", "mcp", "setting"] as const;
export type ItemKind = (typeof itemKinds)[number];
export const kindNames: Record<ItemKind, string> = {
  chat: "Chats", project: "Projects", memory: "Memory", instructions: "Instructions",
  skill: "Skills", mcp: "Tool servers (MCP)", setting: "Settings",
};

/** A chat message as Branch keeps it after moving in: plain words only, never hidden reasoning. */
export interface MovedMessage { role: "user" | "assistant"; content: string }

/**
 * The context files Branch's own loader owns. When one of these comes over, its text is handed to
 * that loader rather than kept somewhere of this feature's own.
 */
export const contextFileNames = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "SOUL.md", "USER.md", "IDENTITY.md",
  "MEMORY.md", "HEARTBEAT.md", "TOOLS.md", "SOP.md"] as const;
export type ContextFileName = (typeof contextFileNames)[number];
/**
 * Which part of Branch owns each context file once it has come over: the assistant's own identity
 * (settings), the project it belongs to, or the memory library.
 */
export type ContextFileHome = "settings:assistant" | "project" | "library:memory";
export function contextFileHome(name: ContextFileName): ContextFileHome {
  if (name === "SOUL.md" || name === "IDENTITY.md" || name === "USER.md") return "settings:assistant";
  return name === "MEMORY.md" ? "library:memory" : "project";
}
export function contextFileOf(origin: string): ContextFileName | undefined {
  const name = origin.split(/[/:#]/).pop() ?? "";
  const plain = name === "AGENTS.override.md" ? "AGENTS.md" : name;
  return (contextFileNames as readonly string[]).includes(plain) ? plain as ContextFileName : undefined;
}

/**
 * What each kind carries into Branch. Readers fill these in; nothing here has touched Branch yet.
 * Secret values are never held: a server or setting that needs one names it in `needsKeys` instead.
 */
export type Payload =
  | { kind: "chat"; messages: MovedMessage[]; folder: string }
  | { kind: "project"; name: string; folder: string }
  | { kind: "memory"; text: string; about: "person" | "world" | "project"; project?: string; contextFile?: ContextFileName }
  | { kind: "instructions"; text: string; contextFile?: ContextFileName }
  | { kind: "skill"; document: string }
  | { kind: "mcp"; server: MovedServer }
  | { kind: "setting"; name: string; value: string };

export type MovedServer =
  | { transport: "stdio"; name: string; command: string; args: string[]; cwd?: string; envKeys: string[] }
  | { transport: "http"; name: string; url: string; bearerEnv?: string; envKeys: string[] };

export const ChatProvenanceSchema = z.object({
  conversationId: z.string().min(1).max(200), leafId: z.string().min(1).max(200),
  nodePath: z.array(z.string().min(1).max(200)).min(1).max(1000),
  current: z.boolean(), omittedParts: z.number().int().nonnegative(),
}).strict();
export type ChatProvenance = z.infer<typeof ChatProvenanceSchema>;

export interface FoundItem {
  /** Source graph identity, not instructions or a claim about who wrote its content. */
  provenance?: ChatProvenance;
  /** Stable across scans of the same source, so the record can say it was already brought over. */
  key: string;
  kind: ItemKind;
  title: string;
  /** One plain sentence: how big it is, where it came from, or why it cannot come. */
  detail: string;
  /** Where in the other assistant's folder it was found, relative to the top. */
  origin: string;
  /** Reads what it carries. A chat is read again only when it is really brought over. */
  load(): Promise<Payload>;
  /** Shown, but cannot be brought over; `detail` says why. */
  blocked: boolean;
  /** Secret names this needs before it will work in Branch. */
  needsKeys: string[];
}

/** A key the other assistant held that Branch will not copy: the owner adds it to the locker. */
export interface KeyPrompt { name: string; why: string }

export interface ScanResult {
  items: FoundItem[]; keys: KeyPrompt[]; notes: string[];
  /** Lets go of anything the scan still holds open, such as a private copy of a database. */
  close?: () => Promise<void>;
}

/** The same thing from the same source always gets the same key. */
export function itemKey(source: MoveInSource, kind: ItemKind, origin: string): string {
  return createHash("sha256").update(`${source}\n${kind}\n${origin}`).digest("hex").slice(0, 32);
}

/** Environment-style names are the only form a secret prompt takes, so the locker accepts them. */
export const lockerName = (name: string): string | null => {
  const upper = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(upper) ? upper : null;
};

/** Names that are about credentials, which Branch never reads the value of. */
export const secretLike = (name: string): boolean =>
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i.test(name);

/** Shortens text for a preview line without cutting a word in half where it can help it. */
export function clip(text: string, length = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= length) return flat;
  const cut = flat.slice(0, length - 1), space = cut.lastIndexOf(" ");
  return (space > length / 2 ? cut.slice(0, space) : cut) + "…";
}
