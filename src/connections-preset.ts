import { gatewayModel } from "./asks/model-gateway.js"; // mac6/bucket-23 (A1012)
import { z } from "zod";
import type { Provider } from "./contracts.js";
import type { Locker } from "./locker.js";
import type { ModelRouter } from "./models.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Store } from "./store.js";
import { type CatalogEntry, catalogEntry, isRetired, modelsAddress } from "./provider-catalog.js";
import { buildConnection } from "./provider-factory.js";
import { countModels } from "./provider-probe.js";
import { audit } from "./audit.js";
import { migrateRecords, describeMove } from "./provider-migrations.js";
import { type ConnectionCheck, connectionCheck } from "./local-connection-policy.js";
import { pinnedFetch } from "./pinned-fetch.js";
import { claudeSubscriptionModels, claudeSubscriptionPreset } from "./providers/claude-models.js";

/**
 * Adding a model connection in plain language: pick a service, paste the key, answer whatever else
 * that service asks for. Branch checks the key by using it before anything is saved, puts the key
 * in the locker rather than in a settings file, and reports what it found. The key itself is never
 * written to a log, returned in an answer, or put in an error message.
 */
export const FromPresetSchema = z.object({
  provider: z.string().min(1).max(64),
  key: z.string().max(4096).default(""),
  extras: z.record(z.string().min(1).max(40), z.string().max(500)).default({}),
  model: z.string().max(256).optional(),
  /** What to call it on screen; defaults to the service's name. */
  name: z.string().trim().max(80).optional(),
}).strict();
export type FromPresetInput = z.infer<typeof FromPresetSchema>;

export interface FromPresetResult {
  id: string;
  name: string;
  provider: string;
  model: string;
  /** Models the service listed, capped so one reply cannot flood the screen. */
  models: string[];
  /** Null when the service offers no list; then the key was checked by asking for one small reply. */
  modelsFound: number | null;
  can: string[];
  /** Where the key was put, so a person can find it again. Never the key itself. */
  secret: { project: string; name: string };
  message: string;
}

/** The locker project every model-service key lives in, so they are easy to find and to clear out. */
export const connectionProject = "model-connections";
/** `lm-studio` becomes `LM_STUDIO_KEY`, which is the shape the locker insists on. */
export function secretNameFor(providerId: string): string {
  return providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^([^A-Z])/, "P$1").slice(0, 60) + "_KEY";
}

const listed = z.object({
  data: z.array(z.object({ id: z.string().max(256) }).loose()).optional(),
  models: z.array(z.object({ id: z.string().max(256).optional(), name: z.string().max(256).optional() }).loose()).optional(),
}).loose();

/** The names in whichever shape the service answered with; an unfamiliar shape gives an empty list. */
export function modelNames(body: unknown): string[] {
  const parsed = listed.safeParse(body);
  if (!parsed.success) return [];
  const rows: { id?: string | undefined; name?: string | undefined }[] = parsed.data.data ?? parsed.data.models ?? [];
  return rows.map((row) => row.id ?? row.name ?? "").filter((name) => name.length > 0).slice(0, 50);
}

export interface FromPresetDeps {
  models: ModelRouter;
  locker: Locker;
  owner: string;
  policy: NetworkPolicy;
  /** Where the connection itself is written down, so it is still here after a restart. */
  store?: Store;
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * What is written down about a connection: everything except the key, which stays in the locker.
 * This is enough to build the same connection again when Branch starts, and it is readable by the
 * person whose computer it is.
 */
const ConnectionRecordSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  catalogId: z.string().min(1).max(64),
  model: z.string().min(1).max(256),
  extras: z.record(z.string().min(1).max(40), z.string().max(500)).default({}),
}).strict();
export type ConnectionRecord = z.infer<typeof ConnectionRecordSchema>;
const ConnectionsSchema = z.object({ connections: z.array(ConnectionRecordSchema).max(32).default([]) }).strict();
/** The settings row the saved connections live in, beside every other setting. */
export const connectionsSetting = "model-connections";

/** The connections written down for this person, or none when the record is missing or damaged. */
export function savedConnections(store: Store, owner: string): ConnectionRecord[] {
  const saved = ConnectionsSchema.safeParse(store.get("settings", owner, connectionsSetting)?.data ?? {});
  return saved.success ? saved.data.connections : [];
}

/** Writes one connection down, replacing any earlier one with the same name. */
function rememberConnection(deps: FromPresetDeps, record: ConnectionRecord): void {
  if (!deps.store) return;
  const kept = savedConnections(deps.store, deps.owner).filter((saved) => saved.id !== record.id);
  kept.push(ConnectionRecordSchema.parse(record));
  deps.store.save("settings", deps.owner, connectionsSetting, { connections: kept.slice(-32) });
  // Batch 20 (wave 8): adding a model service widens where the assistant's words go, so it belongs
  // in the record of what it was allowed to do beside every other such moment.
  audit(deps.store, deps.owner, { action: "connection.changed", actor: deps.owner,
    subject: `${record.name} (${record.id})`, reason: "A connection to a model service was added", outcome: "added" });
}

/**
 * Takes a connection away for good: out of the model list, out of the written-down record, and its
 * key out of the locker. Without this, a service added from a preset would come back every time
 * Branch started and there would be no plain way to be rid of a key that has been revoked.
 */
export async function forgetConnection(deps: FromPresetDeps, id: string): Promise<{ id: string; removed: boolean }> {
  z.string().min(1).max(64).parse(id);
  const store = deps.store;
  if (!store) throw new Error("Branch cannot write down connections in this launch, so there is nothing to remove");
  const kept = savedConnections(store, deps.owner).filter((saved) => saved.id !== id);
  const known = kept.length !== savedConnections(store, deps.owner).length;
  if (!known && !deps.models.presets.has(id))
    throw new Error(`There is no connection called "${id}"`);
  store.save("settings", deps.owner, connectionsSetting, { connections: kept });
  deps.locker.remove(deps.owner, connectionProject, secretNameFor(id));
  // Known Claude model choices share one saved connection; unrelated ids are still removed exactly.
  if (!known && claudeSubscriptionPreset(id)) {
    for (const entry of claudeSubscriptionModels) deps.models.remove(entry.presetId);
  } else deps.models.remove(id);
  audit(store, deps.owner, { action: "connection.changed", actor: deps.owner, subject: id,
    reason: "A connection to a model service was removed, and its key taken out of the locker", outcome: "removed" });
  return { id, removed: true };
}

/**
 * Builds every written-down connection again, taking each key out of the locker. One connection
 * that cannot be rebuilt — a key removed by hand, a service dropped from the catalog — is skipped
 * rather than being allowed to stop Branch from starting. Returns the ones that came back.
 */
export async function restoreConnections(deps: FromPresetDeps): Promise<string[]> {
  if (!deps.store) return [];
  migrateSavedConnections(deps.store, deps.owner);
  const back: string[] = [];
  for (const record of savedConnections(deps.store, deps.owner)) {
    try {
      const secret = secretNameFor(record.id);
      const held = deps.locker.exists(deps.owner, connectionProject, secret)
        ? (await deps.locker.resolve(deps.owner, connectionProject, [secret]))[secret] ?? ""
        : "";
      const built = buildConnection({
        provider: record.catalogId, key: held, extras: record.extras, model: record.model,
        policy: deps.policy, fetchImpl: deps.models.health.watch(record.id, deps.fetchImpl ?? pinnedFetch),
      });
      deps.models.register({
        id: record.id, name: record.name, provider: built.provider, model: built.model, catalogId: record.catalogId, endpoint: built.baseUrl,
      });
      back.push(record.id);
    } catch { /* one connection that cannot be rebuilt never stops the others, or the program */ }
  }
  return back;
}

/**
 * Moves written-down connections onto a service's new route (Perplexity's Agent API, a region
 * choice) in place, so nothing is asked of the owner. Written back only when something changed.
 */
export function migrateSavedConnections(store: Store, owner: string): string[] {
  const before = savedConnections(store, owner);
  const { records, changed } = migrateRecords(before);
  if (!changed.length) return [];
  // The records as they were are kept beside the new ones (the first copy is never overwritten),
  // so going back one release, or undoing a move by hand, loses nothing. Keys are not in here.
  if (!store.get("settings", owner, movedFromSetting))
    store.save("settings", owner, movedFromSetting, { connections: before, movedAt: new Date().toISOString() });
  store.save("settings", owner, connectionsSetting, { connections: records });
  const moves = describeMove(before, records).join("; ");
  audit(store, owner, { action: "connection.changed", actor: "branch", subject: changed.join(", ").slice(0, 300),
    reason: `A model service moved to a new address or route, so the saved connection moved with it: ${moves}`.slice(0, 500),
    outcome: "moved" });
  return changed;
}
/** Where the saved connections are copied before a move, beside the live row. */
export const movedFromSetting = "model-connections-before-move";

/**
 * The answers written down for a new connection, with the default filled in for every box that is
 * a fixed choice (a region). A connection saved without it would look like one made before the
 * choice existed, and the region move would then send its key to the other region's address.
 */
function withChosenDefaults(entry: CatalogEntry, extras: Record<string, string>): Record<string, string> {
  const filled = { ...extras };
  for (const extra of entry.extras ?? [])
    if (extra.choices && extra.default && !(filled[extra.key] ?? "").trim()) filled[extra.key] = extra.default;
  return filled;
}

/**
 * Checks a service is really reachable with this key, then remembers it. The order matters: a key
 * that does not work is never stored, so nothing accumulates that a person would later have to
 * clean up.
 */
export async function connectFromPreset(deps: FromPresetDeps, input: unknown): Promise<FromPresetResult> {
  const asked = FromPresetSchema.parse(input);
  const entry = catalogEntry(asked.provider);
  if (!entry) throw new Error(`Branch does not know a model service called "${asked.provider}"`);
  if (isRetired(entry)) throw new Error(entry.terms.warning ?? `${entry.name} can no longer be used.`);
  if (!entry.capabilities.includes("chat") && entry.modelsPath === null)
    throw new Error(`${entry.name} does not hold conversations and publishes no list of models, so Branch cannot check a key for it. Use it for searching your own documents instead.`);
  // Checked calls through the connection stay with the addresses their check judged (src/pinned-fetch.ts).
  const call = deps.fetchImpl ?? pinnedFetch;
  // Named after the connection, not the service, so a second key for the same service does not
  // quietly replace the first one. Worked out before anything is built, because the health record
  // is kept under this name and a second connection must not write onto the first one's card.
  const id = uniqueId(deps.models, asked.provider);
  const built = buildConnection({
    provider: asked.provider, key: asked.key, extras: asked.extras,
    // mac6/bucket-23 (A1012): "vendor/model" or a bare name, spelled the way this service wants it.
    ...(asked.model ? { model: gatewayModel(entry.id, asked.model) } : {}),
    policy: deps.policy, fetchImpl: deps.models.health.watch(id, call),
  });
  const list = modelsAddress(entry, built.baseUrl);
  const check = connectionCheck(deps.policy, entry, built.baseUrl);
  const found = list ? await probeList(check, list, asked.key, entry.auth, call) : null;
  if (!list) await probeChat(built.provider);
  const name = asked.name || entry.name;
  if (asked.key) await deps.locker.set(deps.owner, connectionProject, secretNameFor(id), asked.key);
  deps.models.register({ id, name, provider: built.provider, model: built.model, catalogId: entry.id, endpoint: built.baseUrl });
  // The connection itself (never the key) is written down, so it is still here after a restart.
  rememberConnection(deps, { id, name, catalogId: entry.id, model: built.model, extras: withChosenDefaults(entry, asked.extras) });
  return {
    id, name, provider: entry.id, model: built.model,
    models: found ?? [], modelsFound: found ? found.length : null,
    can: entry.capabilities,
    secret: { project: connectionProject, name: secretNameFor(id) },
    message: found
      ? `${entry.name} answered and listed ${found.length} model(s). It is set up as "${id}".`
      : `${entry.name} answered a small test request. It is set up as "${id}", and it does not publish a list of models.`,
  };
}

async function probeList(
  check: ConnectionCheck, url: string, key: string, auth: string, call: typeof globalThis.fetch,
): Promise<string[]> {
  await check(new URL(url), "model connection check");
  const headers: Record<string, string> =
    auth === "x-api-key" ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : auth === "api-key" ? { "api-key": key }
    : auth === "google-key" ? { "x-goog-api-key": key }
    : auth === "none" ? {}
    : { authorization: `Bearer ${key}` };
  const response = await call(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok)
    throw new Error(response.status === 401 || response.status === 403
      ? "That key was refused. Check you copied all of it, and that it is for this service."
      : `The service answered ${response.status} when asked what models it has. Try again in a moment.`);
  return modelNames(await response.json().catch(() => null));
}

/** For a service with no list of models: one very small request, which is the only other check. */
async function probeChat(provider: Provider): Promise<void> {
  await provider.complete({
    messages: [{ role: "user", content: "Reply with the single word OK." }],
    tools: [], maxTokens: 16, signal: AbortSignal.timeout(30_000),
  });
}

function uniqueId(models: ModelRouter, base: string): string {
  if (!models.presets.has(base)) return base;
  for (let at = 2; at < 100; at++) if (!models.presets.has(`${base}-${at}`)) return `${base}-${at}`;
  throw new Error("There are already too many connections to this service");
}

/** How many models a service listed, for the places that only want the count. */
export const countFromBody = countModels;
