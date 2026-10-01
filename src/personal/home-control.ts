import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { callJson } from "../channels/parity-common.js";
import { RateLimiter } from "../approvals.js";
import { probeMetadata, type ConnectionHealth } from "./probe.js";
import { clip, partSettings, requirePersonal, savePartSettings, secretNameSchema } from "./settings.js";
import { assertHealthCurrent } from "../health-check.js";

/**
 * R17-024: looking at and controlling the owner's Home Assistant through its REST API, with a
 * long-lived access token saved in Secrets (the same HOMEASSISTANT_TOKEN name the notify channel
 * uses). Reading states is a look; calling a service changes something in the house, so it has its
 * own permission, and only the kinds of device the owner listed can be called at all. Locks, alarms
 * and garage doors are not on the starting list, and when the owner adds them every call to one is
 * asked about, just this once (src/personal/guard.ts). A call names one device and is paced.
 * API: https://developers.home-assistant.io/docs/api/rest/
 */
const domain = z.string().regex(/^[a-z_]{1,40}$/);
export const HomeSettingsSchema = z.object({
  url: z.string().url().max(500).regex(/^https?:\/\//).nullable().default(null),
  tokenName: secretNameSchema.default("HOMEASSISTANT_TOKEN"),
  /** The kinds of device a service may be called on. */
  domains: z.array(domain).max(40).default(["light", "switch", "scene", "script", "media_player", "climate", "fan"]),
}).strict();
const settingsKey = "personal-home-settings";

const targetKeys = new Set(["entity_id", "device_id", "area_id", "floor_id", "label_id"]);
/** Integration review: how many service calls a minute, so a runaway task cannot flick the house on and off. */
export const homeCallsPerMinute = 30;
const entityId = z.string().regex(/^[a-z_]{1,40}\.[a-z0-9_]{1,200}$/, "An entity looks like light.kitchen");
export const StatesSchema = z.object({
  entity: entityId.optional(),
  /** Only this kind of device, such as light. */
  domain: domain.optional(),
  /** Words in the entity id or its friendly name. */
  text: z.string().trim().max(100).optional(),
  max: z.number().int().min(1).max(200).default(50),
}).strict();
export const CallSchema = z.object({
  domain,
  service: z.string().regex(/^[a-z_]{1,60}$/),
  entity: entityId,
  /** Extra values the service takes, such as brightness_pct. */
  data: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.union([z.string().max(200), z.number(), z.boolean()]))
    .refine((d) => Object.keys(d).length <= 20)
    // Integration review: these would point the call at more devices than the one named.
    .refine((d) => !Object.keys(d).some((key) => targetKeys.has(key)), "A call names one device; area, device, floor and label targets are not taken")
    .default({}),
}).strict();

const StateSchema = z.object({ entity_id: z.string(), state: z.string(), last_changed: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).default({}) }).passthrough();
const summary = (s: z.infer<typeof StateSchema>) => ({ entity: s.entity_id, state: clip(s.state, 100),
  name: typeof s.attributes.friendly_name === "string" ? clip(s.attributes.friendly_name, 100) : "", changed: s.last_changed ?? null });

export class HomeControl {
  private readonly pace = new RateLimiter(60_000);
  constructor(private readonly store: Store, private readonly owner: string, private readonly fetcher: typeof fetch,
    private readonly secret: (name: string) => Promise<string>) {}
  settings() { return partSettings(this.store, this.owner, settingsKey, HomeSettingsSchema); }
  save(input: unknown) { return savePartSettings(this.store, this.owner, settingsKey, HomeSettingsSchema, input); }

  /** GET /api/ proves authenticated API access only, without reading devices or changing the house.
   * Contract: https://developers.home-assistant.io/docs/api/rest/ (trailing slash is required). */
  async test(): Promise<ConnectionHealth> {
    assertHealthCurrent();
    requirePersonal(this.store, this.owner, "home-control");
    const settings = this.settings();
    if (!settings.url) throw new Error("Add your Home Assistant address before testing the connection.");
    const token = await this.secret(settings.tokenName);
    assertHealthCurrent();
    return probeMetadata([{ capability: "Home Assistant API access", url: `${settings.url.replace(/\/+$/, "")}/api/`,
      shape: z.object({ message: z.literal("API running.") }) }], token, this.fetcher);
  }

  /** One call to Home Assistant's REST API; `path` is what follows its /api. */
  private async call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<unknown> {
    requirePersonal(this.store, this.owner, "home-control");
    const settings = this.settings();
    if (!settings.url) throw new Error("There is no Home Assistant address yet. Add it on the Home Assistant card.");
    const token = await this.secret(settings.tokenName);
    try {
      return await callJson(this.fetcher, "Home Assistant", `${settings.url.replace(/\/+$/, "")}/api${path}`,
        { ...init, headers: { authorization: `Bearer ${token}` } });
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      if (/private or local address|points at this computer/.test(said))
        throw new Error("Home Assistant is on your home network, which Branch may not reach yet. Allow private addresses under Settings → Computer → Network reach, or give its public address.");
      if (/\((401|403)\)/.test(said)) throw new Error(`Home Assistant refused the access token. Make a new long-lived access token and save it as ${settings.tokenName}.`);
      throw error;
    }
  }

  async states(input: unknown) {
    const value = StatesSchema.parse(input);
    if (value.entity) return { states: [summary(StateSchema.parse(await this.call(`/states/${value.entity}`)))] };
    const all = z.array(StateSchema).parse(await this.call("/states"));
    const words = value.text?.toLowerCase();
    const picked = all.map(summary)
      .filter((s) => !value.domain || s.entity.startsWith(`${value.domain}.`))
      .filter((s) => !words || s.entity.includes(words) || s.name.toLowerCase().includes(words));
    return { states: picked.slice(0, value.max), total: picked.length };
  }

  async callService(input: unknown) {
    const value = CallSchema.parse(input);
    if (!value.entity.startsWith(`${value.domain}.`)) throw new Error(`${value.entity} is not a ${value.domain}`);
    if (!this.settings().domains.includes(value.domain))
      throw new Error(`Branch may not control ${value.domain} devices. Add ${value.domain} to the list on the Home Assistant card first.`);
    if (this.pace.waitMs("calls", homeCallsPerMinute) > 0)
      throw new Error(`Too many Home Assistant calls in the last minute (${homeCallsPerMinute}). Wait a moment and try again.`);
    this.pace.record("calls");
    const changed = await this.call(`/services/${value.domain}/${value.service}`, { method: "POST", json: { ...value.data, entity_id: value.entity } });
    const states = z.array(StateSchema).safeParse(changed);
    return { called: `${value.domain}.${value.service}`, entity: value.entity, now: states.success ? states.data.map(summary).slice(0, 20) : [] };
  }
}

export function registerHomeControl(registry: Pick<ToolRegistry, "register">, home: HomeControl): void {
  registry.register({ name: "home.states", permission: "personal.read",
    description: "Look at devices in the owner's Home Assistant: one entity, one kind (light, sensor…), or those whose name has some words.",
    parameters: StatesSchema, execute: async (input) => home.states(input) });
  registry.register({ name: "home.call", permission: "home.control",
    description: "Call a Home Assistant service on one device, such as light.turn_on on light.kitchen with brightness_pct. Only kinds of device the owner allowed.",
    parameters: CallSchema, target: (input) => input.entity, execute: async (input) => home.callService(input) });
}
