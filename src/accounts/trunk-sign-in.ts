import { spawn } from "node:child_process";
import { z } from "zod";
import { ApprovalRequiredError, type ApprovalGate } from "../approvals.js";
import { onPath } from "../asks/runtimes.js";
import { nobodyToAsk } from "../coding/project-tests.js";
import type { ToolContext } from "../contracts.js";
import type { BranchBrowser } from "../integrations/browser.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { lockdownActive } from "../lockdown.js";
import { cliAgentCatalog, strippedEnvironment } from "../providers/cli-agent.js";
import type { ToolRegistry } from "../registry.js";
import { startCall } from "../windows-command.js";
import { signInRefusedForTrunk } from "./context.js";
import { addAccount, removeAccount, updateAccount } from "./manage.js";
import { primaryAccount } from "./settings.js";
import { addProgram, forgetProgram } from "./saved-sign-ins.js";
import type { AccountsService } from "./service.js";
import {
  checkProgram, pasteSignInCode, signInHosts, signInWaiting, startProgramSignIn, stopProgramSignIn, type RunStatus, type StartLogin,
} from "./sign-ins.js";

/**
 * RES-706: "Add my Claude account" (or Codex), done by the assistant or a Trunk, with the owner there.
 *
 *   1. The program is looked for. Missing, it is installed with its maker's own npm package, and only once the owner
 *      says yes to that one install, in the moment (asked every time; a standing rule cannot say yes for them).
 *   2. A new account is made in the connection's list, with a folder of its own, and the program's own sign-in is
 *      started there (src/accounts/sign-ins.ts): the program keeps that sign-in, Branch never reads inside the folder.
 *   3. Claude Code: the maker's sign-in page opens in Branch's browser, where the page asks for a password and so says
 *      "Needs you". The owner takes control and signs in. The page then sends the browser to its return address with
 *      a one-time code; that load is never sent (src/integrations/browser.ts `relaySignIn`): the code goes straight
 *      to the waiting program, and the tab shows a page with no code. The model is never told the password or the code.
 *      Codex: its own sign-in opens its page in the computer's usual browser, as Settings → Accounts does today.
 *   4. The sign-in is checked with the program's status command (Claude Code names the email), then with one real
 *      one-turn request through that account alone. Only then does it stay in the list. Anything failing takes the
 *      new account back out, and says why.
 */
export const addSignInTool = "accounts.add_signin";
export const installTool = "accounts.install_program";

/** The makers' own npm packages (npm view, 2026-09-28): Anthropic's Claude Code and OpenAI's Codex. */
export const programPackages: Readonly<Record<string, { pkg: string; maker: string; page: string }>> = {
  "claude-code": { pkg: "@anthropic-ai/claude-code", maker: "Anthropic", page: "https://code.claude.com/docs/en/setup" },
  codex: { pkg: "@openai/codex", maker: "OpenAI", page: "https://developers.openai.com/codex/cli" },
};

export type Installer = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number | null; missing: boolean }>;
/** npm, started with no shell and no window, with the clean environment; given five minutes. */
export const runInstall: Installer = (command, args, env) => new Promise((resolve) => {
  const start = startCall(command, args, env);
  const child = spawn(start.command, start.args, { stdio: "ignore", windowsHide: true, shell: false, env });
  const timer = setTimeout(() => child.kill(), 5 * 60_000);
  timer.unref?.();
  child.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ code: 1, missing: error.code === "ENOENT" }); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, missing: false }); });
});

export interface TrunkSignInDeps {
  service: AccountsService;
  approvals: Pick<ApprovalGate, "answer" | "takeOnce">;
  sessionOf: (context: ToolContext) => string;
  browser: () => BranchBrowser | null;
  /** Whether a program is on this computer's path. */
  present?: (command: string) => Promise<boolean>;
  install?: Installer;
  /** Test seams, passed to the sign-in (src/accounts/sign-ins.ts). */
  run?: RunStatus;
  launch?: StartLogin;
  /** How often the waiting sign-in is looked at. */
  pollMs?: number;
}

const Input = z.object({
  program: z.enum(["claude-code", "codex"]),
  /** What to call the account until the program names it. */
  label: z.string().trim().min(1).max(60).optional(),
}).strict();

const plain = (id: string): string => (id === "codex" ? "Codex" : "Claude Code");

/** Why this call may not add a sign-in, or null: the owner must be there, and it must be their own work. */
function refusal(deps: TrunkSignInDeps, context: ToolContext): string | null {
  const { store, owner } = deps.service.deps;
  if (lockdownActive(store, owner)) return "Lockdown is on, so Branch does not add a sign-in. Turn Lockdown off in Settings first.";
  if (startedWithShortLivedKey()) return "A short-lived key cannot add a sign-in to your accounts. Do it in the Branch app.";
  if (nobodyToAsk(context) || (context.source ?? "owner") !== "owner")
    return "Adding a sign-in needs you there to sign in, so it cannot be done from a schedule, a trigger, a chat app or another program. Ask in the Branch app.";
  if (signInRefusedForTrunk()) return "A Trunk adds a sign-in to your accounts only for your own work, with you there.";
  if (!deps.service.on()) return "Several accounts per connection is switched off. Switch it on in Settings → Accounts, then ask again.";
  return null;
}

/** Installs the program with its maker's npm package, once the owner said yes to this one install. */
async function ensureInstalled(deps: TrunkSignInDeps, id: string, context: ToolContext): Promise<void> {
  const row = cliAgentCatalog.find((entry) => entry.id === id)!, found = programPackages[id]!;
  const present = deps.present ?? ((command: string) => onPath(command));
  if (await present(row.command)) return;
  const session = deps.sessionOf(context), label = `Install ${plain(id)} (${found.maker}'s npm package ${found.pkg})`;
  const said = deps.approvals.answer(session, installTool, found.pkg);
  if (said === "deny") throw new Error(`You chose not to install ${plain(id)}, so no account was added.`);
  if (said !== "allow" && !deps.approvals.takeOnce(session, installTool, found.pkg)) {
    if (!context.askable && !context.approvalKey)
      throw new Error(`${plain(id)} is not on this computer, and installing it needs your yes. Ask in a conversation, or install it from ${found.page}.`);
    throw new ApprovalRequiredError(installTool, found.pkg, label, "never", undefined,
      { question: `${plain(id)} is not on this computer. Install it now with "npm install -g ${found.pkg}", ${found.maker}'s official package?` });
  }
  const install = deps.install ?? runInstall;
  if (!await present("npm"))
    throw new Error(`npm is not on this computer, so Branch cannot install ${plain(id)}. Install it from ${found.page}, then ask again.`);
  const done = await install("npm", ["install", "-g", found.pkg], strippedEnvironment());
  if (done.missing) throw new Error(`npm is not on this computer, so Branch cannot install ${plain(id)}. Install it from ${found.page}, then ask again.`);
  if (done.code !== 0) throw new Error(`npm could not install ${found.pkg} (exit ${done.code}). Install it from ${found.page}, then ask again.`);
  if (!await present(row.command))
    throw new Error(`${plain(id)} was installed, but Branch cannot find "${row.command}" yet. Restart Branch, then ask again.`);
}

/**
 * The return address a code sign-in's page names, as a matcher: same https address, carrying a code and the state, and
 * sent there by one of the maker's own pages. The model can read the sign-in page's address (and so the state), and
 * could open the return address with a code of somebody else's to sign the owner's folder in as them; such a load has
 * no maker page it came from, so it is blocked like the real one (no code reaches the tab or the website) and nothing
 * is handed to the program.
 */
export function returnAddress(page: string, makerHosts: readonly string[] = []): { match: (url: URL) => boolean; trusted: (from: URL | null) => boolean; state: string } {
  const asked = new URL(page), back = new URL(asked.searchParams.get("redirect_uri") ?? "about:blank"), state = asked.searchParams.get("state") ?? "";
  if (back.protocol !== "https:" || !state) throw new Error("The sign-in page did not name a return address Branch can wait for.");
  const makers = new Set([asked.hostname, back.hostname, ...makerHosts]);
  return { state,
    match: (url) => url.origin === back.origin && url.pathname === back.pathname && url.searchParams.get("state") === state && !!url.searchParams.get("code"),
    trusted: (from) => !!from && from.protocol === "https:" && makers.has(from.hostname) };
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((done, fail) => {
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); fail(new Error("Stopped, so no account was added.")); }, { once: true });
});

/** Opens a code sign-in's page in Branch's browser and hands the code on when the owner finishes it. */
async function relayInBrowser(deps: TrunkSignInDeps, id: string, account: string, context: ToolContext): Promise<() => void> {
  const host = { service: deps.service };
  let url: string | null = null;
  for (let tries = 0; tries < 100 && !url; tries++) {
    const now = signInWaiting(host, id, account);
    if (!now?.running) throw new Error(now?.failed ?? `${plain(id)}'s sign-in stopped before it showed its page.`);
    url = now.url;
    if (!url) await pause(200, context.signal);
  }
  if (!url) throw new Error(`${plain(id)} did not show its sign-in page. Sign in from Settings → Accounts instead.`);
  const browser = deps.browser();
  if (!browser) throw new Error("Branch's browser is not set up, so the sign-in cannot be finished there. Finish it from Settings → Accounts instead.");
  const back = returnAddress(url, signInHosts(id)), store = deps.service.deps.store;
  const stop = browser.relaySignIn({ owner: deps.service.deps.owner, program: plain(id), match: back.match, trusted: back.trusted, take: (landed) => {
    const code = `${landed.searchParams.get("code")}#${back.state}`;
    store.secrets.scrubber.remember(`sign-in code for ${plain(id)}`, code); // taken back out of anything written later
    void pasteSignInCode(host, { id, account, code }).catch(() => undefined); // a failure shows as the sign-in failing
  } });
  try { await browser.navigate(url, context); } catch (error) {
    stop();
    throw new Error(`Branch's browser could not open ${new URL(url).hostname}: ${error instanceof Error ? error.message : String(error)}. Finish the sign-in from Settings → Accounts instead.`);
  }
  return stop;
}

/** Waits for the program's own sign-in to end, while the owner signs in. */
async function waitForSignIn(deps: TrunkSignInDeps, id: string, account: string, context: ToolContext): Promise<void> {
  const host = { service: deps.service };
  for (;;) {
    const now = signInWaiting(host, id, account);
    if (!now) throw new Error(`${plain(id)}'s sign-in is no longer running.`);
    if (now.failed) throw new Error(now.failed);
    if (!now.running) return;
    await pause(deps.pollMs ?? 1000, context.signal);
  }
}

export async function addSignIn(deps: TrunkSignInDeps, input: unknown, context: ToolContext) {
  const { program: id, label } = Input.parse(input);
  const { store, owner, models } = deps.service.deps;
  store.profiles.requireOwner("Adding a sign-in");
  const refused = refusal(deps, context);
  if (refused) throw new Error(refused);
  await ensureInstalled(deps, id, context);
  const pool = `cli-${id}`;
  // The connection is made only for this, and taken out again if the sign-in does not stay.
  const newConnection = !models.presets.has(pool);
  if (newConnection) addProgram(models, store, owner, { id });
  const before = new Set(deps.service.pool(pool)?.accounts.map((one) => one.id) ?? []);
  const count = before.size + 2; // the connection itself is the first sign-in
  await addAccount(deps.service, { pool, label: label ?? `${plain(id)} ${count}` });
  // The new one only: never the connection's own first sign-in, which is the program's usual folder.
  const madeAccount = deps.service.pool(pool)?.accounts.find((one) => !before.has(one.id) && one.id !== primaryAccount)?.id;
  if (!madeAccount) {
    if (newConnection) { models.remove(pool); forgetProgram(store, owner, pool); }
    throw new Error(`Branch could not make a new ${plain(id)} account, so nothing was started.`);
  }
  const account = madeAccount;
  // Kept switched off until it is signed in and checked, so pooled work is never sent to a half-made account.
  await updateAccount(deps.service, { pool, account, disabled: true });
  const host = { service: deps.service };
  let stopRelay = () => undefined as void;
  try {
    const started = await startProgramSignIn(host, { id, account }, deps.run, deps.launch);
    if (!started.installed) throw new Error(started.message);
    if (started.signedIn !== true) {
      if (id === "claude-code") stopRelay = await relayInBrowser(deps, id, account, context);
      await waitForSignIn(deps, id, account, context);
    }
    const status = await checkProgram(host, { id, account }, deps.run);
    if (status.signedIn !== true) throw new Error(`${plain(id)} did not sign in: ${status.message}`);
    // One real request through this account alone, never through the pool.
    await deps.service.measure(pool, account, context.signal).catch((error: unknown) => {
      throw new Error(`${plain(id)} signed in, but its first request failed, so the account was not kept: ${error instanceof Error ? error.message : String(error)}`);
    });
    await updateAccount(deps.service, { pool, account, disabled: false });
    const email = "identity" in status ? status.identity?.email ?? null : null;
    return { added: true, program: plain(id), account, email, verified: true,
      note: email ? `Signed in as ${email} and checked with one request. It is in your ${plain(id)} accounts.`
        : `Signed in and checked with one request. ${plain(id)} does not say which account it is, so it is listed as "${label ?? `${plain(id)} ${count}`}".` };
  } catch (error) {
    await stopProgramSignIn(host, { id, account }).catch(() => undefined);
    await removeAccount(deps.service, { pool, account }).catch(() => undefined);
    if (newConnection) { models.remove(pool); forgetProgram(store, owner, pool); }
    throw error;
  } finally {
    stopRelay();
  }
}

export function registerTrunkSignIn(registry: ToolRegistry, deps: TrunkSignInDeps): void {
  registry.register({
    name: addSignInTool, permission: "settings.write",
    description: "Add the owner's Claude Code or Codex sign-in as another account, when they ask for it. Installs the program first if it is missing (the owner is asked), "
      + "opens its sign-in page, waits while the owner signs in themselves, then checks it with one request. You never see the password or the sign-in code.",
    parameters: Input,
    target: (input: z.infer<typeof Input>) => `adding a ${plain(input.program)} sign-in`,
    execute: (input: z.infer<typeof Input>, context: ToolContext) => addSignIn(deps, input, context),
    group: "settings", // last: tests/backup-classified.test.mjs reads a "settings" string followed by words as a settings key
  });
}
