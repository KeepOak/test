import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { Browser, ConnectOptions } from 'playwright';
import { chromium } from './playwright-lazy.js';
import { z } from 'zod';
import { FeatureModeSchema, optionalFields } from '../feature-switches.js';
import { isTailnetAddress } from '../remote/tailscale.js';
import type { Store } from '../store.js';

/**
 * w911 (A2019): the browser sandbox. With the switch on, the browser tools drive a Chromium that runs
 * somewhere other than this computer's own desktop session: in a Docker container started from the
 * official Playwright image, or on a Playwright server the owner runs elsewhere. Branch still makes
 * every decision about which pages may load: each task gets its own browser context, and the
 * website list is applied to every request of that context from this side of the connection.
 *
 * "When needed" means: a task that uses one of the owner's saved sign-ins (or borrows their own
 * browser, which never launches anything) stays on this computer, so those cookies never leave it;
 * every other task goes to the sandbox. "On" sends every task that launches a browser to the sandbox.
 */
export const settingsKey = 'browser-container';
export const tokenProject = 'default';
export const tokenName = 'BROWSER_CONTAINER_TOKEN';

/**
 * Integration review (adversarial): a Playwright server runs whatever is asked of it, and the token
 * that opens it travels on the connection itself. Plain `ws:` is therefore allowed only where the
 * wire is already the owner's own — this computer, or a private network they run: Tailscale's
 * 100.64.0.0/10 addresses and the `.ts.net` names that go with them. Everywhere else needs `wss:`.
 */
export function plainWsAllowed(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === 'ts.net' || host.endsWith('.ts.net')) return true;
  return isTailnetAddress(host);
}

const endpointSchema = z.string().trim().max(300).refine(value => {
  try {
    const url = new URL(value);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search) return false;
    return url.protocol === 'wss:' || plainWsAllowed(url.hostname);
  } catch { return false; }
}, 'The address must start with wss://, or with ws:// only for this computer or your own Tailscale network, '
  + 'and carry no name, password or ?key (put the key in the token box)');

export const BrowserContainerSchema = z.object({
  /** The three-way switch. Off: the browser runs on this computer exactly as before. */
  mode: FeatureModeSchema.default('off'),
  /** Where the sandbox browser runs: a Docker container on this computer, or a server elsewhere. */
  where: z.enum(['docker', 'endpoint']).default('docker'),
  /** The Playwright server's address, when `where` is "endpoint". */
  endpoint: endpointSchema.optional(),
}).strict();
export type BrowserContainer = z.infer<typeof BrowserContainerSchema>;

/**
 * What Settings may send: the settings above, plus the token (a string saves it, null removes it). Q65: a field
 * left out stays out, so saving the address alone no longer turns the switch off and the place back to Docker.
 */
export const BrowserContainerInputSchema = optionalFields(BrowserContainerSchema).extend({
  token: z.string().min(1).max(4000).nullable().optional(),
}).strict();

/** The saved settings; null when what is saved no longer makes sense (a refusal, never a silent local run). */
export function readBrowserContainer(store: Pick<Store, 'get'>, owner: string): BrowserContainer | null {
  const saved = BrowserContainerSchema.safeParse(store.get('settings', owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : null;
}

/** The one sentence every browser tool says when the sandbox cannot be used. */
export const sandboxRefusal = (reason: string): string =>
  `The browser sandbox cannot be used: ${reason} Check the browser sandbox setting, or switch it off.`;

/** The installed Playwright's version, read when it is needed; the Docker image must match it. */
export function playwrightVersion(): string {
  const version = (createRequire(import.meta.url)('playwright/package.json') as { version?: unknown }).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('the installed Playwright version could not be read.');
  return version;
}
export const dockerImage = (version: string): string => `mcr.microsoft.com/playwright:v${version}-noble`;
const containerPort = 3000;

/** The exact `docker run` argument list: no folders shared, no privileges, bound to this computer only. */
export function dockerRunArgs(image: string, version: string, hostPort: number): string[] {
  return ['run', '-d', '--rm', '--init', '--pull=never',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '2g', '--cpus', '2', '--shm-size', '1g',
    '-p', `127.0.0.1:${hostPort}:${containerPort}`,
    '--user', 'pwuser', '--workdir', '/home/pwuser',
    image, 'npx', '-y', `playwright@${version}`, 'run-server', '--port', String(containerPort), '--host', '0.0.0.0'];
}

/** Starts a program with an argument list (never a shell line), bounded by a time limit. */
export type ProgramRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>;
export const runProgram: ProgramRunner = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
    (error, stdout) => error ? reject(error) : resolve(String(stdout)));
});
/** True once something answers plain HTTP on the address (a Playwright server says "Running"). */
export type Prober = (port: number) => Promise<boolean>;
export const probeHttp: Prober = port => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
  .then(response => { void response.body?.cancel(); return true; }, () => false);
export type Connector = (wsEndpoint: string, options: ConnectOptions) => Promise<Browser>;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface DockerDeps {
  runner: ProgramRunner; probe: Prober; port: () => Promise<number>;
  version: () => string; waitMs: number; pauseMs: number;
}
export interface StartedContainer { wsEndpoint: string; id: string }

/** Checks the image is here, starts the container and waits (bounded) until its server answers. */
export async function startContainer(deps: DockerDeps): Promise<StartedContainer> {
  const version = deps.version(), image = dockerImage(version);
  try { await deps.runner('docker', ['image', 'inspect', image], 15_000); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(sandboxRefusal('Docker is not installed on this computer.'));
    throw new Error(sandboxRefusal(`the Playwright image is not on this computer. Run \`docker pull ${image}\` yourself first.`));
  }
  const port = await deps.port();
  let id = '';
  try { id = (await deps.runner('docker', dockerRunArgs(image, version, port), 30_000)).trim().split('\n').at(-1) ?? ''; }
  catch { throw new Error(sandboxRefusal('Docker could not start the container.')); }
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error(sandboxRefusal('Docker did not say which container it started.'));
  for (const until = Date.now() + deps.waitMs; Date.now() < until;) {
    if (await deps.probe(port)) return { wsEndpoint: `ws://127.0.0.1:${port}/`, id };
    await new Promise(resolve => setTimeout(resolve, deps.pauseMs));
  }
  await stopContainer(deps.runner, id);
  throw new Error(sandboxRefusal(`the container did not answer within ${Math.round(deps.waitMs / 1000)} seconds.`));
}
export const stopContainer = (runner: ProgramRunner, id: string): Promise<unknown> =>
  runner('docker', ['stop', id], 30_000).catch(() => undefined);

/** Why a connection failed, in our own words: nothing the other side or the library said is repeated. */
function connectReason(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  if (/\b(401|403)\b/.test(text)) return 'it turned the token down.';
  if (/timeout/i.test(text)) return 'it did not answer in time.';
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET/.test(text)) return 'nothing answered at that address.';
  return 'the connection failed.';
}
const safeAddress = (endpoint: string): string => { const url = new URL(endpoint); return `${url.protocol}//${url.host}`; };

/** Connects, then checks the other side really is a browser by asking its version. */
export async function connectEndpoint(connect: Connector, endpoint: string, token: string | undefined): Promise<Browser> {
  const where = safeAddress(endpoint);
  let browser: Browser;
  try {
    browser = await connect(endpoint, { timeout: 15_000, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) });
  } catch (error) { throw new Error(sandboxRefusal(`Branch could not connect to ${where}: ${connectReason(error)}`)); }
  const version = await Promise.race([Promise.resolve().then(() => browser.version()).catch(() => ''),
    new Promise<string>(resolve => setTimeout(() => resolve(''), 5000))]);
  if (typeof version !== 'string' || !version) {
    await Promise.resolve().then(() => browser.close()).catch(() => undefined);
    throw new Error(sandboxRefusal(`${where} did not answer as a browser.`));
  }
  return browser;
}

/** The locker, as far as the sandbox needs it. */
export interface TokenLocker {
  list(owner: string, project: string): { name: string }[];
  resolve(owner: string, project: string, names: string[], use: { purpose: string }): Promise<Record<string, string>>;
}
interface Running { browser: Browser; containerId: string | null }

/** One sandbox browser per owner, started on first use and closed with the browser tool. */
export class BrowserSandbox {
  runner: ProgramRunner = runProgram;
  probe: Prober = probeHttp;
  connect: Connector = async (endpoint, options) => (await chromium()).connect(endpoint, options);
  port: () => Promise<number> = freePort;
  version: () => string = playwrightVersion;
  waitMs = 90_000;
  pauseMs = 500;
  private readonly running = new Map<string, Promise<Running>>();
  constructor(private readonly store: Pick<Store, 'get'>, private readonly locker: () => TokenLocker) {}

  /** Null when this task runs on this computer as before; otherwise the sandbox browser (or a refusal). */
  pick(owner: string, usesSignIn: boolean): Promise<Browser> | null {
    const settings = readBrowserContainer(this.store, owner);
    if (!settings) return Promise.reject(new Error(sandboxRefusal('the saved setting is damaged; save it again.')));
    if (settings.mode === 'off' || (settings.mode === 'when-needed' && usesSignIn)) return null;
    return this.browser(owner, settings);
  }
  private async browser(owner: string, settings: BrowserContainer): Promise<Browser> {
    let started = this.running.get(owner);
    if (!started) {
      started = this.start(owner, settings);
      this.running.set(owner, started);
      started.catch(() => { if (this.running.get(owner) === started) this.running.delete(owner); });
    }
    const { browser } = await started;
    if (browser.isConnected()) return browser;
    if (this.running.get(owner) === started) this.running.delete(owner);
    throw new Error(sandboxRefusal('the connection to the sandbox browser was lost; try again.'));
  }
  private async start(owner: string, settings: BrowserContainer): Promise<Running> {
    if (settings.where === 'endpoint') {
      if (!settings.endpoint) throw new Error(sandboxRefusal('no server address is saved.'));
      return { browser: await connectEndpoint(this.connect, settings.endpoint, await this.token(owner)), containerId: null };
    }
    const container = await startContainer(this);
    try { return { browser: await connectEndpoint(this.connect, container.wsEndpoint, undefined), containerId: container.id }; }
    catch (error) { await stopContainer(this.runner, container.id); throw error; }
  }
  private async token(owner: string): Promise<string | undefined> {
    try {
      const locker = this.locker();
      if (!locker.list(owner, tokenProject).some(entry => entry.name === tokenName)) return undefined;
      const found = await locker.resolve(owner, tokenProject, [tokenName], { purpose: 'browser sandbox connection' });
      return found[tokenName];
    } catch { throw new Error(sandboxRefusal('the saved token could not be read (is Branch locked?).')); }
  }
  /** Closes every sandbox browser and stops every container this launch started. */
  async close(): Promise<void> {
    const all = [...this.running.values()];
    this.running.clear();
    for (const settled of await Promise.allSettled(all)) {
      if (settled.status !== 'fulfilled') continue;
      await settled.value.browser.close().catch(() => undefined);
      if (settled.value.containerId) await stopContainer(this.runner, settled.value.containerId);
    }
  }
}
