import { randomInt } from "node:crypto";
import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import { briefOwnerOnly } from "../key-context.js";
import { ChannelPolicySchema, type ChannelAdapter, type ChannelRouter } from "./router.js";

/**
 * A plugin may bring a chat service of its own. It exports one or more adapters under
 * `plugin.channel.<id>`; each is a factory that, given what the owner typed and a fetch that
 * checks the network settings, hands back something that behaves exactly like a built-in channel.
 * This mirrors how a plugin brings a way of talking to a model: registering one only makes it
 * available to connect, and the owner still has to connect it before anything is attached.
 */
export const channelPluginId = z.string().regex(/^plugin\.channel\.[a-z][a-z0-9-]{0,30}$/,
  "Channel connectors are named plugin.channel.<id>");

export interface ChannelPluginSetup {
  /** What this connection is called here, which is also the channel id people see. */
  id: string;
  /** Whatever the owner typed in, such as an address or a room name. Never a secret. */
  settings: Record<string, string>;
  /** A secret out of the default project's locker, by name. The plugin never sees the others. */
  secret(name: string): Promise<string>;
  /** Refuses an address the owner's network settings do not allow. */
  assertAllowed(url: URL, description: string): Promise<void>;
  /** A fetch that has already checked the address, so a careless plugin still cannot reach out. */
  fetch: typeof fetch;
}
export interface BranchPluginChannel {
  id: string;
  name: string;
  description?: string;
  create(setup: ChannelPluginSetup): ChannelAdapter | Promise<ChannelAdapter>;
}
export interface ChannelConnectorSummary { id: string; name: string; description: string; plugin: string }

export const ConnectChannelSchema = z.object({
  connector: channelPluginId,
  /** The channel id the owner will see, and the one the delivery ledger records. */
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/),
  settings: z.record(z.string().min(1).max(40), z.string().max(500)).default({}),
}).merge(ChannelPolicySchema.partial()).strict();

/**
 * The chat services plugins have brought. Registering one only makes it available to choose;
 * connecting it is a separate step, so a plugin cannot quietly start answering the owner's chats.
 */
export class ChannelConnectors {
  private readonly drivers = new Map<string, { entry: BranchPluginChannel; plugin: string }>();
  /** Which channels each adapter was used to connect, so they go when the plugin does. */
  private readonly connected = new Map<string, string[]>();
  constructor(
    private readonly router: ChannelRouter,
    private readonly guard: { assertAllowed(url: URL, description: string): Promise<void> },
    private readonly secrets: (name: string) => Promise<string>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}
  register(pluginId: string, entry: BranchPluginChannel): ChannelConnectorSummary {
    channelPluginId.parse(String(entry?.id ?? ""));
    if (typeof entry.create !== "function") throw new Error(`The channel ${entry.id} has no create function`);
    if (this.drivers.has(entry.id)) throw new Error(`A channel connector called ${entry.id} is already registered`);
    this.drivers.set(entry.id, { entry, plugin: pluginId });
    return this.describe(entry, pluginId);
  }
  private describe(entry: BranchPluginChannel, plugin: string): ChannelConnectorSummary {
    return { id: entry.id, name: String(entry.name ?? entry.id).slice(0, 80), description: String(entry.description ?? "").slice(0, 300), plugin };
  }
  list(): ChannelConnectorSummary[] {
    return [...this.drivers.values()].map(({ entry, plugin }) => this.describe(entry, plugin));
  }
  /** Connects one, attaches it to the router, and remembers which plugin it came from. */
  async connect(input: unknown): Promise<{ channel: string; connector: string }> {
    const value = ConnectChannelSchema.parse(input);
    const held = this.drivers.get(value.connector);
    if (!held) throw new Error(`No plugin has brought a channel called ${value.connector}`);
    const adapter = await held.entry.create({
      id: value.id, settings: value.settings, secret: this.secrets,
      assertAllowed: (url, description) => this.guard.assertAllowed(url, description),
      fetch: this.guardedFetch(),
    });
    if (!adapter || typeof adapter.send !== "function" || typeof adapter.start !== "function")
      throw new Error(`${value.connector} did not return something that can carry messages`);
    await this.router.attach(adapter, ChannelPolicySchema.parse({
      activation: value.activation ?? "mention", pairing: value.pairing ?? true, allowlist: value.allowlist ?? [],
      ...(value.groupAllowlist !== undefined ? { groupAllowlist: value.groupAllowlist } : {}),
    }));
    const made = this.connected.get(value.connector) ?? [];
    if (!made.includes(value.id)) made.push(value.id);
    this.connected.set(value.connector, made);
    return { channel: value.id, connector: value.connector };
  }
  /** Takes one plugin's connectors back out. Channels it connected are left for the owner to stop. */
  forget(pluginId: string): { connectors: string[]; channels: string[] } {
    const connectors: string[] = [], channels: string[] = [];
    for (const [id, held] of this.drivers) {
      if (held.plugin !== pluginId) continue;
      this.drivers.delete(id);
      connectors.push(id);
      channels.push(...(this.connected.get(id) ?? []));
      this.connected.delete(id);
    }
    return { connectors, channels };
  }
  private guardedFetch(): typeof fetch {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      await this.guard.assertAllowed(url, "a chat service a plugin brought");
      return this.fetchImpl(input as RequestInfo, init);
    };
  }
}

export const BroadcastSchema = z.object({
  text: z.string().min(1).max(4000),
  /** Leave empty to send to every chat that has talked to the assistant. */
  to: z.array(z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64) }).strict()).max(50).default([]),
}).strict();

/** One message to several chats at once, through the same waiting line every reply uses. */
export async function broadcast(router: ChannelRouter, owner: string, input: unknown) {
  const { text, to } = BroadcastSchema.parse(input);
  const targets = to.length ? to : router.chats(owner).map(({ channel, chatId }) => ({ channel, chatId }));
  if (!targets.length) throw new Error("No chats are connected yet, so there is nobody to send this to");
  const key = `broadcast:${Date.now()}:${randomInt(1e9)}`;
  const sent: { channel: string; chatId: string; queued: number }[] = [];
  const failed: { channel: string; chatId: string; error: string }[] = [];
  for (const target of targets) {
    // Quiet hours, chunking and retries all belong to the ledger, so each send inherits them.
    await router.deliver(target.channel, target.chatId, text, `${key}:${target.channel}:${target.chatId}`)
      .then((result) => sent.push({ ...target, queued: result.queued }))
      .catch((error: unknown) => failed.push({ ...target, error: error instanceof Error ? error.message : String(error) }));
  }
  return { sent, failed, chats: targets.length };
}

/** Where the morning brief goes when it is sent over a chat rather than only written down. */
export const DigestSchema = z.object({
  channel: z.string().min(1).max(64),
  chatId: z.string().min(1).max(64),
}).strict();

export interface DigestSource { preview(owner: string): { markdown: string } }

/** Sends the morning brief, as it stands right now, to one chat. */
export async function digest(router: ChannelRouter, brief: DigestSource, owner: string, input: unknown) {
  const { channel, chatId } = DigestSchema.parse(input);
  const { markdown } = brief.preview(owner);
  const result = await router.deliver(channel, chatId, markdown, `digest:${Date.now()}:${randomInt(1e9)}`);
  return { channel, chatId, queued: result.queued, characters: markdown.length };
}

/** Refuses anybody but the owner. The chats belong to them, so nobody else may write to them. */
export interface OwnerCheck { requireOwner(what?: string): void }
const onlyTheOwner = "Sending messages to your chats";

/** The two tools that send on their own rather than answering somebody. */
export function registerChannelTools(registry: ToolRegistry, router: ChannelRouter, brief: DigestSource, people: OwnerCheck): void {
  registry.register({
    name: "channels.broadcast", permission: "channels.send",
    description: "Send one message to several linked chats at once. Leave the list empty to reach every chat that has talked to the assistant.",
    parameters: BroadcastSchema,
    targets: (input: any, context: any) => {
      const to = input.to ?? [];
      const targets = to.length ? to : router.chats(context.owner).map(({ channel, chatId }: any) => ({ channel, chatId }));
      return targets.map(({ channel, chatId }: any) => ({
        kind: "write" as const,
        path: `${channel}:${chatId}`,
      }));
    },
    // The chats are the owner's own. Somebody else sharing this computer under their own profile
    // must not be able to write to them, whether or not they name a chat themselves.
    execute: async (input, context) => { people.requireOwner(onlyTheOwner); return broadcast(router, context.owner, input); },
  });
  registry.register({
    name: "channels.digest", permission: "channels.send",
    description: "Send the morning brief as it stands right now to one chat, whichever chat app it is on.",
    parameters: DigestSchema,
    // The chat it goes to, written as a broadcast writes each of its chats, so the owner's rules about
    // that chat, or its account, hold for the brief sent there as they do for a message.
    targets: (input) => [{ kind: "write", path: `${input.channel}:${input.chatId}` }],
    // Q134: the brief is the owner's, so a Trunk or a delegated specialist is refused it here too.
    execute: async (input, context) => { briefOwnerOnly(context); people.requireOwner(onlyTheOwner); return digest(router, brief, context.owner, input); },
  });
}

