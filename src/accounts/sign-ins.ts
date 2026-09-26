import { spawn } from "node:child_process";
import { z } from "zod";
import { onPath } from "../asks/runtimes.js";
import { googleGeminiSignIn, registerSignedInGemini } from "../gemini-signin.js";
import type { OAuthConnections } from "../oauth.js";
import { accountHomeVariables, cliAgentCatalog, strippedEnvironment, type CliAgentRow } from "../providers/cli-agent.js";
import { geminiSignInState } from "../voice-api.js";
import { startCall } from "../windows-command.js";
import type { AccountsService } from "./service.js";
import { primaryAccount } from "./settings.js";

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

export async function signInOptions(host: SignInsHost) {
  const { models, chatgpt, store, owner } = host.service.deps;
  const status = chatgpt ? await chatgpt.status() : null;
  const programs = await Promise.all(cliAgentCatalog.map(async (row) => ({
    id: row.id, pool: `cli-${row.id}`, name: row.name, label: row.name.replace(/ \(installed on this computer\)$/, ""), note: row.note, command: row.command, terms: row.terms ?? null,
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

type Ran = { code: number | null; missing: boolean };
export type RunStatus = (row: CliAgentRow, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<Ran>;

/** Starts the status command with no shell, the prompt-free way the program's own docs give; its output is not read. */
export const runStatus: RunStatus = (row, args, env) => new Promise((resolve) => {
  const start = startCall(row.command, [...args], env);
  const child = spawn(start.command, start.args, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true, shell: false, env });
  let settled = false;
  const finish = (value: Ran): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
  const timer = setTimeout(() => { child.kill(); finish({ code: null, missing: false }); }, 20_000);
  timer.unref?.();
  child.on("error", (error: NodeJS.ErrnoException) => finish({ code: 1, missing: error.code === "ENOENT" }));
  child.on("close", (code) => finish({ code, missing: false }));
});

/** Whether one program is on this computer and signed in, in plain words, for its usual sign-in or one account's folder. */
export async function checkProgram(host: SignInsHost, input: unknown, run: RunStatus = runStatus) {
  const { id, account } = CheckSchema.parse(input);
  const row = cliAgentCatalog.find((entry) => entry.id === id);
  if (!row) throw new Error(`Branch does not know a coding assistant called "${id}".`);
  const notHere = `"${row.command}" is not on this computer, so Branch cannot use ${row.name}. Install it, or pick another model.`;
  if (!await onPath(row.command)) return { id, installed: false, signedIn: false, message: notHere };
  const args = programStatusArgs[id];
  if (!args) return { id, installed: true, signedIn: null,
    message: `${row.name} has no way to say whether it is signed in without being started, so Branch cannot tell. It uses its own sign-in when it is asked something.` };
  const env = strippedEnvironment();
  const variable = accountHomeVariables[id];
  if (account && account !== primaryAccount && variable) env[variable] = host.service.homeOf(`cli-${id}`, account);
  const ran = await run(row, args, env);
  if (ran.missing) return { id, installed: false, signedIn: false, message: notHere };
  if (ran.code === 0) return { id, installed: true, signedIn: true, message: `${row.name} is signed in.` };
  if (ran.code === 1) return { id, installed: true, signedIn: false,
    message: `${row.name} is not signed in. Sign in to it yourself in a terminal (${row.command}), then check again. Branch never sees that sign-in.` };
  return { id, installed: true, signedIn: null, message: `${row.name} did not say whether it is signed in. Run it yourself to see why.` };
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
  return { url: started.url, expiresInMs: started.expiresInMs };
}
