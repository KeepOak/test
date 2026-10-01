import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { readGatewayAuth, knownDevices } from "../remote/gateway-auth.js";
import { sandboxBackendSettings } from "../sandbox-backends.js";
import { traceExportSettings } from "../tracing-export.js";
import { groupActivations } from "../channels/group-activation.js";
import type { Store } from "../store.js";
import type { NetworkPolicyConfig } from "../network-policy.js";
import type { Policy } from "../policy.js";
import type { ModelPreset } from "../models.js";
import { findLeaks, looksLikeSecretValue } from "../leak-guard.js";
import { inspectPath, runProgram, type Runner } from "./file-access.js";
import { readIntegrationFacts } from "./integration-facts.js";
import { securityCheckSettings } from "./settings.js";
import type { IntegrationFacts, PathFact, PathRole, SecuritySnapshot } from "./types.js";

/**
 * Gathers everything the checks look at, once. Reading only: settings from the database, and who
 * can reach each of Branch's own files. The paths come from the options, never from a default, so a
 * test pointed at a temporary folder reads that folder and nothing else.
 */

/** The parts of the running app the check reads. Structural, so this file needs nothing else from it. */
export interface SecurityApp {
  store: Store;
  runtime: { owner: string; workspace: string; policy(): Policy; models: { presets: ReadonlyMap<string, ModelPreset> } };
  registry: { names(): string[] };
  sessionLock: { settings(): { idleMinutes: number; secretsWhileLocked: boolean } };
  privacy: { settings(): { pii: { outbound: string }; moderation: { enabled: boolean } } };
  web: { policy: { settings(): NetworkPolicyConfig; guard(base: typeof fetch): typeof fetch } };
  sessionTokens: { list(owner: string): { name: string; scope: string; expiresAt: string; revokedAt: string | null }[] };
  plugins: { list(): Promise<{ id: string; enabled: boolean; summary: { permissions: string[] } | null }[]> };
  pluginCatalog: { list(): Promise<{ id: string; unchanged: boolean }[]> };
  /** bucket 19 (integration review): the sign-in door for people on their own device. */
  people?: {
    settings(): { mode: string; chain: string[]; sessionMinutes: number };
    keys: { list(): { revokedAt: string | null; expiresAt: string }[] };
    suggestions(): unknown[];
  };
}

function peopleFacts(app: SecurityApp, now: Date): NonNullable<SecuritySnapshot["people"]> | null {
  if (!app.people) return null;
  const settings = app.people.settings();
  const signedIn = app.people.keys.list().filter((key) => !key.revokedAt && Date.parse(key.expiresAt) > now.getTime()).length;
  return { mode: settings.mode, chain: [...settings.chain], sessionMinutes: settings.sessionMinutes, signedIn, waiting: app.people.suggestions().length };
}

export interface CollectOptions {
  dataDir: string;
  /** The launch settings file, when Branch was started with one. */
  integrationsPath: string | null;
  /** Whether the phone door is open right now; null when this caller cannot know. */
  remoteEnabled: boolean | null;
  platform?: NodeJS.Platform;
  home: string;
  run?: Runner;
  now?: Date;
}

const dataPaths: [PathRole, string][] = [
  ["database", "branch.sqlite"], ["database", "branch.sqlite-wal"], ["database", "branch.sqlite-shm"],
  ["locker-key", "locker.key"], ["chatgpt-sign-in", "chatgpt-auth.json"], ["session-token", "session-token"],
  ["plugins-folder", "plugins"], ["browser-profiles", "browser-profiles"], ["artifacts", "artifacts"],
  ["kept", "kept"], ["logs", "logs"], ["update-backups", "update-backups"], ["diagnostics", "diagnostics"],
];
const keyFolders = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".password-store"];

async function pluginFiles(dataDir: string): Promise<string[]> {
  const names = await readdir(join(dataDir, "plugins")).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(".mjs")).slice(0, 100).map((name) => join(dataDir, "plugins", name));
}

/** Who can reach each of Branch's files. Inside a private folder nobody else can open, nothing is reachable. */
async function gatherPaths(options: CollectOptions, workspace: string, programs: string[], platform: NodeJS.Platform): Promise<PathFact[]> {
  const run = options.run ?? runProgram;
  const wanted: [PathRole, string][] = [["data-folder", options.dataDir], ["workspace", workspace],
    ...dataPaths.map(([role, name]): [PathRole, string] => [role, join(options.dataDir, name)]),
    ...(await pluginFiles(options.dataDir)).map((path): [PathRole, string] => ["plugin-file", path])];
  if (options.integrationsPath) wanted.push(["integrations", options.integrationsPath]);
  for (const program of programs) wanted.push(["shell-program", await realpath(program).catch(() => program)]);
  const facts: PathFact[] = [];
  for (const [role, path] of wanted) facts.push(await inspectPath(role, path, platform, run));
  const folder = facts[0]!;
  const sheltered = platform !== "win32" && folder.kind === "folder" && !folder.othersRead && !folder.othersWrite;
  const inData = (fact: PathFact) => fact.path.startsWith(options.dataDir + (platform === "win32" ? "\\" : "/"));
  return sheltered ? facts.map((fact) => (inData(fact) ? { ...fact, othersRead: false, othersWrite: false } : fact)) : facts;
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

function tracePlainHeaders(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(([, value]) => !value.startsWith("secret://") && (looksLikeSecretValue(value) || findLeaks(value).length > 0))
    .map(([name]) => name);
}

function policyFacts(policy: Policy): SecuritySnapshot["policy"] {
  return {
    preset: policy.preset, limits: policy.limits, unmatchedCommands: policy.unmatchedCommands,
    rules: policy.rules.map((rule) => ({
      tool: rule.tool, match: rule.match, applies: rule.applies, decision: rule.decision, remember: rule.remember,
      hasResource: rule.resource !== undefined || (rule.paths?.length ?? 0) > 0,
      ...(rule.sandbox ? { sandbox: rule.sandbox } : {}), ...(rule.backend ? { backend: rule.backend } : {}),
    })),
  };
}

async function addOnFacts(app: SecurityApp): Promise<SecuritySnapshot["plugins"]> {
  const catalogue = new Map((await app.pluginCatalog.list()).map((entry) => [entry.id, entry.unchanged]));
  return (await app.plugins.list()).map((plugin) => ({
    id: plugin.id, enabled: plugin.enabled, fingerprinted: catalogue.has(plugin.id),
    unchanged: catalogue.get(plugin.id) ?? false, permissions: plugin.summary?.permissions ?? [],
  }));
}

function settingsFacts(app: SecurityApp, now: Date) {
  const { store } = app, owner = app.runtime.owner;
  const lock = app.sessionLock.settings(), privacy = app.privacy.settings(), network = app.web.policy.settings();
  const trace = traceExportSettings(store, owner);
  return {
    gatewayChain: [...readGatewayAuth(store, owner).chain], knownDevices: knownDevices(store, owner).length,
    people: peopleFacts(app, now),
    sessionLock: { idleMinutes: lock.idleMinutes, secretsWhileLocked: lock.secretsWhileLocked },
    privacy: { outbound: privacy.pii.outbound, moderation: privacy.moderation.enabled },
    network: { allowPrivateAddresses: network.allowPrivateAddresses, fakeIpProxy: network.fakeIpProxy === true,
      allowedHosts: network.allowedHosts ?? null, blockedHosts: network.blockedHosts.length },
    traceExport: { enabled: trace.enabled, endpoint: trace.endpoint, plainHeaders: tracePlainHeaders(trace.headers) },
    tokens: app.sessionTokens.list(owner).map((token) => ({ name: token.name, scope: token.scope, expiresAt: token.expiresAt, revoked: token.revokedAt !== null })),
    now: now.toISOString(),
    models: [...app.runtime.models.presets.values()].map((preset) => ({ id: preset.id, name: preset.name, model: preset.model, provider: preset.provider.name })),
    tools: app.registry.names(),
    skills: app.store.skills.list(owner).map((skill) => ({ id: skill.id, name: skill.name, active: skill.activeVersion !== null, findings: skill.findings.length })),
    switches: securityCheckSettings(store, owner),
    sandboxImage: sandboxBackendSettings(store, owner).image,
    alwaysGroups: groupActivations(store, owner).filter((group) => group.activation === "always")
      .map(({ channel, title }) => ({ channel, title })),
  };
}

/** Everything the checks need, gathered once. Never throws for a file that is missing or unreadable. */
export async function collectSnapshot(app: SecurityApp, options: CollectOptions): Promise<SecuritySnapshot> {
  const platform = options.platform ?? process.platform, workspace = app.runtime.workspace;
  const integrations: IntegrationFacts | null = options.integrationsPath ? await readIntegrationFacts(options.integrationsPath) : null;
  const programs = (integrations?.shell?.executables ?? []).map((entry) => entry.path).filter(Boolean);
  const keyFound: string[] = [];
  for (const name of keyFolders) if (await exists(join(workspace, name))) keyFound.push(name);
  return {
    platform, home: options.home, dataDir: options.dataDir, workspace, integrations,
    paths: await gatherPaths(options, workspace, programs, platform),
    workspaceKeyFolders: keyFound,
    icloudDesktopDocuments: platform === "darwin" && await exists(join(options.home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Desktop")),
    policy: policyFacts(app.runtime.policy()),
    remoteEnabled: options.remoteEnabled,
    plugins: await addOnFacts(app),
    ...settingsFacts(app, options.now ?? new Date()),
  };
}
