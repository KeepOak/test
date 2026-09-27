import { readFile, stat } from 'node:fs/promises';
import { defaultShellConfig } from './default-shell.js';
import { withLoginPath } from "../coding/shell-snapshot.js"; // mac7/r17-d
import { channelPosition } from '../never-break/channel-position.js'; // mac3/never-break
import { channelMark } from '../channels/catch-up.js'; // mac6/bucket-16
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import { McpConfigSchema } from './mcp-config.js';
import { connectMcp, openMcp, registerCachedMcp, type LiveMcp, type McpToolCache } from './mcp.js';
import { BranchBrowser, BrowserConfigSchema, registerBrowser, type WorkspacePaths } from './browser.js';
// mac7/vault-autofill (R17-068): filling one of the owner's saved sign-ins into the page they are on.
import { CredentialResolver } from '../credential-cli.js';
import { VaultAutofill, registerVaultAutofill } from '../vault-autofill.js';
import type { BrowserProfiles } from './browser-profiles.js';
import { BrowserSandbox } from './browser-container.js'; // w911 (A2019) hook: import
import { siteSkillsFor, type SiteSkillSource } from './browser-sites.js';
import type { RunArtifacts } from '../artifacts.js';
import { ShellConfigSchema } from './shell-config.js';
import { BranchShell, registerShell, type SecretResolver } from './shell.js';
import { ShellSessions, registerShellSessions } from '../shell-session.js';
import { commandTuning } from '../knobs/commands.js'; // R17-S10
import type { Store } from '../store.js';
import { ChannelPolicySchema, type ChannelAdapter, type ChannelRouter } from '../channels/router.js';
import { TelegramAdapter } from '../channels/telegram.js';
import { DiscordAdapter } from '../channels/discord.js';
import { SlackAdapter } from '../channels/slack.js';
import { WhatsAppAdapter } from '../channels/whatsapp.js';
import { EmailAdapter } from '../channels/email.js';
import { WebhookChatAdapter } from '../channels/webhook-chat.js';
import { channelEntry } from '../channels/catalog.js';
import { MetaMessagingAdapter } from '../channels/meta-graph.js';
import { MatrixAdapter } from '../channels/matrix.js';
import { SignalAdapter } from '../channels/signal-cli.js';
import { connectWebSocket, type WebSocketConnect } from '../channels/ws-client.js';
import { WebConfigSchema, type WebAccess } from './web.js';
import { HookSchema, type Hooks, type HookRunner, type HookConfig } from '../hooks.js';
import type { ToolContext } from '../contracts.js';
import type { NetworkPolicy } from '../network-policy.js';
import type { GitTools } from './git.js';
import { GitHubAccess, GitHubConfigSchema, type TokenSource } from './github.js';
import { GitHubAppSettingsSchema, chooseGitHubTokenSource } from './github-app.js';
import { registerGitHub, registerGitRemote } from './git-tools.js';
import { GitLabAccess, GitLabConfigSchema, registerGitLab } from './gitlab.js';
import { LinearAccess, LinearConfigSchema } from './linear.js';
import { JiraAccess, JiraConfigSchema } from './jira.js';
import { IssueAccess, registerIssues, type IssueTrackers } from './issue-tools.js';
// Wave mac3 (channels-parity): the chat services added to match other assistants, all behind a switch.
import { ParityChannelSchema, buildParityChannel, isParityChannel, type ParityChannelConfig } from '../channels/parity-config.js';

const channelId = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/);
const credentialName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const mailServer = z.object({
  host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535),
  user: z.string().min(1).max(320),
  /** false means connect in the clear and upgrade with STARTTLS; only sensible for sending. */
  tls: z.boolean().default(true),
}).strict();
export const TelegramChannelSchema = z.object({
  id: channelId.default('telegram'),
  type: z.literal('telegram'),
  /** Name of the environment variable that holds the bot token. */
  tokenEnv: credentialName.optional(),
  /** Name of a secret in the default project's locker that holds the bot token. */
  tokenSecret: credentialName.optional(),
  apiBase: z.string().url().optional(),
}).merge(ChannelPolicySchema).strict();
export const DiscordChannelSchema = z.object({
  id: channelId.default('discord'),
  type: z.literal('discord'),
  /** Environment variable or locker secret holding the bot token, looked for in that order. */
  tokenSecret: credentialName.default('DISCORD_BOT_TOKEN'),
  apiBase: z.string().url().optional(),
}).merge(ChannelPolicySchema).strict();
export const SlackChannelSchema = z.object({
  id: channelId.default('slack'),
  type: z.literal('slack'),
  /** The bot token (xoxb-...), which sends the replies. */
  tokenSecret: credentialName.default('SLACK_BOT_TOKEN'),
  /** The app-level token (xapp-...), which opens the connection. */
  appTokenSecret: credentialName.default('SLACK_APP_TOKEN'),
  /** When given, only these Slack channel ids are answered. */
  slackChannels: z.array(z.string().min(1).max(64)).max(64).default([]),
  apiBase: z.string().url().optional(),
}).merge(ChannelPolicySchema).strict();
export const WhatsAppChannelSchema = z.object({
  id: channelId.default('whatsapp'),
  type: z.literal('whatsapp'),
  /** The number the business sends from, shown in the WhatsApp Manager. */
  phoneNumberId: z.string().min(1).max(64),
  tokenSecret: credentialName.default('WHATSAPP_TOKEN'),
  /** The word WhatsApp is told to check the web address with. */
  verifyTokenSecret: credentialName.default('WHATSAPP_VERIFY_TOKEN'),
  /** The app secret WhatsApp signs every message with. */
  appSecretSecret: credentialName.default('WHATSAPP_APP_SECRET'),
  apiBase: z.string().url().optional(),
}).merge(ChannelPolicySchema).strict();
export const EmailChannelSchema = z.object({
  id: channelId.default('email'),
  type: z.literal('email'),
  address: z.string().email(),
  imap: mailServer,
  smtp: mailServer,
  /** Name of the environment variable or locker secret holding the mailbox password. */
  passwordSecret: credentialName.default('EMAIL_PASSWORD'),
  /** How often to look for new mail, in seconds. */
  pollSeconds: z.number().int().min(5).max(3600).default(60),
}).merge(ChannelPolicySchema).strict();
/**
 * Every team-chat service that works the same way: a row in `data/channels.json` says how it sends
 * and how it proves a post is genuine, and this says which of that service's things the owner saved.
 */
export const WebhookChatChannelSchema = z.object({
  id: channelId,
  type: z.literal('chat'),
  /** Which row of the service list to use, for example "mattermost". */
  service: z.string().regex(/^[a-z][a-z0-9-]{1,29}$/),
  /** The incoming webhook address the owner pasted, for the services that send that way. */
  webhookUrlSecret: credentialName.optional(),
  /** The access token, for the services with a proper API. */
  tokenSecret: credentialName.optional(),
  /** The shared word or signing key the service proves itself with. */
  secretSecret: credentialName.optional(),
  /** The service's own address, for the ones hosted per company (Zulip, Mattermost). */
  apiBase: z.string().url().optional(),
  /** What the bot is called, so a mention of it can be spotted in a group. */
  botName: z.string().min(1).max(60).optional(),
}).merge(ChannelPolicySchema).strict();
/** Facebook Messenger and Instagram direct messages, which share WhatsApp's webhook and send shape. */
const metaMessagingFields = {
  id: channelId,
  /** The page or professional account the assistant answers as. */
  pageId: z.string().min(1).max(64),
  tokenSecret: credentialName.default('META_PAGE_TOKEN'),
  verifyTokenSecret: credentialName.default('META_VERIFY_TOKEN'),
  appSecretSecret: credentialName.default('META_APP_SECRET'),
  apiBase: z.string().url().optional(),
};
export const MessengerChannelSchema = z.object({ ...metaMessagingFields, type: z.literal('messenger') }).merge(ChannelPolicySchema).strict();
export const InstagramChannelSchema = z.object({ ...metaMessagingFields, type: z.literal('instagram') }).merge(ChannelPolicySchema).strict();
export const MatrixChannelSchema = z.object({
  id: channelId.default('matrix'),
  type: z.literal('matrix'),
  homeserver: z.string().url(),
  /** The assistant's own Matrix user id, so it does not answer itself. */
  userId: z.string().min(3).max(120),
  tokenSecret: credentialName.default('MATRIX_ACCESS_TOKEN'),
  syncSeconds: z.number().int().min(5).max(120).default(30),
}).merge(ChannelPolicySchema).strict();
export const SignalChannelSchema = z.object({
  id: channelId.default('signal'),
  type: z.literal('signal'),
  /** Full path to the signal-cli program you installed. Nothing is downloaded. */
  path: z.string().min(3).max(400),
  /** The registered number, in +country form. */
  account: z.string().min(5).max(20),
}).merge(ChannelPolicySchema).strict();
export const ChannelConfigSchema = z.discriminatedUnion('type', [
  TelegramChannelSchema, DiscordChannelSchema, SlackChannelSchema, WhatsAppChannelSchema, EmailChannelSchema,
  WebhookChatChannelSchema, MessengerChannelSchema, InstagramChannelSchema, MatrixChannelSchema, SignalChannelSchema,
  // Checked here, but typed as nothing: the launcher never looks inside one, it hands it on whole.
  ParityChannelSchema as never,
]).superRefine((value, context) => {
  if (value.type === 'telegram' && !value.tokenEnv === !value.tokenSecret)
    context.addIssue({ code: 'custom', message: 'Give exactly one of tokenEnv or tokenSecret' });
});
export interface ChannelHost { router: ChannelRouter; secret: (name: string) => Promise<string>; web?: WebAccess; hooks?: Hooks; context?: (runId: string) => ToolContext;
  /** mac6/bucket-16: Slack's own events, for the automations they start. */
  slackEvents?: (channelId: string, event: unknown, botUserId: string | null) => void;
  /** Version control on this computer, so the remote and GitHub tools can be switched on here. */
  git?: GitTools; activeSecret?: (name: string) => Promise<string>;
  /** The workspace, so the browser can send a file to a website and keep one it sends back. */
  files?: WorkspacePaths;
  /** Where screenshots and saved pages are kept, beside the private database. */
  artifacts?: RunArtifacts;
  /** Saved browser sign-ins, encrypted with the device's locker key. */
  browserProfiles?: BrowserProfiles;
  /** When outside servers are started, and where their last tool list is kept. */
  mcp?: McpHost;
  /**
   * The two halves of the shared "look at this, press that" tools. The window half is always
   * there; the page half is filled in here once a browser turns out to be configured.
   */
  computer?: { page?: unknown };
  /** Settings and spans, so the browser can read the "use my browser" switch and record healing. */
  store?: unknown; tracer?: unknown;
  /** Wave mac2 (guards): false when the integrations file sits in a workspace folder the owner has not trusted. */
  configTrusted?: (path: string) => boolean;
  /** Told which sections of the integrations file this load left out (none when it was used), for the launch-file card. */
  leftOut?: (sections: readonly LaunchSection[]) => void;
  /** Things to let go of when Branch locks itself, such as a browser of the owner's it had borrowed. */
  onLock?: (release: () => Promise<unknown>) => void;
  /** The owner's own MCP servers, kept in the store (src/mcp-own-servers.ts); started with the launch file's. */
  ownMcp?: { startSaved(launchIds: readonly string[]): Promise<void>; closeAll(): Promise<void> };
  /** The command-line tools the owner allowed (src/own-clis.ts), handed to the shell for each command. */
  ownClis?: { attach(shell: { extra: () => Record<string, { path: string; args: string[] }> }, launchNames: readonly string[]): void } }

/** Sending work to a server is off until the owner turns it on; GitHub needs a saved token too. */
export const GitConfigSchema = z.object({
  remote: z.boolean().default(false),
  github: GitHubConfigSchema.partial().optional(),
  /** bucket-18: GitHub App (A2227). Exchange private key for installation tokens instead of personal access token. */
  githubApp: GitHubAppSettingsSchema.optional(),
  /** Reading issues, releases and pipelines from GitLab; needs its own saved token. */
  gitlab: GitLabConfigSchema.partial().optional(),
}).strict();

/** Where the person's issues live. Each tracker is off until it is named here with a saved key. */
export const IssuesConfigSchema = z.object({
  github: z.boolean().default(false),
  linear: LinearConfigSchema.partial().optional(),
  // bucket-18 (A0174): read GitLab issues with the GitLab settings under "git", and Jira issues from the owner's site.
  gitlab: z.boolean().default(false),
  jira: JiraConfigSchema.optional(),
}).strict();

const ConfigSchema = z.object({ mcp: z.array(McpConfigSchema).max(8).default([]),
  browser: BrowserConfigSchema.optional(), shell: ShellConfigSchema.optional(),
  channels: z.array(ChannelConfigSchema).max(8).default([]), web: WebConfigSchema.optional(),
  git: GitConfigSchema.optional(),
  issues: IssuesConfigSchema.optional(),
  hooks: z.array(HookSchema).max(16).default([]) }).strict();
/** R17-S14: the whole launch settings file, so the Settings card can check a change before writing it. */
export const LaunchFileSchema = ConfigSchema;

type LaunchConfig = z.infer<typeof ConfigSchema>;
/**
 * Every section of the integrations file, with the words the owner is told it by when it is left
 * out. Typed against the schema, so a section added later has to be named here too.
 */
const sectionWords: Record<keyof LaunchConfig, string> = {
  web: 'web and network settings', channels: 'chat apps', mcp: 'AI tool servers', hooks: 'hooks',
  browser: 'browser settings', shell: 'command settings', git: 'git settings', issues: 'issue trackers',
};
export type LaunchSection = keyof LaunchConfig;
/** The sections, in the order the owner is told about them; the launch-file card names each one. */
export const launchSections: readonly LaunchSection[] = Object.freeze(Object.keys(sectionWords) as LaunchSection[]);

/**
 * An integrations file that sits in a workspace folder the owner has not trusted is not used at
 * all, because every section can change where Branch connects, what it runs or what it allows:
 * the network rules, chat apps, AI tool servers and hooks, and also the browser (its sites and
 * what it may save), commands (their programs, limits and environment), and git and the issue
 * trackers (the servers they connect to). This names the sections the file sets, once, in one
 * line; the launch-file card shows the same list.
 */
function noteLeftOut(config: LaunchConfig, path: string): LaunchSection[] {
  const left = launchSections.filter(section => {
    const value = config[section];
    return Array.isArray(value) ? value.length > 0 : value !== undefined;
  });
  if (left.length) {
    const words = left.map(section => sectionWords[section]);
    const named = words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words.at(-1)}` : words[0];
    console.warn(`Branch did not use the ${named} listed in ${path}: that folder is not trusted. Trust it in Settings, Permissions, then restart Branch.`);
  }
  return left;
}

/**
 * The settings loadIntegrations goes on with. With no settings file, the programs installed on this computer are
 * still there to run (dogfood A2, src/integrations/default-shell.ts), except any in the workspace the launch's tasks
 * work in; null when there is nothing at all to set up.
 */
async function readConfig(path: string | undefined, env: NodeJS.ProcessEnv, channels?: ChannelHost): Promise<z.infer<typeof ConfigSchema> | null> {
  if (!path) {
    const workspace = channels?.context?.('bootstrap').workspace;
    const shell = defaultShellConfig(env, process.platform, workspace ? [workspace] : []);
    return shell ? ConfigSchema.parse({ shell }) : null;
  }
  const info = await stat(path);
  if (!info.isFile() || info.size > 65536) throw new Error('Integration config must be a file of at most 64 KiB');
  const listed = ConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  // Wave mac2 (guards): a file in a folder the owner has not trusted sets up nothing at all. What
  // goes on from here is an empty file, so nothing below can read one of its sections by mistake.
  const trusted = channels?.configTrusted?.(path) ?? true;
  channels?.leftOut?.(trusted ? [] : noteLeftOut(listed, path));
  return trusted ? listed : ConfigSchema.parse({});
}

export async function loadIntegrations(registry: ToolRegistry, path?: string, env = process.env, secrets?: SecretResolver, channels?: ChannelHost) {
  const closers: (() => Promise<void>)[] = [];
  /** The live browser, when one is configured, so Settings can offer the sign-in-once window. */
  const hosted: {
    browser?: BranchBrowser; issues?: IssueAccess;
    /** Batch 26 (wave 8): what the firewall card reads back — the sites the browser may open, and
     * whether host commands are pointed at a dead address. Both are launch settings, not stored ones. */
    browserOrigins?: string[]; commandsNetless?: boolean;
  } = {};
  const before = new Set(registry.names());
  const close = async () => {
    for (const name of registry.names()) if (!before.has(name)) registry.unregister(name);
    const results = await Promise.allSettled(closers.map(stop => stop()));
    const errors = results.filter(result => result.status === 'rejected');
    if (errors.length) throw new Error(`Failed to close ${errors.length} integration(s)`);
  };
  const config = await readConfig(path, env, channels);
  // The owner's own servers start whether or not there is a launch file, after its network settings, and their ids
  // never take one of the file's. The app closes them itself (OwnMcpServers.closeAll), so they are not counted here.
  const own = channels?.ownMcp;
  if (!config) { if (own) await own.startSaved([]); return { close, count: 0, hosted }; }
  if (config.web) channels?.web?.configure(config.web);
  if (own) await own.startSaved(config.mcp.map(server => McpConfigSchema.parse(server).id));
  const policy = channels?.web?.policy;
  if (new Set(config.mcp.map(server => server.id)).size !== config.mcp.length)
    throw new Error('MCP server IDs must be unique');
  try {
    for (const server of config.mcp) {
      const stop = await startMcp(registry, server, env, policy, channels?.mcp);
      if (stop) closers.push(stop);
    }
    if (config.browser) {
      const browser = new BranchBrowser(config.browser);
      browser.policy = policy;
      browser.files = channels?.files;
      browser.artifacts = channels?.artifacts;
      browser.profiles = channels?.browserProfiles;
      browser.store = channels?.store as never;
      browser.tracer = channels?.tracer as never;
      // w911 (A2019) hook: the browser sandbox; its settings are read when a task first opens a page.
      if (channels?.store) { const kept = channels.store as Store; browser.sandbox = new BrowserSandbox(kept, () => kept.secrets); }
      // The quirks of particular websites live in the skills the owner installed, not in the
      // browser tool, so they are read fresh each time: installing a skill needs no restart.
      const skillStore = channels?.store as SiteSkillSource | undefined;
      if (skillStore) browser.siteSkills = owner => siteSkillsFor(skillStore, owner);
      // The page half of the shared "look at this, press that" tools is this browser.
      if (channels?.computer) channels.computer.page = browser;
      // Locking Branch gives back any browser of the owner's a task had borrowed, so a locked
      // Branch is never still holding the door to their signed-in windows open.
      channels?.onLock?.(() => browser.releaseBorrowed());
      hosted.browser = browser;
      hosted.browserOrigins = [...config.browser.allowedOrigins];
      registerBrowser(registry, browser); closers.push(() => browser.close());
      // ── mac7/vault-autofill (R17-068): the owner's saved sign-ins, filled straight into the page.
      // It ships off; with no browser there is nothing to fill, so it is registered only here.
      const signInStore = channels?.store as Store | undefined, signInOwner = channels?.context?.('bootstrap').owner;
      if (signInStore && signInOwner) {
        const resolver = new CredentialResolver(signInStore, signInOwner, signInStore.secrets.scrubber);
        resolver.gate = () => signInStore.secrets.gate(); // the same unlock the locker waits for
        registerVaultAutofill(registry, new VaultAutofill({
          store: signInStore, owner: signInOwner, page: browser.signInPage(),
          read: (reference, use) => resolver.read(reference, use),
          requireOwner: (what) => signInStore.profiles.requireOwner(what),
        }));
      }
    }
    let shell: BranchShell | undefined;
    if (config.shell) {
      hosted.commandsNetless = config.shell.netless === true;
      // mac7/r17-d: with "Using your own command-line setup" on, commands get the owner's login PATH (src/coding/shell-snapshot.ts).
      const loginStore = channels?.store as Store | undefined, loginOwner = channels?.context?.('bootstrap').owner;
      if (loginStore && loginOwner) config.shell = withLoginPath(config.shell, loginStore, loginOwner);
      const created = new BranchShell(config.shell, env, secrets);
      shell = created;
      // R17-S10: the owner's command timeout and extra environment names, read for each command.
      const tunedStore = channels?.store as Store | undefined, tunedOwner = channels?.context?.('bootstrap').owner;
      if (tunedStore && tunedOwner) created.tuning = () => commandTuning(tunedStore, tunedOwner, env);
      await created.ready();
      registerShell(registry, created); closers.push(() => created.close());
      channels?.ownClis?.attach(created, Object.keys(config.shell.executables));
      // A command line the owner can keep open, from the very same list of programs. It is closed
      // with everything else here, so nothing it started outlives the app.
      const store = channels?.store as Store | undefined;
      const owner = channels?.context?.('bootstrap').owner;
      if (store && owner) {
        const kept = new ShellSessions(config.shell, store, owner, env);
        registerShellSessions(registry, kept); closers.push(() => kept.closeAll());
      }
    }
    if (config.git) enableGit(registry, config.git, channels, policy);
    if (config.issues) hosted.issues = enableIssues(registry, config.issues, config.git, channels, policy);
    const hookShell = shell;
    if (config.hooks.length) {
      if (!hookShell || !channels?.hooks || !channels.context) throw new Error('Hooks need the shell integration (their executables come from it) and a launch that can host them');
      const runner: HookRunner = hookRunner(hookShell, channels.context);
      channels.hooks.configure(config.hooks, runner);
    }
    if (config.channels.length && !channels) throw new Error('Channels are configured but this launch cannot host them');
    if (new Set(config.channels.map(channel => channel.id)).size !== config.channels.length) throw new Error('Channel ids must be unique');
    for (const channel of config.channels) {
      const adapter = await buildChannel(channel, env, channels!, policy);
      await channels!.router.attach(adapter, { activation: channel.activation, pairing: channel.pairing, allowlist: channel.allowlist });
      closers.push(() => adapter.stop());
    }
    return { close, count: closers.length, hosted };
  } catch (error) { await close().catch(() => undefined); throw error; }
}

/**
 * Starting one outside MCP server, the way the owner's "when to connect" setting says.
 *
 * **startup** (what has always happened, and still the default) opens it now and puts its tools in
 * the list. **on-demand** puts its tools in the list from what that server said the last time it
 * was connected and opens nothing; the connection is made the first time a task really calls one
 * of them, through the same manager that keeps it warm, caps how many are open and retries a
 * server that will not answer. Either way the tools are there to be found from the first moment,
 * which is the point: a tool that is not in the list might as well not exist.
 *
 * A server on demand that has never been connected has no list to show, so it is connected now —
 * once — rather than being silently missing.
 */
export async function startMcp(
  registry: ToolRegistry, server: unknown, env: NodeJS.ProcessEnv,
  policy: NetworkPolicy | undefined, host: McpHost | undefined,
): Promise<(() => Promise<void>) | null> {
  const guard = policy ? { guard: (base: typeof fetch) => policy.guard(base) } : undefined;
  // mac3/security-check: a server fetched from a package registry is looked up in the malware list
  // before it is added, and again before it is opened later (src/security-audit/malware-check.ts).
  // With no checker this adds nothing.
  const vet = () => vetLaunch(server, host);
  await vet();
  const connect = () => connectMcp(registry, server, env, guard, host?.cache, host?.startupTimeoutMs?.()); // R17-S20
  if (!host || host.connectWhen() !== 'on-demand') {
    const connection = await connect();
    return connection.close;
  }
  const id = McpConfigSchema.parse(server).id;
  // Opening it puts nothing in the tool list — the tools are already there — so `openMcp`, not
  // `connectMcp`: the same connection, without a second registration to collide with the first.
  host.connections.register(id, () => vet().then(() => openMcp(server, env, guard, host.cache, host.startupTimeoutMs?.()))); // R17-S20
  const names = registerCachedMcp(registry, server, host.cache.read(id), async () => {
    // Opened through the manager, so keep-warm, the cap and the retries all apply to it. What it
    // says its tools are NOW, and the credentials it was opened with, travel back with it: the
    // first call is checked against the live shape, and anything echoed back has them taken out.
    const opened = await host.connections.acquire(`mcp:${id}`, id) as unknown as LiveMcp & { found?: LiveMcp['tools'] };
    return { call: opened.call, ...(opened.secrets ? { secrets: opened.secrets } : {}),
      ...(opened.found ? { tools: opened.found } : {}) };
  });
  if (!names.length) {
    const connection = await connect();
    return connection.close;
  }
  return async () => { for (const name of names) registry.unregister(name); };
}
/** mac3/security-check: asks the malware check about a server started from a package, if there is one. */
async function vetLaunch(server: unknown, host: McpHost | undefined): Promise<void> {
  if (!host?.vetLaunch) return;
  const config = McpConfigSchema.parse(server);
  if (config.transport === 'stdio') await host.vetLaunch(config.command, config.args);
}
/** What `loadIntegrations` needs to run outside servers on demand rather than at startup. */
export interface McpHost {
  connectWhen(): 'startup' | 'on-demand';
  /** mac3/security-check: throws a plain sentence for a package listed as malware. */
  vetLaunch?: (command: string, args: readonly string[]) => Promise<void>;
  cache: McpToolCache;
  /** R17-S20: how long a server may take to start, in milliseconds; unset keeps 10 seconds. */
  startupTimeoutMs?: () => number;
  connections: { register(id: string, opener: () => Promise<{ close(): Promise<void> }>): void;
    acquire(runId: string, id: string): Promise<{ close(): Promise<void> }>;
    /** Forgets a server the owner switched off or removed (src/mcp-own-servers.ts). */
    forget?(id: string): Promise<void> };
}

type ChannelConfig = z.infer<typeof ChannelConfigSchema>;

/**
 * Finds one credential: an environment variable of that name first, then a secret of that name in
 * the default project's locker. The value is never written anywhere, only handed to the adapter.
 */
async function credential(name: string, env: NodeJS.ProcessEnv, host: ChannelHost): Promise<string> {
  const value = env[name] ?? await host.secret(name).catch(() => undefined);
  if (!value) throw new Error(`Set ${name} as an environment variable, or save a secret called ${name} in the default project.`);
  return value;
}
/** Every outbound call a channel makes is checked against the network settings first. */
function guardedSocket(policy: NetworkPolicy | undefined): WebSocketConnect | undefined {
  if (!policy) return undefined;
  return async (address, options) => {
    await policy.assertAllowed(new URL(address.replace(/^ws/, 'http')), 'chat service address');
    return connectWebSocket(address, options);
  };
}

/** Builds the adapter one configured channel asks for, with its secrets and network guards. */
async function buildChannel(channel: ChannelConfig, env: NodeJS.ProcessEnv, host: ChannelHost, policy: NetworkPolicy | undefined): Promise<ChannelAdapter> {
  // Wave mac3 (channels-parity): IRC, XMPP, Mastodon and the rest are built in their own files.
  if (isParityChannel(channel)) return buildParityChannel(channel as unknown as ParityChannelConfig, { credential: (name) => credential(name, env, host),
    policy, store: host.store, owner: host.context?.('bootstrap').owner });
  const guardedFetch = policy ? policy.guard(globalThis.fetch) : globalThis.fetch;
  const connect = guardedSocket(policy);
  const base = 'apiBase' in channel && channel.apiBase ? { apiBase: channel.apiBase } : {};
  if (channel.type === 'chat') return buildWebhookChat(channel, env, host, guardedFetch);
  if (channel.type === 'messenger' || channel.type === 'instagram')
    return new MetaMessagingAdapter({ id: channel.id, service: channel.type, pageId: channel.pageId,
      token: await credential(channel.tokenSecret, env, host), verifyToken: await credential(channel.verifyTokenSecret, env, host),
      appSecret: await credential(channel.appSecretSecret, env, host), fetch: guardedFetch, ...base });
  if (channel.type === 'matrix') {
    await policy?.assertAllowed(new URL(channel.homeserver), 'Matrix home server');
    const mark = channelMark(host.store, channel.id, host.context?.('bootstrap').owner); // mac6/bucket-16: catch up after a restart
    return new MatrixAdapter({ id: channel.id, homeserver: channel.homeserver, userId: channel.userId,
      accessToken: await credential(channel.tokenSecret, env, host), syncTimeoutMs: channel.syncSeconds * 1000, fetch: guardedFetch,
      ...(mark ? { mark } : {}) });
  }
  if (channel.type === 'signal') return new SignalAdapter({ id: channel.id, path: channel.path, account: channel.account });
  if (channel.type === 'telegram') {
    const token = channel.tokenEnv ? env[channel.tokenEnv] : await host.secret(channel.tokenSecret!);
    if (!token) throw new Error(`Channel ${channel.id} has no bot token; set ${channel.tokenEnv ?? channel.tokenSecret}`);
    // Same guard as Discord and WhatsApp: every call Telegram makes — sending a reply and
    // fetching a voice note — is checked against the network settings first, so a made-up
    // apiBase cannot be used to reach somewhere the owner never allowed.
    // mac3/never-break: the read position is kept, so messages sent during a restart are answered.
    const position = channelPosition(host.store, channel.id);
    return new TelegramAdapter({ id: channel.id, token, fetch: guardedFetch, ...base, ...(position ? { position } : {}) });
  }
  if (channel.type === 'discord')
    return new DiscordAdapter({ id: channel.id, token: await credential(channel.tokenSecret, env, host),
      fetch: guardedFetch, ...(connect ? { connect } : {}), ...base });
  if (channel.type === 'slack')
    return new SlackAdapter({ id: channel.id, token: await credential(channel.tokenSecret, env, host),
      appToken: await credential(channel.appTokenSecret, env, host), fetch: guardedFetch,
      ...(connect ? { connect } : {}), ...(channel.slackChannels.length ? { channels: channel.slackChannels } : {}), ...base,
      ...(host.slackEvents ? { onEvent: (event: unknown, bot: string | null) => host.slackEvents!(channel.id, event, bot) } : {}) }); // mac6/bucket-16
  if (channel.type === 'whatsapp')
    return new WhatsAppAdapter({ id: channel.id, phoneNumberId: channel.phoneNumberId,
      token: await credential(channel.tokenSecret, env, host), verifyToken: await credential(channel.verifyTokenSecret, env, host),
      appSecret: await credential(channel.appSecretSecret, env, host), fetch: guardedFetch, ...base });
  return buildEmail(channel, env, host, policy);
}
/**
 * One of the services in `data/channels.json`. Which of the three saved things it needs comes from
 * that row, so a service that wants only a webhook address is not asked for a token as well.
 */
async function buildWebhookChat(
  channel: Extract<ChannelConfig, { type: 'chat' }>, env: NodeJS.ProcessEnv, host: ChannelHost, guardedFetch: typeof fetch,
): Promise<ChannelAdapter> {
  const entry = channelEntry(channel.service);
  if (!entry) throw new Error(`There is no chat service called ${channel.service}. See docs/configuration.md for the list.`);
  return new WebhookChatAdapter({
    id: channel.id, entry, fetch: guardedFetch,
    ...(channel.webhookUrlSecret ? { webhookUrl: await credential(channel.webhookUrlSecret, env, host) } : {}),
    ...(channel.tokenSecret ? { token: await credential(channel.tokenSecret, env, host) } : {}),
    ...(channel.secretSecret ? { secret: await credential(channel.secretSecret, env, host) } : {}),
    ...(channel.apiBase ? { apiBase: channel.apiBase } : {}),
    ...(channel.botName ? { botName: channel.botName } : {}),
  });
}

/** Mail uses its own encrypted sockets, so its two servers are checked against the policy by name. */
async function buildEmail(channel: Extract<ChannelConfig, { type: 'email' }>, env: NodeJS.ProcessEnv, host: ChannelHost, policy: NetworkPolicy | undefined): Promise<ChannelAdapter> {
  const password = await credential(channel.passwordSecret, env, host);
  for (const server of [channel.imap, channel.smtp])
    await policy?.assertAllowed(new URL(`https://${server.host}`), 'mail server');
  return new EmailAdapter({ id: channel.id, address: channel.address, pollMs: channel.pollSeconds * 1000,
    imap: { ...channel.imap, password }, smtp: { ...channel.smtp, password } });
}

/** Turns on the tools that reach a server: sending and receiving work, and GitHub when set up. */
function enableGit(registry: ToolRegistry, config: z.infer<typeof GitConfigSchema>, host: ChannelHost | undefined, policy: NetworkPolicy | undefined): void {
  if (!host?.git) throw new Error('Version control settings are configured but this launch cannot host them');
  if (config.remote) registerGitRemote(registry, host.git);
  if (config.gitlab) enableGitLab(registry, config.gitlab, host, policy);
  if (!config.github) return;
  if (!policy || !host.activeSecret) throw new Error('GitHub needs the network settings and the secrets locker');
  const secret = host.activeSecret;

  // bucket-18: GitHub App (A2227): the owner's own app when switched on, the personal token otherwise.
  const github = GitHubConfigSchema.parse(config.github);
  const personal: TokenSource = async () => {
    const value = await secret(github.tokenSecret).catch(() => '');
    if (!value) throw new Error(`Connect GitHub first: save a secret called ${github.tokenSecret} in the active project holding a GitHub personal access token.`);
    return value;
  };
  const tokenSource = chooseGitHubTokenSource(config.githubApp, personal, policy, secret, { apiBase: github.apiBase });
  registerGitHub(registry, new GitHubAccess(config.github, policy, tokenSource), host.git);
}

/** Reading from GitLab; the token comes out of the active project's secrets at the moment of a call. */
function enableGitLab(registry: ToolRegistry, settings: unknown, host: ChannelHost, policy: NetworkPolicy | undefined): void {
  if (!policy || !host.activeSecret) throw new Error('GitLab needs the network settings and the secrets locker');
  const secret = host.activeSecret, name = GitLabConfigSchema.parse(settings).tokenSecret;
  registerGitLab(registry, new GitLabAccess(settings, policy, async () => {
    const value = await secret(name).catch(() => '');
    if (!value) throw new Error(`Connect GitLab first: save a secret called ${name} in the active project holding a GitLab personal access token.`);
    return value;
  }));
}

/**
 * Turns on the issue tools. Each tracker needs its own saved key, taken out of the active
 * project's secrets the moment a request is made and never held anywhere else.
 */
function enableIssues(
  registry: ToolRegistry, config: z.infer<typeof IssuesConfigSchema>,
  git: z.infer<typeof GitConfigSchema> | undefined, host: ChannelHost | undefined, policy: NetworkPolicy | undefined,
): IssueAccess {
  if (!policy || !host?.activeSecret) throw new Error('The issue tools need the network settings and the secrets locker');
  const secret = host.activeSecret;
  const held = (name: string, tracker: string, what: string) => async () => {
    const value = await secret(name).catch(() => '');
    if (!value) throw new Error(`Connect ${tracker} first: save a secret called ${name} in the active project holding ${what}.`);
    return value;
  };
  const trackers: IssueTrackers = {};
  if (config.github) {
    const settings = GitHubConfigSchema.parse(git?.github ?? {});
    trackers.github = new GitHubAccess(settings, policy, held(settings.tokenSecret, 'GitHub', 'a GitHub personal access token'));
  }
  if (config.linear) {
    const settings = LinearConfigSchema.parse(config.linear);
    trackers.linear = new LinearAccess(settings, policy, held(settings.tokenSecret, 'Linear', 'a Linear API key'));
  }
  // bucket-18 (A0174): GitLab and Jira, read only, each with its own saved key.
  if (config.gitlab) {
    const settings = GitLabConfigSchema.parse(git?.gitlab ?? {});
    trackers.gitlab = new GitLabAccess(settings, policy, held(settings.tokenSecret, 'GitLab', 'a GitLab personal access token'));
  }
  if (config.jira) trackers.jira = new JiraAccess(config.jira, policy, secret);
  const access = new IssueAccess(trackers, host?.web);
  if (access.available().length) registerIssues(registry, access);
  return access;
}

/** Hooks run through the shell integration's declared executables; a busy shell is retried briefly, then counts as a failure. */
/** The last line a hook printed, read as a verdict; anything that is not one is simply nothing. */
function parseVerdict(printed: string): unknown {
  const line = printed.trim().split(/\r?\n/).at(-1)?.trim();
  if (!line?.startsWith('{')) return undefined;
  try { return JSON.parse(line); } catch { return undefined; }
}

function hookRunner(shell: BranchShell, context: (runId: string) => ToolContext): HookRunner {
  // The shell runs one host command at a time. Hooks for the same event fire together, so they take
  // turns here, and each waits for any task command still running before it starts.
  let turn: Promise<unknown> = Promise.resolve();
  return (hook, payload) => {
    const mine = turn.then(() => runHook(shell, context, hook, payload));
    turn = mine.catch(() => undefined);
    return mine;
  };
}

async function runHook(shell: BranchShell, context: (runId: string) => ToolContext, hook: HookConfig, payload: Record<string, unknown>): ReturnType<HookRunner> {
  const scoped = { ...context(String(payload.runId ?? '')), signal: AbortSignal.timeout(hook.timeoutMs + 1000) };
  for (;;) {
    try {
      await shell.whenIdle(scoped.signal);
      const result = await shell.execute({ executable: hook.executable, args: [...hook.args, JSON.stringify(payload).slice(0, 4000)], cwd: '.', secrets: [], timeoutMs: hook.timeoutMs }, scoped);
      // A check that can stop a call says so by printing {"decision":"ask","reason":"..."}.
      // Anything else it prints is ignored, so an ordinary notify-only hook behaves as before.
      return result.status === 'completed' ? { ok: true, verdict: parseVerdict(result.stdout) } : { ok: false, error: `${result.status}${result.stderr ? ': ' + result.stderr.slice(0, 200) : ''}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Another command started between the shell going quiet and this one asking: wait again.
      if (!/already active/.test(message) || scoped.signal.aborted) return { ok: false, error: message };
    }
  }
}
