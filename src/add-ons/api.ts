import { z } from "zod";
import type { AddOns } from "./index.js";
import { pluginTargets } from "./export.js";
import { addOnLabels, addOnParts, requirePart, type AddOnPart } from "./settings.js";
import { FilterRuleSchema } from "./filters.js";

/**
 * Bucket 15: the owner's routes for add-ons, all under /api/plugin-catalog/add-ons (the plugin
 * catalog's own prefix, which already belongs to the owner alone). Every change here is the
 * owner's: a short-lived key is refused (tests/short-lived-key-routes.mjs), and no route installs,
 * switches on or updates anything by itself. Switching off and removing always work, whatever the
 * switches say; everything else refuses in a sentence while its part is off.
 */
export class AddOnsApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const lookFirst = "Look at the add-on first: installing names the fingerprint you were shown.";
const fingerprint = z.string({ error: lookFirst }).regex(/^[a-f0-9]{64}$/, lookFirst);
const source = z.object({ source: z.string().min(1).max(1000), sha256: fingerprint.optional() }).strict();
/** Installing always names what the owner was shown, so a package changed after the look is refused. */
const shown = z.object({ source: source.shape.source, sha256: fingerprint }).strict();
const idOnly = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) }).strict();
const address = z.object({ address: z.string().min(1).max(1000) }).strict();
const folder = z.object({ folder: z.string().min(2).max(1000) }).strict();
type Body = () => Promise<unknown>;
type Handler = (addOns: AddOns, body: Body) => Promise<unknown>;

const part = (name: AddOnPart, handler: Handler): { part: AddOnPart; handler: Handler } => ({ part: name, handler });
const always = (handler: Handler): { part: null; handler: Handler } => ({ part: null, handler });

const posts: Record<string, { part: AddOnPart | null; handler: Handler }> = {
  "/api/plugin-catalog/add-ons/settings": always(async (a, body) => a.save(await body())),
  // RES-251: one hand-placed plugin inside Branch (a yes, never under Lockdown) or walled; and keeping the ones kept as before.
  "/api/plugin-catalog/add-ons/inside": always(async (a, body) => a.setInside(await body())),
  "/api/plugin-catalog/add-ons/kept": always(async (a, body) => { z.object({}).strict().parse((await body()) ?? {}); return a.keepGrandfathered(); }),
  "/api/plugin-catalog/add-ons/look": part("packages", async (a, body) => a.shelf.look(source.parse(await body()).source)),
  "/api/plugin-catalog/add-ons/install": part("packages", async (a, body) => {
    const input = shown.parse(await body());
    return a.shelf.install(input.source, { expectSha256: input.sha256 });
  }),
  "/api/plugin-catalog/add-ons/switch": always(async (a, body) => {
    const input = z.object({ id: idOnly.shape.id, on: z.boolean(), allow: z.array(z.string().max(64)).max(20).optional() }).strict().parse(await body());
    if (!input.on) return a.shelf.switchOff(input.id);
    requirePart(a.storeReader, a.owner, "packages");
    return a.shelf.switchOn(input.id, input.allow);
  }),
  "/api/plugin-catalog/add-ons/remove": always(async (a, body) => a.shelf.remove(idOnly.parse(await body()).id)),
  "/api/plugin-catalog/add-ons/bundled/install": part("packages", async (a, body) => {
    const input = z.object({ id: idOnly.shape.id, sha256: fingerprint }).strict().parse(await body());
    return a.shelf.installBundled(input.id, input.sha256);
  }),
  "/api/plugin-catalog/add-ons/lists/browse": part("lists", async (a, body) => a.lists.browse(address.parse(await body()).address)),
  "/api/plugin-catalog/add-ons/lists/install": part("lists", async (a, body) => {
    const input = z.object({ address: address.shape.address, id: z.string().min(1).max(80), sha256: fingerprint }).strict().parse(await body());
    return a.lists.install(input.address, input.id, input.sha256);
  }),
  "/api/plugin-catalog/add-ons/lists/forget": always(async (a, body) => a.lists.forget(address.parse(await body()).address)),
  "/api/plugin-catalog/add-ons/lists/updates": part("lists", async (a) => ({ updates: await a.lists.updates() })),
  "/api/plugin-catalog/add-ons/lists/update": part("lists", async (a, body) => a.lists.update(idOnly.parse(await body()).id)),
  "/api/plugin-catalog/add-ons/lists/stage-update": part("lists", async (a, body) => a.lists.stageUpdate(idOnly.parse(await body()).id)),
  "/api/plugin-catalog/add-ons/filters": part("filters", async (a, body) => a.filters.save(await body())),
  "/api/plugin-catalog/add-ons/filters/remove": always(async (a, body) => a.filters.remove(z.object({ id: FilterRuleSchema.shape.id }).strict().parse(await body()).id)),
  "/api/plugin-catalog/add-ons/filters/test": part("filters", async (a, body) => {
    const input = z.object({ stage: z.enum(["inlet", "outlet"]), text: z.string().max(20000), models: z.array(z.string().max(120)).max(8).default([]) }).strict().parse(await body());
    return a.filters.run(input.stage, input.text, input.models);
  }),
  "/api/plugin-catalog/add-ons/pipelines": part("pipelines", async (a, body) => a.pipelines.save(await body())),
  "/api/plugin-catalog/add-ons/pipelines/forget": always(async (a, body) => a.pipelines.forget(address.parse(await body()).address)),
  "/api/plugin-catalog/add-ons/pipelines/check": part("pipelines", async (a, body) => a.pipelines.check(address.parse(await body()).address)),
  "/api/plugin-catalog/add-ons/pipelines/list": part("pipelines", async (a, body) => ({ pipelines: await a.pipelines.list(address.parse(await body()).address) })),
  "/api/plugin-catalog/add-ons/pipelines/valves": part("pipelines", async (a, body) => {
    const input = z.object({ address: address.shape.address, id: z.string().min(1).max(120) }).strict().parse(await body());
    return { valves: await a.pipelines.valves(input.address, input.id) };
  }),
  "/api/plugin-catalog/add-ons/export": part("export", async (a, body) => {
    const input = z.object({ target: z.enum(pluginTargets), folder: folder.shape.folder }).strict().parse(await body());
    return a.exports.write(input.target, input.folder);
  }),
  "/api/plugin-catalog/add-ons/export/status": always(async (a, body) => a.exports.status(folder.parse(await body()).folder)),
  "/api/plugin-catalog/add-ons/export/remove": always(async (a, body) => a.exports.remove(folder.parse(await body()).folder)),
  "/api/plugin-catalog/add-ons/drafts/install": part("drafts", async (a, body) => {
    requirePart(a.storeReader, a.owner, "packages");
    const input = z.object({ id: idOnly.shape.id, sha256: fingerprint }).strict().parse(await body());
    return a.shelf.install(a.drafts.path(input.id), { expectSha256: input.sha256 });
  }),
  "/api/plugin-catalog/add-ons/drafts/look": part("drafts", async (a, body) => a.shelf.look(a.drafts.path(idOnly.parse(await body()).id))),
  "/api/plugin-catalog/add-ons/drafts/discard": always(async (a, body) => a.drafts.discard(idOnly.parse(await body()).id)),
};

/** Everything the Plugins page shows about add-ons. Reading changes nothing and fetches nothing. */
async function overview(addOns: AddOns): Promise<unknown> {
  const installed = [];
  for (const record of addOns.shelf.list()) installed.push({ ...record, unchanged: await addOns.shelf.unchanged(record) });
  return {
    settings: addOns.settings(),
    /** On Windows the card offers the owner's choice to run add-on code without the wall. */
    windows: process.platform === "win32",
    parts: addOnParts.map((name) => ({ part: name, label: addOnLabels[name] })),
    installed,
    bundled: addOns.mode("packages") === "off" ? [] : await addOns.shelf.bundled(),
    drafts: await addOns.drafts.list(),
    lists: addOns.lists.saved(),
    filters: addOns.filters.list(),
    pipelines: addOns.pipelines.saved(),
    exports: addOns.exports.saved(),
  };
}

export async function addOnsApi(addOns: AddOns, method: string, path: string, body: Body): Promise<unknown> {
  if (method === "GET" && path === "/api/plugin-catalog/add-ons") return overview(addOns);
  const route = method === "POST" ? posts[path] : undefined;
  if (!route) throw new AddOnsApiError(404, "Endpoint not found");
  if (route.part) requirePart(addOns.storeReader, addOns.owner, route.part);
  return route.handler(addOns, body);
}
