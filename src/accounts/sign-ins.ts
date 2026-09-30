import { spawn } from "node:child_process";
import { z } from "zod";
import { onPath } from "../asks/runtimes.js";
import { googleGeminiSignIn, registerSignedInGemini } from "../gemini-signin.js";
import type { OAuthConnections } from "../oauth.js";
import { accountHomeVariables, cliAgentCatalog, strippedEnvironment, type CliAgentRow } from "../providers/cli-agent.js";
import { lockdownActive, onLockdownChange } from "../lockdown.js";
import { geminiSignInState } from "../voice-api.js";
import { startCall } from "../windows-command.js";
import type { AccountsService } from "./service.js";
import { primaryAccount } from "./settings.js";
import { claudeIdentity } from "./identity.js";

/**
 * The sign-ins that could be made, before any of them is: the "Your plan" and "Coding assistants" choices of the
 * window's Add an account. `/api/accounts` lists only connections that exist, so on a fresh engine those choices had
 * nothing to show. This lists what the engine can sign in with, and holds no account, key or token:
 *
 *   chatgpt   the device-code sign-in of src/chatgpt-auth.ts (unofficial, labelled so), and whether it is signed in
 *   programs  each coding assistant Branch knows (src/providers/cli-agent.ts), whether it is on this computer's path
 *             (nothing is run to find out) and whether it is already a connection
 *   gemini    whether a Google sign-in client id is saved (src/gemini-signin.ts); without one Gemini takes a key
 *
 * Whether a program is signed in is asked separately (`checkProgram`), with the program's own documented status
 * command, because that starts the program. Branch never looks inside a program's folder.
 */
export interface SignInsHost {
  service: AccountsService;
  oauth?: OAuthConnections | undefined;
}

/**
 * The status command each maker documents, which exits 0 when signed in and 1 when not. Only these; a program with
 * none is never started to find out.
 * - Claude Code: `claude auth status` "Exits with code 0 if logged in, 1 if not" (https://code.claude.com/docs/en/cli-reference)
 * - Codex: `codex login status` "exit with 0 when logged in" (https://learn.chatgpt.com/docs/developer-commands?surface=cli)
 * Gemini CLI documents only its interactive /auth (https://geminicli.com/docs/reference/commands/), and Copilot CLI no
 * status command (https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).
 */
export const programStatusArgs: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["auth", "status"],
  codex: ["login", "status"],
};

/**
 * The sign-in command each maker documents, which opens the maker's own page in the browser and finishes by itself
 * through the program's own local callback. Branch starts it with no shell and asks the status command above until it
 * says signed in.
 * - Claude Code: `claude auth login` "Sign in to your Anthropic account" (https://code.claude.com/docs/en/cli-reference)
 * - Codex: `codex login` opens the ChatGPT sign-in in the browser (https://learn.chatgpt.com/docs/auth); it reads nothing
 *   typed into it (only `--with-api-key` and `--with-access-token` read their input), so it is given no input.
 */
export const programLoginArgs: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["auth", "login"],
  codex: ["login"],
};
const loginTimeoutMs = 10 * 60_000;

/**
 * A sign-in that can also be finished by hand: `claude auth login` prints "If the browser didn't open, visit: <address>"
 * and then reads one line, the code that address's page shows (as `code#state`). For these, and only these, Branch
 * reads that one address from what the program prints (nothing else it prints is kept), shows it in the window, and
 * forwards one pasted line. The address must be the maker's own sign-in page, found in the program itself:
 * https://platform.claude.com/oauth/authorize and https://claude.com/cai/oauth/authorize.
 */
const codeSignIns: Readonly<Record<string, { hosts: readonly string[]; path: RegExp }>> = {
  "claude-code": { hosts: ["platform.claude.com", "claude.com", "claude.ai", "console.anthropic.com"], path: /^(\/cai)?\/oauth\/authorize$/ },
};
/** How much of what a code sign-in prints is looked through for the address; the rest is read and dropped. */
const printedLimit = 64 * 1024;

/** The maker's sign-in address in one printed line, or null: https, one of its hosts and paths, no user or password. */
export function signInAddress(id: string, line: string): string | null {
  const rule = codeSignIns[id];
  // Colours and terminal links are taken out first; a terminal link keeps its visible text, which is the address.
  const plain = line.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
  const found = /visit: (https:\/\/\S+)/.exec(plain)?.[1];
  if (!rule || !found || found.length > 4096) return null;
  try {
    const url = new URL(found);
    const ok = url.protocol === "https:" && !url.username && !url.password && !url.port && rule.hosts.includes(url.hostname) && rule.path.test(url.pathname);
    return ok ? url.href : null;
  } catch { return null; }
}
/** One pasted code: one line of printable characters, `code#state`, as `claude auth login` reads it. */
const PastedCode = z.string().regex(/^[\x21\x22\x24-\x7e]{1,2048}#[\x21\x22\x24-\x7e]{1,2048}$/);

/**
 * A sign-in program Branch started, one per program and account, until it ends; each engine keeps its own. `url` is the
 * maker's page for finishing by hand and `send` forwards one line to the program, for a code sign-in only.
 */
interface Login { stop: () => void; failed: string | null; running: boolean; url: string | null; expiresAt: string; send: ((line: string) => boolean) | null }
const loginsOf = new WeakMap<AccountsService, Map<string, Login>>();
function logins(host: SignInsHost): Map<string, Login> {
  let map = loginsOf.get(host.service);
  if (!map) loginsOf.set(host.service, map = new Map());
  return map;
}
const loginKey = (id: string, account: string | undefined): string => `${id}:${account ?? primaryAccount}`;

/** A started sign-in program: `stop` ends it, `send` (a code sign-in only) writes one line to it and says whether it could. */
export interface LoginChild { stop: () => void; send: ((line: string) => boolean) | null }
export type StartLogin = (row: CliAgentRow, args: readonly string[], env: NodeJS.ProcessEnv,
  done: (code: number | null, missing: boolean) => void, heard?: (line: string) => void) => LoginChild;

/**
 * Starts the program's own sign-in, with no shell and no window of its own. Without `heard` it is given no input and
 * what it prints is not read. With `heard` (a code sign-in) its input stays open for one pasted line, and each line it
 * prints within `printedLimit` is handed to `heard`; past that it is read and dropped, so the program never stalls.
 */
export const startLogin: StartLogin = (row, args, env, done, heard) => {
  const start = startCall(row.command, [...args], env);
  const child = spawn(start.command, start.args, { stdio: [heard ? "pipe" : "ignore", heard ? "pipe" : "ignore", "ignore"], windowsHide: true, shell: false, env });
  child.on("error", (error: NodeJS.ErrnoException) => done(1, error.code === "ENOENT"));
  child.on("close", (code) => done(code, false));
  if (!heard) return { stop: () => { child.kill(); }, send: null };
  let printed = 0, partial = "", open = true;
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    if (printed >= printedLimit) return;
    printed += chunk.length;
    const lines = (partial + chunk).split("\n");
    partial = lines.pop()!.slice(-4096);
    for (const line of lines) heard(line);
  });
  // A program that has ended closes its input; writing then fails, which ends the forwarding, not the engine.
  child.stdin?.on("error", () => { open = false; });
  child.on("close", () => { open = false; });
  const send = (line: string): boolean => {
    if (!open || !child.stdin?.writable) return false;
    child.stdin.write(`${line}\n`);
    return true;
  };
  return { stop: () => { open = false; child.stdin?.end(); child.kill(); }, send };
};

export async function signInOptions(host: SignInsHost) {
  const { models, chatgpt, store, owner } = host.service.deps;
  const status = chatgpt ? await chatgpt.status() : null;
  const programs = await Promise.all(cliAgentCatalog.map(async (row) => ({
    id: row.id, pool: `cli-${row.id}`, name: row.name, label: plainName(row), note: row.note, command: row.command, terms: row.terms ?? null,
    installed: await onPath(row.command), connected: models.presets.has(`cli-${row.id}`), canCheck: !!programStatusArgs[row.id],
  })));
  const gemini = geminiSignInState(store, owner, models);
  return {
    chatgpt: status
      ? { available: true, signedIn: status.signedIn, pending: !!status.pending, lastError: status.lastError }
      : { available: false, signedIn: false, pending: false, lastError: null },
    programs,
    gemini: { signInSetUp: !!gemini.settings.clientId && !!host.oauth, connected: gemini.connected, note: gemini.note },
  };
}

const CheckSchema = z.object({
  id: z.string().min(1).max(64),
  /** One of the program's accounts in the list; absent means its usual sign-in. */
  account: z.string().regex(/^(primary|[a-f0-9]{8})$/).optional(),
}).strict();

type Ran = { code: number | null; missing: boolean; stdout?: string };
export type RunStatus = (row: CliAgentRow, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<Ran>;

/** Reads bounded status output with no shell; only its identity whitelist is returned to a screen. */
export const runStatus: RunStatus = (row, args, env) => new Promise((resolve) => {
  const start = startCall(row.command, [...args], env);
  const child = spawn(start.command, start.args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: false, env });
  let stdout = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout = (stdout + chunk).slice(0, 32 * 1024 + 1); });
  let settled = false;
  const finish = (value: Ran): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
  const timer = setTimeout(() => { child.kill(); finish({ code: null, missing: false }); }, 20_000);
  timer.unref?.();
  child.on("error", (error: NodeJS.ErrnoException) => finish({ code: 1, missing: error.code === "ENOENT" }));
  child.on("close", (code) => finish({ code, missing: false, stdout }));
});

/** Whether one program is on this computer and signed in, in plain words, for its usual sign-in or one account's folder. */
export async function checkProgram(host: SignInsHost, input: unknown, run: RunStatus = host.service.deps.statusRun ?? runStatus) {
  const asked = CheckSchema.parse(input);
  const status = await inspectProgram(host, asked, run);
  host.service.noteSignIn(`cli-${asked.id}`, asked.account ?? primaryAccount, status);
  return status;
}
async function inspectProgram(host: SignInsHost, input: unknown, run: RunStatus) {
  const { id, account } = CheckSchema.parse(input);
  const row = cliAgentCatalog.find((entry) => entry.id === id);
  if (!row) throw new Error(`Branch does not know a coding assistant called "${id}".`);
  const notHere = `"${row.command}" is not on this computer, so Branch cannot use ${row.name}. Install it, or pick another model.`;
  if (!await onPath(row.command)) return { id, installed: false, signedIn: false, message: notHere };
  const args = programStatusArgs[id];
  if (!args) return { id, installed: true, signedIn: null,
    message: `${row.name} has no way to say whether it is signed in without being started, so Branch cannot tell. It uses its own sign-in when it is asked something.` };
  const ran = await run(row, args, programEnv(host, id, account));
  if (ran.missing) return { id, installed: false, signedIn: false, message: notHere };
  const login = logins(host).get(loginKey(id, account));
  const canStart = !!programLoginArgs[id];
  const parsed = id === "claude-code" && ran.stdout !== undefined ? claudeIdentity(ran.stdout) : null;
  const signedIn = id === "claude-code" && ran.stdout !== undefined ? ran.code === 1 ? false : ran.code === 0 ? parsed?.signedIn ?? null : null
    : ran.code === 0 ? true : ran.code === 1 ? false : null;
  const identity = signedIn === true ? parsed?.identity : undefined;
  if (signedIn === true) { login?.stop(); return { id, installed: true, signedIn: true, taskReady: null, canStart, ...(identity ? { identity } : {}),
    message: `${row.name} reports a saved sign-in. Its first task checks whether that sign-in still works.` }; }
  if (signedIn === false) {
    if (login?.running) return { id, installed: true, signedIn: false, canStart, signingIn: true, expiresAt: login.expiresAt, ...(login.url && login.send ? { url: login.url, takesCode: true } : {}),
      message: `${row.name} opened its sign-in page in your browser. Finish there and Branch carries on by itself; it never sees that sign-in. If no page opened, run "${loginLine(row, id)}" in a terminal.` };
    if (login?.failed) return { id, installed: true, signedIn: false, canStart, message: login.failed };
    return { id, installed: true, signedIn: false, canStart,
      message: canStart
        ? `${row.name} is not signed in. Sign in opens its own page in your browser; Branch never sees that sign-in.`
        : `${row.name} is not signed in. Sign in to it yourself in a terminal (${row.command}), then check again. Branch never sees that sign-in.` };
  }
  return { id, installed: true, signedIn: null, canStart, message: `${row.name} did not say whether it is signed in. Run it yourself to see why.` };
}

function programEnv(host: SignInsHost, id: string, account: string | undefined): NodeJS.ProcessEnv {
  const env = strippedEnvironment();
  if (id === "claude-code" && (!account || account === primaryAccount)) env.CLAUDE_CONFIG_DIR = host.service.primaryClaudeHome;
  const variable = accountHomeVariables[id];
  if (account && account !== primaryAccount && variable) env[variable] = host.service.homeOf(`cli-${id}`, account);
  return env;
}
/**
 * What a sign-in program needs on top of `programEnv` to open the browser: on Linux the desktop session it runs in and
 * the browser the person chose. Only the sign-in gets these; the status command and the program answering Branch do not.
 */
const browserVariables = ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "BROWSER"];
export function loginEnv(host: SignInsHost, id: string, account: string | undefined): NodeJS.ProcessEnv {
  const env = programEnv(host, id, account);
  for (const name of browserVariables) if (process.env[name]) env[name] = process.env[name];
  return env;
}

/** A sign-in refused before anything is started; answered 409. */
export class SignInRefused extends Error {}
/** The program's name without "(installed on this computer)". */
const plainName = (row: CliAgentRow): string => row.name.replace(/ \(installed on this computer\)$/, "");
const loginLine = (row: CliAgentRow, id: string): string => [row.command, ...(programLoginArgs[id] ?? [])].join(" ");
const lockedOut = (row: CliAgentRow, id: string): string =>
  `Lockdown is on, so Branch does not start ${plainName(row)}'s sign-in. Turn Lockdown off in Settings to allow this again, or run "${loginLine(row, id)}" in a terminal.`;

/**
 * One click: start the program's own sign-in (its page opens in the browser; the program finishes by itself). Already
 * signed in, nothing is started. It runs until it ends, is stopped, or ten minutes pass; the window asks `checkProgram`.
 */
export async function startProgramSignIn(host: SignInsHost, input: unknown, run: RunStatus = host.service.deps.statusRun ?? runStatus, launch: StartLogin = startLogin) {
  const { id, account } = CheckSchema.parse(input);
  const row = cliAgentCatalog.find((entry) => entry.id === id);
  const args = programLoginArgs[id];
  if (!row || !args) throw new Error(`Branch cannot start the sign-in of "${id}". Sign in to it yourself in a terminal, then check again.`);
  // Lockdown refuses leaving a program running (src/lockdown.ts), and the sign-in runs until it ends or ten minutes pass.
  const { store, owner } = host.service.deps;
  if (lockdownActive(store, owner)) throw new SignInRefused(lockedOut(row, id));
  const now = await checkProgram(host, { id, ...(account ? { account } : {}) }, run);
  if (!now.installed || now.signedIn === true) return now;
  const key = loginKey(id, account);
  if (logins(host).get(key)?.running) return checkProgram(host, { id, ...(account ? { account } : {}) }, run);
  // Lockdown may have been switched on while the status command ran.
  if (lockdownActive(store, owner)) throw new SignInRefused(lockedOut(row, id));
  const login: Login = { stop: () => undefined, failed: null, running: true, url: null, send: null,
    expiresAt: new Date(Date.now() + loginTimeoutMs).toISOString() };
  const timer = setTimeout(() => { login.failed = `The sign-in page was not finished within ten minutes, so Branch stopped waiting. Press Sign in to try again.`; login.stop(); }, loginTimeoutMs);
  timer.unref?.();
  // Switched on while the sign-in runs, Lockdown stops it: it refuses leaving a program running.
  const stopListening = onLockdownChange((changed, who, on) => {
    if (!on || changed !== store || who !== owner || !login.running) return;
    login.failed = `Lockdown was switched on, so Branch stopped ${plainName(row)}'s sign-in. Turn Lockdown off in Settings to sign in again, or run "${loginLine(row, id)}" in a terminal.`;
    login.stop();
  });
  const heard = codeSignIns[id] ? (line: string) => { login.url ??= signInAddress(id, line); } : undefined;
  const child = launch(row, args, loginEnv(host, id, account), (code, missing) => {
    clearTimeout(timer);
    stopListening();
    login.running = false;
    if (login.failed) return;
    if (missing) login.failed = `"${row.command}" is not on this computer, so Branch cannot use ${row.name}. Install it, or pick another model.`;
    else if (code !== 0) login.failed = `${row.name}'s sign-in ended without signing in${code === null ? "" : ` (exit ${code})`}. Press Sign in to try again, or run "${loginLine(row, id)}" in a terminal to see why.`;
  }, heard);
  login.send = heard ? child.send : null;
  login.stop = () => { clearTimeout(timer); stopListening(); if (login.running) { login.running = false; child.stop(); } };
  logins(host).set(key, login);
  return checkProgram(host, { id, ...(account ? { account } : {}) }, run);
}

/** The window's Back or close: the sign-in program Branch started for this program and account is stopped. */
export function stopProgramSignIn(host: SignInsHost, input: unknown) {
  const { id, account } = CheckSchema.parse(input);
  const key = loginKey(id, account);
  logins(host).get(key)?.stop();
  logins(host).delete(key);
  return Promise.resolve({ id, stopped: true });
}

const PasteSchema = CheckSchema.extend({ code: PastedCode }).strict();

/**
 * The code the maker's page showed, pasted in the window: forwarded as one line to that program's running sign-in, and
 * only while it runs, takes a code, and Lockdown is off. The program checks the code itself; Branch keeps nothing of it.
 */
export async function pasteSignInCode(host: SignInsHost, input: unknown) {
  const { id, account, code } = PasteSchema.parse(input);
  const row = cliAgentCatalog.find((entry) => entry.id === id);
  if (!row || !codeSignIns[id]) throw new SignInRefused(`${row ? plainName(row) : `"${id}"`} does not take a code from Branch. Sign in to it yourself in a terminal, then check again.`);
  const { store, owner } = host.service.deps;
  if (lockdownActive(store, owner)) throw new SignInRefused(lockedOut(row, id));
  const login = logins(host).get(loginKey(id, account));
  if (!login?.running || !login.send?.(code))
    throw new SignInRefused(`${plainName(row)}'s sign-in is not running, so there is nothing to paste the code into. Press Sign in to start it again.`);
  return { id, sent: true };
}

/** The engine closing: every sign-in program it started is stopped. */
export function stopProgramSignIns(service: AccountsService): void {
  for (const login of loginsOf.get(service)?.values() ?? []) login.stop();
  loginsOf.delete(service);
}

/**
 * Google sign-in for Gemini, with the owner's own saved client id and the engine's own sign-in address
 * (`googleGeminiSignIn`): the window never names an address. The page opens in the person's browser; when Google
 * answers, the connection is registered as `POST /api/models/gemini-signin` would.
 */
export async function startGeminiSignIn(host: SignInsHost, input: unknown) {
  z.object({}).strict().parse(input);
  const { models, store, owner } = host.service.deps;
  const { settings, note } = geminiSignInState(store, owner, models);
  if (!host.oauth || !settings.clientId) throw new Error(`No Google sign-in is set up. ${note}`);
  const oauth = host.oauth, provider = googleGeminiSignIn(settings.clientId);
  const started = await oauth.start(provider);
  oauth.waitFor(started.id).then(() => registerSignedInGemini(oauth, settings, (preset) => models.register(preset))).catch(() => undefined);
  return { id: started.id, url: started.url, expiresInMs: started.expiresInMs };
}
