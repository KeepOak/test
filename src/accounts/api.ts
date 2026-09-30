import type { IncomingMessage } from "node:http";
import { z } from "zod";
import {
  addAccount, dismissNotice, removeAccount, setMode, switchAccount, updateAccount, updatePool, viewAll, viewSession,
} from "./manage.js";
import type { AccountsService } from "./service.js";
import { primaryAccount } from "./settings.js";
import { mergeChatGPTDuplicates } from "./dedupe.js";
import type { OAuthConnections } from "../oauth.js";
import { type SignInsHost, SignInRefused, checkProgram, pasteSignInCode, signInOptions, startGeminiSignIn, startProgramSignIn, stopProgramSignIn } from "./sign-ins.js";
import { lockdownActive } from "../lockdown.js";
import { looseningRefusal, withoutConfirm } from "../policy-change-guard.js";

/**
 * `/api/accounts`: the list for Settings, the phone, the terminal and the dashboard, and every
 * change to it. Reads may be made with any key; every change is the owner's own (the server's
 * short-lived key rule refuses them first, and `requireOwner` refuses household profiles).
 */
export class AccountsApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const handlesAccountsPath = (path: string): boolean => path === "/api/accounts" || path.startsWith("/api/accounts/");

export interface AccountsApiHost {
  service: AccountsService | undefined;
  readBody: () => Promise<unknown>;
  requireOwner: (what: string) => void;
  /** The engine's OAuth flows, for Google sign-in to Gemini with the owner's saved client id. */
  oauth?: OAuthConnections;
}
const LoginSchema = z.object({ account: z.string().regex(/^[a-f0-9]{8}$/) }).strict();

type Change = (service: AccountsService, body: unknown) => unknown;
const changes: Record<string, Change> = {
  "/api/accounts/settings": setMode,
  "/api/accounts/add": addAccount,
  "/api/accounts/update": updateAccount,
  "/api/accounts/pool": updatePool,
  "/api/accounts/remove": removeAccount,
  "/api/accounts/switch": switchAccount,
  "/api/accounts/notice": dismissNotice, // mac7/account-pooling
  "/api/accounts/chatgpt/login": chatgptLogin,
  "/api/accounts/chatgpt/logout": chatgptLogout,
  "/api/accounts/chatgpt/cancel": chatgptCancel,
};

const signIns: Record<string, (host: SignInsHost, body: unknown) => Promise<unknown>> = {
  "/api/accounts/sign-ins/check": (host, body) => checkProgram(host, body),
  "/api/accounts/sign-ins/code": pasteSignInCode,
  "/api/accounts/sign-ins/gemini": startGeminiSignIn,
  "/api/accounts/sign-ins/start": (host, body) => startProgramSignIn(host, body),
  "/api/accounts/sign-ins/stop": stopProgramSignIn,
};

export async function accountsApi(request: IncomingMessage, path: string, host: AccountsApiHost): Promise<unknown> {
  const service = host.service;
  if (!service) throw new AccountsApiError(404, "Several accounts per connection is not available in this launch.");
  const url = new URL(request.url ?? "/", "http://x");
  if (request.method === "GET" && path === "/api/accounts") return viewAll(service);
  if (request.method === "GET" && path === "/api/accounts/session") {
    const session = z.string().uuid().or(z.literal("")).parse(url.searchParams.get("sessionId") ?? "");
    viewSession(service, session); // validates conversation ownership before asking any program.
    await service.readIdentities();
    return viewSession(service, session);
  }
  // The sign-ins that could be made (src/accounts/sign-ins.ts): no account is in them, so they answer with the switch off.
  // A household person sees none of the owner's sign-ins (hardening-3), so this read is the owner's too.
  if (request.method === "GET" && path === "/api/accounts/sign-ins") {
    host.requireOwner("Signing in");
    return signInOptions({ service, oauth: host.oauth });
  }
  const signIn = request.method === "POST" ? signIns[path] : undefined;
  if (signIn) {
    host.requireOwner("Signing in");
    try { return await signIn({ service, oauth: host.oauth }, await host.readBody()); } catch (error) {
      if (error instanceof z.ZodError) throw new AccountsApiError(400, "That request is not in the expected shape.");
      if (error instanceof SignInRefused) throw new AccountsApiError(409, error.message);
      throw error;
    }
  }
  const change = request.method === "POST" ? changes[path] : undefined;
  if (!change) throw new AccountsApiError(404, "Not found");
  host.requireOwner("Accounts");
  if (path !== "/api/accounts/settings" && !service.on())
    throw new AccountsApiError(409, "Several accounts per connection is switched off. Switch it on first.");
  try {
    const body = await host.readBody();
    if (path !== "/api/accounts/update" && path !== "/api/accounts/settings") return await change(service, body);
    // A monthly cap raised or taken away needs the owner's yes, and never under Lockdown (src/policy-change-guard.ts).
    // Switching several accounts off takes every cap away with it (the connection then answers on its own key).
    const { confirmLoosening, input } = withoutConfirm(body);
    const looser = path === "/api/accounts/settings" ? capsOffLooser(service, input) : capLooser(service, input);
    const refusal = looseningRefusal(looser, confirmLoosening, lockdownActive(service.deps.store, service.deps.owner));
    if (refusal) throw new AccountsApiError(409, refusal);
    return await change(service, input);
  } catch (error) {
    if (error instanceof z.ZodError) throw new AccountsApiError(400, "That request is not in the expected shape.");
    throw error;
  }
}

/** Refuses an extra ChatGPT account that is not in the list, before its sign-in is touched. */
function inChatGPTList(service: AccountsService, account: string): void {
  if (!service.pool("chatgpt")?.accounts.some((entry) => entry.id === account && entry.id !== primaryAccount))
    throw new AccountsApiError(404, "That ChatGPT account is not in the list.");
}
/** Starts the ChatGPT sign-in for an extra account; finishing it happens in the background. */
async function chatgptLogin(service: AccountsService, body: unknown) {
  const { account } = LoginSchema.parse(body);
  inChatGPTList(service, account);
  const auth = service.chatgptAccounts.auth(account);
  const prompt = await auth.startDeviceLogin();
  // Signed in as an account Branch already has: merged into that one, never kept as a second (src/accounts/dedupe.ts).
  void auth.waitForDeviceLogin().then(() => mergeChatGPTDuplicates(service, { fresh: account })).then(() => service.ensureChatGPTPresets()).catch(() => undefined);
  return { account, userCode: prompt.userCode, verificationUrl: prompt.verificationUrl, expiresAt: prompt.expiresAt };
}
/** Stops an extra account's sign-in that is waiting for the browser (the window's Back or close). */
async function chatgptCancel(service: AccountsService, body: unknown) {
  const { account } = LoginSchema.parse(body);
  inChatGPTList(service, account);
  const status = await service.chatgptAccounts.auth(account).cancelDeviceLogin();
  return { account, signedIn: status.signedIn };
}
async function chatgptLogout(service: AccountsService, body: unknown) {
  const { account } = LoginSchema.parse(body);
  const status = await service.chatgptAccounts.auth(account).signOut();
  service.dropBuilt("chatgpt", account);
  return { account, signedIn: status.signedIn };
}

/** What an update does to an account's monthly cap that lets it spend more, in words, or null when it does not. */
function capLooser(service: AccountsService, input: unknown): string | null {
  const asked = (input && typeof input === "object" ? input : {}) as { pool?: unknown; account?: unknown; monthlyCapUsd?: unknown };
  if (asked.monthlyCapUsd === undefined) return null;
  const account = service.pool(String(asked.pool))?.accounts.find((entry) => entry.id === asked.account);
  const was = account?.monthlyCapUsd ?? null;
  if (was === null) return null;
  if (asked.monthlyCapUsd === null) return `${account?.label} would have no monthly cap`;
  return typeof asked.monthlyCapUsd === "number" && asked.monthlyCapUsd > was
    ? `${account?.label}'s monthly cap would go up from $${was} to $${asked.monthlyCapUsd}` : null;
}

/** Whether switching several accounts off would drop monthly caps that are kept now, in words, or null. */
function capsOffLooser(service: AccountsService, input: unknown): string | null {
  const asked = (input && typeof input === "object" ? input : {}) as { mode?: unknown };
  if (asked.mode !== "off" || !service.on()) return null;
  const capped = service.settings().pools.flatMap((pool) => pool.accounts).filter((account) => account.monthlyCapUsd !== null);
  return capped.length ? `the monthly caps on ${capped.map((account) => account.label).join(", ")} would no longer be kept` : null;
}
