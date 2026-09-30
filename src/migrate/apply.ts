import { z } from "zod";
import type { Store } from "../store.js";
import { projectIdFor, splitForMemory } from "./common.js";
import { movedIn, rememberMoved } from "./record.js";
import { clip, sourceNames, contextFileHome, type ContextFileHome, type ContextFileName, type FoundItem, type KeyPrompt, type MovedServer, type MoveInSource, type Payload, type ScanResult } from "./types.js";

/**
 * Bringing the ticked things over into Branch's own stores. Each thing is brought over on its own,
 * so one that Branch refuses (a full memory, a skill name already in use) is reported in a sentence
 * and the rest still come. Anything already in the record is left alone, so pressing the button a
 * second time brings nothing twice.
 */
/**
 * Where a context file's text goes when the loader that owns those files is present. It returns a
 * short description of where the text now lives, or null when the loader does not take it (a
 * memory file that belongs to one of the other assistant's projects); without a loader, or when it
 * declines, the text becomes saved facts.
 */
export type ContextFileSink = (file: {
  name: ContextFileName; home: ContextFileHome; text: string; source: MoveInSource;
  about?: "person" | "world" | "project"; project?: string;
}) => Promise<string | null>;

export interface Receipt {
  brought: { key: string; title: string; kind: string; target: string }[];
  skipped: { key: string; title: string; reason: string }[];
  /** Keys the brought things need that the locker does not hold yet. */
  keys: KeyPrompt[];
}

const serversId = "move-in:servers", settingsId = "move-in:settings";
const ServerEntrySchema = z.object({
  key: z.string(), source: z.string(), name: z.string(), movedAt: z.string(),
  server: z.record(z.string(), z.unknown()),
}).strict();
const ServersSchema = z.object({ servers: z.array(ServerEntrySchema).max(200) }).strict();
export type BroughtServer = z.infer<typeof ServerEntrySchema>;

/** The tool servers brought over, waiting to be tried and added to the connections file. */
export function broughtServers(store: Store, owner: string): BroughtServer[] {
  const saved = ServersSchema.safeParse(store.get("settings", owner, serversId)?.data ?? { servers: [] });
  return saved.success ? saved.data.servers : [];
}

/** Settings brought over, such as the model the owner used before: `{ model: { value, source } }`. */
export function broughtSettings(store: Store, owner: string): Record<string, { value: string; source: string }> {
  const data = store.get("settings", owner, settingsId)?.data ?? {};
  return data as Record<string, { value: string; source: string }>;
}

/**
 * The entry the connections file takes for a server, with an id Branch accepts. The list of tools
 * and the version the server reports are left for the owner to fill in after trying it, because
 * Branch never lets a server's tools in without both.
 */
export function connectionEntry(server: MovedServer): Record<string, unknown> {
  const id = server.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 30).replace(/-+$/, "") || "server";
  const base = { id, tools: [] as string[], expectedVersion: "" };
  if (server.transport === "stdio")
    return { ...base, transport: "stdio", command: server.command, args: server.args,
      ...(server.cwd ? { cwd: server.cwd } : {}), envKeys: server.envKeys };
  return { ...base, transport: "http", url: server.url, ...(server.bearerEnv ? { bearerEnv: server.bearerEnv } : {}) };
}

function memoryRecords(item: FoundItem, source: MoveInSource, payload: Extract<Payload, { kind: "memory" | "instructions" }>) {
  const now = new Date().toISOString(), from = `${sourceNames[source]} (${clip(item.origin, 300)})`;
  const kind = payload.kind === "instructions" ? "preference"
    : payload.about === "project" ? "project-note" : payload.about === "person" ? "fact-about-person" : "fact-about-world";
  const project = payload.kind === "memory" && payload.project ? { project: payload.project } : {};
  return splitForMemory(payload.text).map((text, index) => ({
    id: `moved-${item.key}-${index + 1}`, createdAt: now, updatedAt: now, revision: 1,
    data: { text, kind, layer: "long-term", ...project,
      source: payload.kind === "instructions" ? `Instructions brought over from ${from}` : `Brought over from ${from}` },
  }));
}

async function bringOne(
  store: Store, owner: string, source: MoveInSource, item: FoundItem, contextFiles?: ContextFileSink,
): Promise<string> {
  const payload = await item.load();
  if ((payload.kind === "memory" || payload.kind === "instructions") && payload.contextFile && contextFiles) {
    const target = await contextFiles({ name: payload.contextFile, home: contextFileHome(payload.contextFile), text: payload.text, source,
      ...(payload.kind === "memory" ? { about: payload.about, ...(payload.project ? { project: payload.project } : {}) } : {}) });
    if (target !== null) return target;
  }
  switch (payload.kind) {
    case "chat": {
      const { sessionId } = store.importSession(owner, { format: "branch-agent-conversation", version: 1,
        exportedAt: new Date().toISOString(), messages: payload.messages });
      store.labels.add(owner, { target: "conversation", targetId: sessionId, label: `from ${sourceNames[source]}` });
      return `conversation ${sessionId}`;
    }
    case "project": return bringProject(store, owner, payload);
    case "memory": case "instructions": {
      const records = memoryRecords(item, source, payload);
      store.importMemory(owner, { format: "branch-agent-memory", version: 1, exportedAt: new Date().toISOString(), records });
      return `${records.length} saved fact${records.length === 1 ? "" : "s"}`;
    }
    case "skill": return `skill ${store.skills.install(owner, { document: payload.document }).id}`;
    case "mcp": {
      const servers = broughtServers(store, owner).filter((entry) => entry.key !== item.key);
      servers.push({ key: item.key, source, name: payload.server.name, movedAt: new Date().toISOString(),
        server: { ...payload.server, connection: connectionEntry(payload.server) } });
      store.save("settings", owner, serversId, ServersSchema.parse({ servers }));
      return `tool server ${payload.server.name}, ready to try`;
    }
    case "setting":
      store.save("settings", owner, settingsId, { ...broughtSettings(store, owner),
        [payload.name]: { value: clip(payload.value, 200), source: sourceNames[source] } });
      return `setting ${payload.name}`;
  }
}

function bringProject(store: Store, owner: string, payload: Extract<Payload, { kind: "project" }>): string {
  const id = projectIdFor(payload.folder);
  if (store.projects.list(owner).some((project) => project.id === id)) return `project ${id} (already there)`;
  store.projects.save(owner, { id, name: payload.name });
  return `project ${id}`;
}

export async function bringOver(
  store: Store, owner: string, source: MoveInSource, scan: ScanResult, keys: string[], lockerNames: Set<string>,
  contextFiles?: ContextFileSink,
): Promise<Receipt> {
  const wanted = new Set(keys), record = movedIn(store, owner, source);
  const receipt: Receipt = { brought: [], skipped: [], keys: [] };
  const needed = new Set<string>();
  for (const item of scan.items) {
    if (!wanted.has(item.key)) continue;
    wanted.delete(item.key);
    if (item.key in record) { receipt.skipped.push({ key: item.key, title: item.title, reason: "It was brought over before." }); continue; }
    if (item.blocked) { receipt.skipped.push({ key: item.key, title: item.title, reason: item.detail }); continue; }
    try {
      const target = await bringOne(store, owner, source, item, contextFiles);
      rememberMoved(store, owner, source, [{ key: item.key, kind: item.kind, title: item.title, target,
        ...(item.provenance ? { provenance: item.provenance } : {}) }]);
      receipt.brought.push({ key: item.key, title: item.title, kind: item.kind, target });
      for (const name of item.needsKeys) needed.add(name);
    } catch (error) {
      receipt.skipped.push({ key: item.key, title: item.title, reason: (error as Error).message.slice(0, 300) });
    }
  }
  for (const key of wanted) receipt.skipped.push({ key, title: key, reason: "It is no longer there to bring over." });
  receipt.keys = scan.keys.filter((prompt) => needed.has(prompt.name) && !lockerNames.has(prompt.name));
  return receipt;
}
