import { z } from "zod";
import type { Store } from "../store.js";
import type { NetworkPolicy } from "../network-policy.js";
import { ChannelPolicySchema, type ChannelAdapter } from "./router.js";
import { connectWebSocket, type WebSocketConnect } from "./ws-client.js";
import { openSocket, type ParityDeps, type ParityService } from "./parity-common.js";
import { paritySwitch, SwitchedChannel } from "./parity-switch.js";
import { PARITY_KINDS } from "./parity-kinds.js";

/* The services themselves are loaded on first use (parity-services.ts): an engine with none connected never holds them. */
const services = async (): Promise<ParityService[]> => (await import("./parity-services.js")).parityServices;
import { channelMark, type ChannelMark } from "./catch-up.js"; // mac6/bucket-16

/**
 * How the chat services added in wave mac3 are written in the connections file and built. The
 * launcher (src/integrations/bootstrap.ts) knows only two things about them: the shape below, which
 * joins its list of channel shapes, and `buildParityChannel`, which it calls for any of them.
 *
 * Each service checks the rest of what the owner wrote with its own strict shape, so a mistyped
 * setting is refused by name when Branch starts rather than ignored.
 */
export function parityKinds(): [string, ...string[]] {
  return [...PARITY_KINDS] as [string, ...string[]];
}
export async function parityService(kind: string): Promise<ParityService | undefined> {
  return (await services()).find((service) => service.kind === kind);
}

const channelId = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/);
export const ParityChannelSchema = z.object({
  id: channelId,
  type: z.enum(parityKinds()),
}).merge(ChannelPolicySchema).catchall(z.unknown());
export type ParityChannelConfig = z.infer<typeof ParityChannelSchema>;

export function isParityChannel(value: { type: string }): boolean {
  return (PARITY_KINDS as readonly string[]).includes(value.type);
}

export interface ParityHost {
  /** An environment variable or a secret in the default project's locker, by name. */
  credential(name: string): Promise<string>;
  policy?: NetworkPolicy | undefined;
  store?: unknown;
  owner?: string | undefined;
  platform?: NodeJS.Platform;
  /** Tests hand in their own sockets; a real launch uses the operating system's. */
  openSocket?: ParityDeps["openSocket"];
  connectWs?: WebSocketConnect;
}

/** The settings the owner wrote, without the fields every channel shares. */
function ownSettings(config: ParityChannelConfig): Record<string, unknown> {
  const { id: _id, type: _type, activation: _a, pairing: _p, allowlist: _l, ...rest } = config;
  return rest;
}

/** Builds one service's channel and puts it behind the owner's switch for that service. */
export async function buildParityChannel(config: ParityChannelConfig, host: ParityHost): Promise<ChannelAdapter> {
  const service = await parityService(config.type);
  if (!service) throw new Error(`There is no chat service called ${config.type}`);
  const platform = host.platform ?? process.platform;
  if (service.platforms && !service.platforms.includes(platform))
    throw new Error(`${service.name} can only be reached from ${service.platforms.map(platformName).join(" or ")}`);
  const settings = service.settings.parse(ownSettings(config));
  const policy = host.policy;
  const connect = host.connectWs ?? connectWebSocket;
  const deps: ParityDeps = {
    id: config.id, platform,
    secret: (name) => host.credential(name),
    fetch: policy ? policy.guard(globalThis.fetch) : globalThis.fetch,
    assertAllowed: async (url, what) => { await policy?.assertAllowed(url, what); },
    connectWs: async (address, options) => {
      await policy?.assertAllowed(new URL(address.replace(/^ws/, "http")), "chat service address");
      return connect(address, options);
    },
    openSocket: host.openSocket ?? openSocket,
  };
  const inner = await service.build(settings, deps);
  const store = host.store as Store | undefined;
  const owner = host.owner;
  // mac6/bucket-16: services that can carry on from a saved place are handed one.
  const mark = store && owner ? channelMark(store, config.id, owner) : undefined;
  if (mark && "catchUp" in inner) (inner as { catchUp: ChannelMark | null }).catchUp = mark;
  // Without somewhere to read the switch from, the service stays off, which is how it ships.
  const read = () => (store && owner ? paritySwitch(store, owner, service.kind) : "off" as const);
  return new SwitchedChannel(inner, { read });
}

function platformName(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "a Mac" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
}

/** What the setup card lists: every service, its switch, and what to write to connect it. */
export async function paritySummary(store: Store, owner: string, platform: NodeJS.Platform = process.platform) {
  return (await services()).map((service) => ({
    kind: service.kind, name: service.name, docs: service.docs, needs: service.needs,
    receives: service.receives, switch: paritySwitch(store, owner, service.kind),
    available: !service.platforms || service.platforms.includes(platform),
    settings: settingNames(service.settings),
  }));
}
/** The names of the settings a service takes, for the example on the card. */
function settingNames(schema: z.ZodType): string[] {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}
