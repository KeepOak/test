import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { reconnectDelay } from "../../channels/ws-client.js";
import { capabilities, CapabilitySchema, mediaLimitBytes, type Capability, type DevicePlatform } from "../capabilities.js";
import { helloText, keyCheck, mediaFrame, pairText, protocolVersion, WindowLimit } from "../protocol.js";
import type { Notice, NodeActions } from "./actions.js";
import { checkHubAddress, dialNode, RefusedError, type DialNode, type NodeSocket } from "./socket.js";
export { checkHubAddress };

/**
 * mac7/nodes: `branch node` — this computer lending a few switched-on abilities to the owner's
 * Branch on another computer. It keeps one small file: its own key (made here and never sent),
 * the Branch address, and the id Branch gave it.
 */
const IdentitySchema = z.object({
  privateKey: z.string().min(40),
  publicKey: z.string().min(40),
  hub: z.string().url().nullable().default(null),
  name: z.string().max(80).default("This computer"),
  requestId: z.string().nullable().default(null),
  deviceId: z.string().nullable().default(null),
  /** Capabilities this computer refuses whatever Branch says; a local rule that can only tighten. */
  never: z.array(CapabilitySchema).max(20).default([]),
}).strict();
export type NodeIdentity = z.infer<typeof IdentitySchema>;
const file = (dir: string): string => join(dir, "identity.json");

export async function loadIdentity(dir: string): Promise<NodeIdentity> {
  const saved = IdentitySchema.safeParse(JSON.parse(await readFile(file(dir), "utf8").catch(() => "{}")));
  if (saved.success) return saved.data;
  const pair = generateKeyPairSync("ed25519");
  const identity = IdentitySchema.parse({
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  });
  await saveIdentity(dir, identity);
  return identity;
}
export async function saveIdentity(dir: string, identity: NodeIdentity): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file(dir)}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(identity, null, 2), { mode: 0o600 });
  await rename(temporary, file(dir));
  await chmod(file(dir), 0o600).catch(() => undefined);
}
export const signWith = (identity: NodeIdentity, text: string): string =>
  sign(null, Buffer.from(text, "utf8"), createPrivateKey(identity.privateKey)).toString("base64");

/** A pairing link from the Devices card: the Branch address and the invitation id. */
export function parsePairLink(link: string): { hub: string; offer: string } {
  const url = new URL(link);
  const offer = url.searchParams.get("offer") ?? "";
  if (!/^[a-f0-9]{32}$/.test(offer) || !/^https?:$/.test(url.protocol)) throw new Error("That is not a pairing link from Branch's Devices card.");
  checkHubAddress(url.origin);
  return { hub: url.origin, offer };
}

export interface PairOptions {
  platform: DevicePlatform; offers: Capability[]; name?: string;
  fetch?: typeof fetch; intervalMs?: number; timeoutMs?: number; log?: (line: string) => void;
  /** phase2/shell integration review: stops waiting for the yes (the window's Stop or Leave). */
  signal?: AbortSignal;
}
export const pairingStopped = "Pairing was stopped on this computer.";
async function post(fetcher: typeof fetch, url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(answer.error ?? `Branch answered ${response.status}`));
  return answer;
}

/** Answers an invitation, then waits for the owner's yes on the other computer. */
export async function pairNode(dir: string, link: string, code: string, options: PairOptions): Promise<NodeIdentity> {
  const fetcher = options.fetch ?? fetch;
  const { hub, offer } = parsePairLink(link);
  let identity = await loadIdentity(dir);
  if (options.signal?.aborted) throw new Error(pairingStopped);
  const name = options.name ?? identity.name;
  const sent = await post(fetcher, `${hub}/api/devices/pair`, { offer, code, name, platform: options.platform, publicKey: identity.publicKey, offers: options.offers });
  identity = { ...identity, hub, name, requestId: String(sent.requestId), deviceId: null };
  await saveIdentity(dir, identity);
  options.log?.("Waiting for the owner to let this computer in, on the computer running Branch (Customize, Channels, Devices).");
  options.log?.(`Check code: ${keyCheck(identity.publicKey)}. The same code shows beside the request there; if it differs, it should be refused.`);
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error(pairingStopped);
    const status = await post(fetcher, `${hub}/api/devices/pair/status`,
      { requestId: identity.requestId, signature: signWith(identity, pairText(identity.requestId!, "status")) });
    if (options.signal?.aborted) throw new Error(pairingStopped);
    if (status.status === "approved" && typeof status.deviceId === "string") {
      identity = { ...identity, deviceId: status.deviceId, requestId: null };
      await saveIdentity(dir, identity);
      return identity;
    }
    if (status.status === "refused") throw new Error("The owner refused this computer.");
    await sleep(options.intervalMs ?? 3000, undefined, options.signal ? { signal: options.signal } : undefined).catch(() => undefined);
  }
  throw new Error("Nobody answered in time. Make a new invitation and try again.");
}

export interface NodeClientOptions {
  identity: NodeIdentity; platform: DevicePlatform; actions: NodeActions;
  dial?: DialNode; log?: (line: string) => void;
  /** How long a connection may stay completely silent before it is treated as dropped. */
  silenceMs?: number; backoffBase?: number; now?: () => number;
}
type Outcome = "revoked" | "proven" | "failed";

export class NodeClient {
  private enabled = new Set<Capability>();
  private folder: string | null = null;
  private offers: Capability[] = [];
  private readonly seen = new Set<string>();
  private readonly limit = new WindowLimit(60, 60_000);
  /** computer-control: the owner's clicks and keys from Branch's view have their own budget. */
  private readonly inputs = new WindowLimit(120, 60_000);
  /** computer-control: the owner's hold on this computer, with the notice showing it; input is refused without it. */
  private hold: { owner: string; notice: Notice } | null = null;
  constructor(private readonly options: NodeClientOptions) {}

  /** What is switched on here right now: Branch's switches, less anything this computer refuses. */
  switchedOn(): Capability[] { return capabilities.filter((c) => this.enabled.has(c)); }

  /** Keeps a connection to Branch open until stopped or taken off the list, dialling again when it drops. */
  async run(signal: AbortSignal): Promise<"revoked" | "stopped"> {
    const { identity } = this.options;
    if (!identity.hub || !identity.deviceId) throw new Error("This computer is not paired yet. Run: branch node pair <link> <number>");
    this.offers = (await this.options.actions.available()).filter((c) => !identity.never.includes(c));
    let attempt = 0;
    while (!signal.aborted) {
      const outcome = await this.once(signal).catch((error: unknown) => {
        this.options.log?.(error instanceof RefusedError ? `${error.message} Trying again shortly.` : `Could not reach Branch: ${String((error as Error).message ?? error)}`);
        return "failed" as Outcome;
      });
      if (outcome === "revoked") return "revoked";
      attempt = outcome === "proven" ? 1 : attempt + 1;
      await sleep(reconnectDelay(attempt, this.options.backoffBase ?? 1000), undefined, { signal }).catch(() => undefined);
    }
    return "stopped";
  }

  private async once(signal: AbortSignal): Promise<Outcome> {
    const { identity } = this.options;
    const state = { proven: false, revoked: false, lastActivity: Date.now() };
    let socket: NodeSocket | null = null;
    socket = await (this.options.dial ?? dialNode)(identity.hub!, identity.deviceId!, {
      onActivity: () => { state.lastActivity = Date.now(); },
      onText: (text) => this.onText(socket!, state, text),
    });
    const silence = this.options.silenceMs ?? 90_000;
    const watch = setInterval(() => { if (Date.now() - state.lastActivity > silence) socket!.close(); }, Math.min(silence, 5000));
    const stop = (): void => socket!.close();
    signal.addEventListener("abort", stop, { once: true });
    await socket.closed;
    clearInterval(watch);
    signal.removeEventListener("abort", stop);
    this.enabled.clear();
    this.letGo("Branch is out of reach.");
    if (state.revoked) return "revoked";
    return state.proven ? "proven" : "failed";
  }

  private onText(socket: NodeSocket, state: { proven: boolean; revoked: boolean }, text: string): void {
    const frame = JSON.parse(text) as Record<string, unknown>;
    const { identity } = this.options;
    if (frame.type === "challenge" && typeof frame.nonce === "string") {
      socket.text({ type: "hello", version: protocolVersion, deviceId: identity.deviceId, platform: this.options.platform,
        signature: signWith(identity, helloText(identity.deviceId!, frame.nonce)), offers: this.offers });
    } else if (frame.type === "welcome" || frame.type === "enabled") {
      state.proven = true;
      this.switches(frame.enabled, frame.folder);
    } else if (frame.type === "driving") {
      if (frame.on === true) this.takeOver(socket, String(frame.owner ?? ""));
      else this.letGo("Branch's owner handed this computer back.");
    } else if (frame.type === "invoke") {
      void this.invoke(socket, frame);
    } else if (frame.type === "bye") {
      if (/taken off/.test(String(frame.reason))) state.revoked = true;
      this.options.log?.(`Branch closed the connection: ${String(frame.reason ?? "")}`);
    }
  }

  private switches(list: unknown, folder: unknown): void {
    const wanted = z.array(CapabilitySchema).catch([]).parse(list).filter((c) => this.offers.includes(c));
    for (const capability of wanted)
      if (!this.enabled.has(capability)) void this.options.actions.prepare(capability).catch(() => undefined);
    this.enabled = new Set(wanted);
    this.folder = typeof folder === "string" ? folder : null;
    if (!this.enabled.has("input")) this.letGo("Using its screen and keyboard from Branch was switched off.");
  }

  /**
   * The owner took this computer over from Branch's view: the notice goes on top of every window, and Stop there
   * (or the notice failing) ends the hold here and tells Branch.
   */
  private takeOver(socket: NodeSocket, owner: string): void {
    if (this.hold || !this.enabled.has("input")) return;
    const notice = this.options.actions.startNotice(owner);
    const hold = { owner, notice };
    this.hold = hold;
    this.options.log?.(`${owner || "Branch's owner"} took over this computer's mouse and keyboard from Branch. A notice with Stop is on the screen.`);
    void notice.stopped.then((reason) => {
      if (this.hold !== hold) return;
      this.hold = null;
      this.options.log?.(`The hold ended here: ${reason}`);
      socket.text({ type: "hold-stopped", reason });
    });
  }
  private letGo(why: string): void {
    const hold = this.hold;
    if (!hold) return;
    this.hold = null;
    hold.notice.close();
    this.options.log?.(`No longer used from Branch: ${why}`);
  }
  /** Whether the owner holds this computer now (its notice showing). */
  held(): boolean { return this.hold !== null; }

  private async invoke(socket: NodeSocket, frame: Record<string, unknown>): Promise<void> {
    const id = String(frame.id ?? "");
    if (!/^[a-f0-9]{32}$/.test(id)) return;
    const refuse = (error: string): void => socket.text({ type: "result", id, ok: false, error });
    const capability = CapabilitySchema.safeParse(frame.capability);
    if (this.seen.has(id)) return refuse("This request was already answered.");
    this.seen.add(id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
    if (!capability.success || !this.enabled.has(capability.data)) return refuse("That is switched off on this device.");
    if (typeof frame.deadline !== "number" || frame.deadline < (this.options.now ?? Date.now)()) return refuse("The request came too late.");
    if (!(capability.data === "input" ? this.inputs.take("input") : this.limit.take("all"))) return refuse("This device has been asked too often in the last minute.");
    if (capability.data === "input") {
      // Only while the owner holds it and its notice is up and on top.
      const hold = this.hold;
      if (!hold || !(await hold.notice.shown) || this.hold !== hold) return refuse("Nobody is using this computer from Branch now, or Stop was pressed here.");
    }
    try {
      const result = await this.options.actions.perform(capability.data, frame.args, this.folder);
      // Q2: the keys the owner pressed here are kept in this computer's own log (typed words are not).
      const args = frame.args as Record<string, unknown> | undefined;
      if (capability.data === "input" && args?.action === "key") this.options.log?.(`Branch's owner pressed ${String(args.chord).slice(0, 40)} here.`);
      if (!result.media) return socket.text({ type: "result", id, ok: true, value: result.value });
      if (result.media.data.length > mediaLimitBytes) return refuse("The picture or sound was larger than Branch accepts.");
      socket.text({ type: "result", id, ok: true, value: result.value,
        media: { mime: result.media.mime, bytes: result.media.data.length, name: result.media.name } });
      socket.binary(mediaFrame(id, result.media.data));
    } catch (error) {
      refuse(error instanceof Error ? error.message.slice(0, 500) : "The device could not do it.");
    }
  }
}
