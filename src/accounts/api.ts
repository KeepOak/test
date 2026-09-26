import type { IncomingMessage } from "node:http";
import { z } from "zod";
import {
  addAccount, dismissNotice, removeAccount, setMode, switchAccount, updateAccount, updatePool, viewAll, viewSession,
} from "./manage.js";
import type { AccountsService } from "./service.js";
import { primaryAccount } from "./settings.js";
import type { OAuthConnections } from "../oauth.js";
import { type SignInsHost, checkProgram, signInOptions, startGeminiSignIn } from "./sign-ins.js";

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
};

const signIns: Record<string, (host: SignInsHost, body: unknown) => Promise<unknown>> = {
  "/api/accounts/sign-ins/check": (host, body) => checkProgram(host, body),
  "/api/accounts/sign-ins/gemini": startGeminiSignIn,
};

export async function accountsApi(request: IncomingMessage, path: string, host: AccountsApiHost): Promise<unknown> {
  const service = host.service;
  if (!service) throw new AccountsApiError(404, "Several accounts per connection is not available in this launch.");
  const url = new URL(request.url ?? "/", "http://x");
  if (request.method === "GET" && path === "/api/accounts") return viewAll(service);
  if (request.method === "GET" && path === "/api/accounts/session")
    return viewSession(service, z.string().uuid().or(z.literal("")).parse(url.searchParams.get("sessionId") ?? ""));
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
      throw error;
    }
  }
  const change = request.method === "POST" ? changes[path] : undefined;
  if (!change) throw new AccountsApiError(404, "Not found");
  host.requireOwner("Accounts");
  if (path !== "/api/accounts/settings" && !service.on())
    throw new AccountsApiError(409, "Several accounts per connection is switched off. Switch it on first.");
  try {
    return await change(service, await host.readBody());
  } catch (error) {
    if (error instanceof z.ZodError) throw new AccountsApiError(400, "That request is not in the expected shape.");
    throw error;
  }
}

/** Starts the ChatGPT sign-in for an extra account; finishing it happens in the background. */
async function chatgptLogin(service: AccountsService, body: unknown) {
  const { account } = LoginSchema.parse(body);
  const pool = service.pool("chatgpt");
  if (!pool?.accounts.some((entry) => entry.id === account && entry.id !== primaryAccount))
    throw new AccountsApiError(404, "That ChatGPT account is not in the list.");
  const auth = service.chatgptAccounts.auth(account);
  const prompt = await auth.startDeviceLogin();
  void auth.waitForDeviceLogin().then(() => service.ensureChatGPTPresets()).catch(() => undefined);
  return { account, userCode: prompt.userCode, verificationUrl: prompt.verificationUrl, expiresAt: prompt.expiresAt };
}
async function chatgptLogout(service: AccountsService, body: unknown) {
  const { account } = LoginSchema.parse(body);
  const status = await service.chatgptAccounts.auth(account).signOut();
  service.dropBuilt("chatgpt", account);
  return { account, signedIn: status.signedIn };
}
