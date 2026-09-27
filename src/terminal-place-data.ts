import type { createBranch } from "./index.js";
import { readPolicy, policyPresets } from "./policy.js";
import { presetWords } from "./terminal-commands.js";
import { lockdownState } from "./lockdown.js";
import { assistantIdentity } from "./identity.js";
import { trunksFor } from "./trunks/index.js";
import type { Words } from "./terminal-words.js";
import { learnMode } from "./learn/settings.js"; // mac7/learn
import { embedSettings } from "./embeds.js";
import { recipeFor } from "./channel-setup/recipes.js";

/**
 * What each place and tab holds, read from the same stores the window's screens read. Every row is
 * a title and one plain line under it; nothing here changes anything. A row that can be opened
 * carries the conversation it belongs to.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export type PlaceApp = Pick<Branch, "store" | "runtime" | "triggers" | "webhooks" | "hooks" | "documents" | "artifacts"
  | "plugins" | "mcpConnections" | "channels" | "runQueue" | "version" | "devices" | "personal">;
export interface Row {
  title: string;
  detail?: string;
  tone?: "warn" | "ok" | "bad" | "muted" | undefined;
  sessionId?: string;
  /** A command the row stands for: pressing Enter on it runs this. */
  command?: string;
}
export type RowReader = (app: PlaceApp, words: Words) => Row[] | Promise<Row[]>;

const clip = (text: unknown, size = 90): string => {
  const flat = String(text ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > size ? flat.slice(0, size - 1) + "…" : flat;
};
const day = (iso: string): string => iso.slice(0, 16).replace("T", " ");
const WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * mac7/learn: the map of each knowledge base, as rows rather than a picture. A terminal that tries
 * to draw a graph is worse than a list, so this says how big each map is and where it came from,
 * and Enter on a row runs `/learn`. Nothing here builds anything.
 */
function learnRows(app: PlaceApp): Row[] {
  const mode = learnMode(app.store, app.runtime.owner);
  if (mode === "off") return [];
  const rows = app.store.sqlite.prepare(`SELECT e.collection AS collection, COUNT(DISTINCT e.entity_id) AS things,
    (SELECT COUNT(*) FROM kb_relations r WHERE r.owner=e.owner AND r.collection=e.collection) AS links
    FROM kb_entities e WHERE e.owner=? GROUP BY e.collection ORDER BY things DESC LIMIT 12`)
    .all(app.runtime.owner) as { collection: unknown; things: unknown; links: unknown }[];
  return rows.map((row) => ({
    title: clip(String(row.collection)),
    detail: `${Number(row.things)} things · ${Number(row.links)} links · built from your files, no model`,
    tone: "muted" as const,
    command: `/learn documents ${String(row.collection)}`,
  }));
}
function needsYou(app: PlaceApp, words: Words): Row[] {
  const rows: Row[] = app.runtime.approvals.waiting().map((ask) => ({
    title: clip(ask.label || ask.tool), detail: `${ask.tool}${ask.target ? " · " + clip(ask.target, 60) : ""} · ${day(ask.askedAt)}`,
    tone: "warn" as const, sessionId: ask.sessionId,
  }));
  const seen = new Set(rows.map((row) => row.sessionId));
  const latest = new Set<string>();
  for (const run of app.store.runs(app.runtime.owner)) {
    if (latest.has(run.sessionId)) continue;
    latest.add(run.sessionId);
    if (run.status === "needs_input" && !seen.has(run.sessionId))
      rows.push({ title: clip(run.output || run.prompt), detail: day(run.updatedAt), tone: "warn", sessionId: run.sessionId });
  }
  for (const proposal of app.store.review.proposals(app.runtime.owner, "pending"))
    rows.push({ title: words.t("terminal.row.memorySuggestion", "A suggested change to what it remembers"),
      detail: clip((proposal as { data?: { text?: unknown } }).data?.text ?? ""), tone: "warn" });
  return rows;
}
function taskRows(app: PlaceApp, since: number): Row[] {
  return app.store.runs(app.runtime.owner)
    .filter((run) => Date.parse(run.updatedAt) >= since && run.status !== "running")
    .slice(0, 200)
    .map((run) => ({
      title: clip(run.prompt), detail: `${run.status.replace(/_/g, " ")} · ${day(run.updatedAt)}`,
      tone: run.status === "completed" ? "ok" as const : run.status === "failed" ? "bad" as const : "muted" as const,
      sessionId: run.sessionId,
    }));
}
function overviewRows(app: PlaceApp, words: Words): Row[] {
  const owner = app.store.profiles.isOwner(), scope = app.store.profiles.scope();
  const trunkChats = new Set((owner ? trunksFor(app.runtime)?.records.list() ?? [] : [])
    .flatMap((trunk) => [trunk.chatSessionId, ...trunk.retiredChats]));
  const latest = new Map<string, ReturnType<PlaceApp["store"]["runs"]>[number]>();
  for (const run of [...app.store.runs(scope), ...app.store.activeRuns(scope)])
    if (!latest.has(run.sessionId)) latest.set(run.sessionId, run);
  const visible = [...latest.values()].filter((run) => !trunkChats.has(run.sessionId));
  const active = visible.filter((run) => run.status === "running" || run.status === "needs_input");
  const recent = visible.filter((run) => run.status !== "running" && run.status !== "needs_input")
    .slice(0, Math.max(0, 12 - active.length));
  const runs = [...active, ...recent];
  if (!runs.length) return [{ title: words.t("ov.calm", "Nothing waiting"),
    detail: words.t("ov.now.none", "Nothing is running right now."), tone: "ok" }];
  return runs.map((run) => ({ title: clip(run.prompt), detail: `${run.status.replace(/_/g, " ")} · ${day(run.updatedAt)}`,
    tone: run.status === "running" ? "ok" : run.status === "failed" ? "bad" : run.status === "needs_input" ? "warn" : "muted",
    sessionId: run.sessionId }));
}
export function peopleRows(app: PlaceApp, words: Words): Row[] {
  const profiles = app.store.profiles;
  const active = profiles.active();
  const visible = profiles.isOwner() ? profiles.list() : active ? [active] : [];
  const rows = visible.map((profile) => {
      const grant = app.runtime.roles.get(profile.id);
      const role = words.t(`household.role.${grant.role}`, grant.role === "child" ? "Child" : "Adult");
      const used = profile.lastUsedAt ? day(profile.lastUsedAt) : words.t("household.never", "Has not used Branch yet");
      return { title: profile.name, detail: `${role} · ${used}` };
    });
  return profiles.isOwner()
    ? [{ title: words.t("household.owner", "The owner"), detail: words.t("household.role.owner", "Owner"), tone: "ok" }, ...rows]
    : rows;
}
/**
 * A saved record's name, where the window reads it: on the record, or on the definition it keeps (a procedure's or a
 * specialist's `definition.name`). A record with no name at all is left out rather than shown as its id.
 */
const recordRows = (app: PlaceApp, table: "schedules" | "procedures" | "specialists", name: string[]): Row[] =>
  app.store.list(table, app.runtime.owner).flatMap((record) => {
    const data = record.data as Record<string, unknown>;
    const definition = (data.definition && typeof data.definition === "object" ? data.definition : {}) as Record<string, unknown>;
    const title = name.flatMap((key) => [data[key], definition[key]]).find((value) => typeof value === "string" && value);
    if (!title) return [];
    const about = typeof definition.instructions === "string" ? definition.instructions.split("\n")[0] : "";
    const detail = clip([data.status, data.dueAt, data.description, about].filter(Boolean).join(" · "));
    return [detail ? { title: clip(title), detail } : { title: clip(title) }];
  });

/** Customize › Trunks: the owner's live roster, only while Trunks are switched on. */
function trunkRows(app: PlaceApp, words: Words): Row[] {
  const trunkService = trunksFor(app.runtime);
  const list = !app.store.profiles.isOwner() || trunkService?.modes().trunks === "off" ? [] : trunkService?.records.list() ?? [];
  return list.map((trunk) => ({
    title: clip(trunk.name),
    detail: clip(`${words.t("strip.kind.trunk", "Trunk")} · @${trunk.handle}${trunk.title ? ` · ${trunk.title}` : ""}`),
    tone: trunk.hidden || trunk.paused ? "muted" as const : undefined,
    sessionId: trunk.chatSessionId,
  }));
}
/** Customize › Specialists: the helpers a Trunk calls in, as the window lists them. */
const specialistRows = (app: PlaceApp): Row[] => recordRows(app, "specialists", ["name"]);

/** Team › Live now: each task working or waiting, under whose it is, from the person's own work only. */
function liveRows(app: PlaceApp, words: Words): Row[] {
  const owner = app.store.profiles.isOwner(), scope = app.store.profiles.scope();
  const trunks = owner ? trunksFor(app.runtime)?.records.list() ?? [] : [];
  return app.store.activeRuns(scope).map((run) => {
    const waiting = run.status === "needs_input";
    const who = trunks.find((trunk) => trunk.chatSessionId === run.sessionId)?.name ?? assistantName(app);
    const state = waiting ? words.t("dashboard.needs.title", "Needs you") : words.t("window.shell.working", "Working");
    return { title: clip(run.prompt), detail: `${who} · ${state}`, tone: waiting ? "warn" as const : "ok" as const, sessionId: run.sessionId };
  });
}

function triggers(app: PlaceApp, words: Words): Row[] {
  const on = (enabled: boolean): string => enabled ? words.t("terminal.state.on", "on") : words.t("terminal.state.off", "off");
  return [
    ...app.triggers.list(app.runtime.owner).map((entry) => ({ title: clip(entry.name), detail: `${words.t("terminal.row.incoming", "Incoming")} · ${on(entry.enabled)}` })),
    ...app.webhooks.list(app.runtime.owner).map((entry) => ({ title: clip(entry.name), detail: `${words.t("terminal.row.outgoing", "Outgoing")} · ${entry.events.join(", ")} · ${on(entry.enabled)}` })),
    ...app.hooks.list().map((entry) => ({ title: entry.id, detail: `${words.t("terminal.row.hook", "Hook")} · ${entry.event} · ${on(entry.enabled)}` })),
  ];
}
async function made(app: PlaceApp): Promise<Row[]> {
  const kept = await app.artifacts.list(100);
  return kept.map((entry) => ({ title: clip((entry as { title?: string }).title ?? entry.path), detail: clip(entry.path) }));
}
async function plugins(app: PlaceApp, words: Words): Promise<Row[]> {
  const list = await app.plugins.list();
  return list.map((entry) => {
    const plugin = entry as unknown as { id?: string; name?: string; enabled?: boolean; description?: string };
    const state = plugin.enabled === false ? words.t("terminal.state.off", "off") : words.t("terminal.state.on", "on");
    return { title: clip(plugin.name ?? plugin.id), detail: clip(`${state}${plugin.description ? " · " + plugin.description : ""}`) };
  });
}
/** The chat apps connected now, each by its app's own name (the setup book's), with how it is doing. */
export function chatAppRows(app: PlaceApp): Row[] {
  return app.channels.summary().channels.map((channel) => {
    const state = String((channel.health as { state?: string }).state ?? "");
    const name = recipeFor(channel.kind)?.name ?? recipeFor(channel.id)?.name ?? channel.kind;
    return { title: clip(channel.botName ? `${name} · ${channel.botName}` : name), detail: state.replace(/[-_]/g, " "),
      tone: state === "connected" ? "ok" as const : "warn" as const };
  });
}
/** Customize › Channels: the chat apps, and the one command that sets one up. */
const channels = (app: PlaceApp, words: Words): Row[] => [...chatAppRows(app), channelSetupRow(words)]; // mac7/connect
/** Customize › Everywhere: the owner's other devices and the pages that reach Branch. */
function everywhere(app: PlaceApp, words: Words): Row[] {
  if (!app.store.profiles.isOwner()) return [];
  const devices = app.devices.book.devices().map((device) => ({
    title: device.name,
    detail: `${words.t(`devices.platform.${device.platform}`, device.platform)} · ${app.devices.hub.connected(device.id)
      ? words.t("devices.device.connected", "Connected now") : words.t("devices.device.never", "Not connected yet")}`,
    tone: app.devices.hub.connected(device.id) ? "ok" as const : "muted" as const,
  }));
  const embeds = embedSettings(app.store, app.runtime.owner);
  const pageRows = embeds.widget || embeds.extension || embeds.widgetSites.length ? [{
    title: words.t("embeds.title", "Reaching Branch from other pages"),
    detail: clip([embeds.widget ? words.t("field.let-a-page-of-mine", "Small ask box") : "",
      embeds.extension ? words.t("field.let-the-browser-extension-send", "Browser extension") : "",
      ...embeds.widgetSites].filter(Boolean).join(" · "), 140),
  }] : [];
  return [...devices, ...pageRows];
}

/** The skills installed here, the ones switched off marked so. */
export function skillRows(app: PlaceApp, words: Words): Row[] {
  return app.store.skills.list(app.runtime.owner).map((skill) => ({
    title: skill.name, detail: clip(`${skill.activeVersion ? "" : words.t("terminal.state.off", "off") + " · "}${skill.description}`),
    tone: skill.activeVersion ? undefined : "muted" as const,
  }));
}
/** Customize › Tools, as the window groups them: skills, plugins, tool servers and the owner's own accounts. */
async function toolRows(app: PlaceApp, words: Words): Promise<Row[]> {
  const kind = (key: string, english: string, row: Row): Row => ({ ...row, detail: clip([words.t(key, english), row.detail].filter(Boolean).join(" · ")) });
  const skills = skillRows(app, words).map((row) => kind("nav.skills", "Skills", row));
  const addOns = (await plugins(app, words)).map((row) => kind("place.customize.plugins", "Plugins", row));
  const servers = (await connectionRows(app, words)).map((row) => kind("window.chat.tools.connectors", "Connectors", row));
  return [...skills, ...addOns, ...servers];
}
export async function connectionRows(app: PlaceApp, words: Words): Promise<Row[]> {
  const mcp = app.mcpConnections.health().map((server) => ({
    title: server.id, detail: `${server.state}${server.lastError ? " · " + clip(server.lastError, 60) : ""}`,
    tone: server.lastError ? "bad" as const : undefined,
  }));
  if (!app.store.profiles.isOwner()) return mcp;
  const modes = app.personal.modes();
  const accounts = await Promise.all(Object.entries(app.personal.signIns).map(async ([service, signIn]) => {
    const settings = signIn.settings(), status = await signIn.status();
    if (modes[service as keyof typeof modes] === "off" && !settings.clientId && !status.signedIn) return null;
    const name = words.t(`personal.${service}.name`, service);
    return { title: name, detail: words.t(status.signedIn ? "personal.signin.yes" : "personal.signin.no",
      status.signedIn ? "Signed in." : "Not signed in yet."), tone: status.signedIn ? "ok" as const : "muted" as const };
  }));
  const local = [
    ["x-search", "personal.x.title", "Searching posts on X"],
    ["home-control", "personal.home.title", "Your Home Assistant"],
  ].filter(([part]) => modes[part as keyof typeof modes] !== "off")
    .map(([, key, english]) => ({ title: words.t(key!, english!), detail: words.t("terminal.state.on", "on"), tone: "muted" as const }));
  return [...mcp, ...accounts.filter((row): row is NonNullable<typeof row> => row !== null), ...local];
}
/** mac7/connect: the one command that sets up a chat app, shown where the chat apps are. */
function channelSetupRow(words: Words): Row {
  return { title: words.t("terminal.row.channel-setup", "Set up a chat app"),
    detail: words.t("terminal.row.channel-setup-detail", "leave this view and run: branch connect <app> (telegram, discord, slack…)"), tone: "muted" };
}

/** Every tab's rows, by its home. */
export const PLACE_ROWS: Record<string, RowReader> = {
  "overview:here": overviewRows,
  "team:live": liveRows,
  "team:people": peopleRows,
  "inbox:needs": needsYou,
  "inbox:finished": (app) => taskRows(app, Date.now() - WEEK),
  "inbox:history": (app) => taskRows(app, 0),
  "automations:scheduled": (app, words) => [
    ...recordRows(app, "schedules", ["name", "prompt"]),
    ...app.runQueue.list(app.runtime.owner).map((entry) => ({
      title: clip((entry as { prompt?: string }).prompt ?? entry.id), detail: words.t("terminal.row.waiting", "waiting its turn"),
    })),
  ],
  "automations:procedures": (app) => recordRows(app, "procedures", ["name", "title"]),
  "automations:triggers": triggers,
  "library:memory": (app) => app.store.list("memory", app.store.profiles.scope()).map((fact) => ({
    title: clip(fact.data.text), detail: clip(fact.data.source),
  })),
  "library:documents": (app) => [
    ...learnRows(app),
    ...app.documents.list(app.runtime.owner).map((entry) => ({
      title: clip(entry.name), detail: `${entry.fileType} · ${entry.status.replace(/_/g, " ")} · ${day(entry.updatedAt)}`,
      tone: entry.status === "failed" ? "bad" as const : undefined,
    })),
  ],
  "library:made": made,
  "customize:trunks": trunkRows,
  "customize:tools": toolRows,
  "customize:specialists": specialistRows,
  "customize:channels": channels,
  "customize:everywhere": everywhere,
};

/** How many things wait for the owner's yes, for the Inbox count on the tab row. */
export function needsCount(app: PlaceApp): number {
  const sessions = new Set(app.runtime.approvals.waiting().map((ask) => ask.sessionId));
  const latest = new Set<string>();
  for (const run of app.store.runs(app.runtime.owner)) {
    if (latest.has(run.sessionId)) continue;
    latest.add(run.sessionId);
    if (run.status === "needs_input") sessions.add(run.sessionId);
  }
  return sessions.size;
}
export const lockdownOn = (app: PlaceApp): boolean => lockdownState(app.store, app.runtime.owner).on;
export const assistantName = (app: PlaceApp): string =>
  clip(assistantIdentity(app.store, app.runtime.owner).name || "Branch", 24);
/** CL-05d/f: each preset by its name and what it does in the language in force, as Settings › Permissions says them. */
export function permissionRows(app: PlaceApp, words?: Words): Row[] {
  const current = readPolicy(app.store, app.runtime.owner).preset;
  return policyPresets().map((preset) => {
    const said = presetWords(preset, words);
    return { title: `${preset.id === current ? "● " : ""}${said.label}`, detail: clip(said.description, 120),
      tone: preset.id === current ? "ok" as const : undefined, command: `/preset ${preset.id}` };
  });
}
