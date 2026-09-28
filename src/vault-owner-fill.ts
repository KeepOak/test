import { Budget, type ToolContext } from "./contracts.js";
import type { CredentialRef, CredentialService } from "./credential-cli.js";
import { audit } from "./audit.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { lockdownActive } from "./lockdown.js";
import { whileSignInShows } from "./sign-in-showing.js";
import type { Store } from "./store.js";
import {
  autofillLockdownRefusal, autofillOffRefusal, autofillRecordingRefusal, autofillShortLivedRefusal, hostAllowed,
  readVaultAutofillSettings, type SignInEntry, type SignInPage,
} from "./vault-autofill.js";

/**
 * RES-710: "Fill from Bitwarden" beside "Take control" on a page that waits for the owner to sign in.
 *
 * The assistant's own `signin.fill` refuses a Trunk and any task the owner did not start, because the assistant
 * chose the page. Here the owner chose it: they are looking at the page, its website is on the card, and they pressed
 * the button. So this keeps every other rule of src/vault-autofill.ts and replaces only "who started this task" with
 * "the owner pressed Fill":
 *
 *   - the switch (off until a vault is connected), Lockdown, a short-lived key and a household person all refuse;
 *   - nothing is filled while the task keeps a recording of the browser;
 *   - the page must be https and its website exactly one the owner saved a sign-in for; Branch never guesses an
 *     item from what the page says;
 *   - it never opens a browser: only a page the task already has open is filled.
 *
 * The user name (Bitwarden only, when the page has an empty name box) and the password go straight from the
 * password manager into the page. Nothing is returned but which boxes were filled, and nothing is logged but the
 * sign-in's name and the website.
 */
export interface OwnerFillDeps {
  store: Store;
  owner: string;
  page: SignInPage;
  /** Whether that task has a page open now; nothing is opened to find out. */
  hasPage: (owner: string, runId: string) => boolean;
  read: (reference: CredentialRef, use: { runId?: string | undefined; purpose: string }) => Promise<string>;
  requireOwner: (what: string) => void;
}
export interface OwnerFillReport { filled: ("username" | "password")[]; login: string; site: string }

/** The one "no" for a page with no saved sign-in, naming the website the owner can see on the card anyway. */
export const ownerNoEntry = (host: string): string =>
  `No saved sign-in is set up for ${host}. Add one for ${host} under Settings → Saved sign-ins, or take control and sign in yourself.`;

function ownerContext(owner: string, runId: string, signal: AbortSignal): ToolContext {
  // Not a model's turn: nothing here is counted against the task's own budget.
  return { owner, runId, signal, workspace: "", budget: new Budget(), permissions: new Set(), depth: 0, source: "owner" };
}

/** The owner's saved sign-in for this website, or a plain refusal. */
function entryFor(logins: SignInEntry[], address: string): SignInEntry {
  let url: URL;
  try { url = new URL(address); } catch { throw new Error("Branch cannot tell what address this page is on, so it filled nothing."); }
  if (url.protocol !== "https:") throw new Error("This page is not on a secure address, so no sign-in was filled.");
  if (url.username || url.password) throw new Error("That address carries a name and password of its own, so no sign-in was filled.");
  const found = logins.filter((entry) => hostAllowed(entry, url.hostname));
  if (!found.length) throw new Error(ownerNoEntry(url.hostname));
  if (found.length > 1)
    throw new Error(`More than one saved sign-in is for ${url.hostname} (${found.map((one) => one.name).join(", ")}). Take control and sign in, or keep one.`);
  return found[0]!;
}

export async function fillForOwner(deps: OwnerFillDeps, runId: string, signal: AbortSignal): Promise<OwnerFillReport> {
  deps.requireOwner("Filling a saved sign-in");
  if (lockdownActive(deps.store, deps.owner)) throw new Error(autofillLockdownRefusal);
  if (startedWithShortLivedKey()) throw new Error(autofillShortLivedRefusal);
  const settings = readVaultAutofillSettings(deps.store, deps.owner);
  if (settings.mode === "off") throw new Error(autofillOffRefusal);
  if (!deps.hasPage(deps.owner, runId)) throw new Error("That task has no page open any more, so there is nothing to fill.");
  const context = ownerContext(deps.owner, runId, signal);
  const { address, recording } = await deps.page.where(context);
  if (recording) throw new Error(autofillRecordingRefusal);
  const entry = entryFor(settings.logins, address), host = new URL(address).hostname;
  const filled: OwnerFillReport["filled"] = [];
  await whileSignInShows(async () => {
    if (entry.service === "bitwarden" && await typeName(deps, entry, context, host)) filled.push("username");
    await typeSecret(deps, entry, context, host);
    filled.push("password");
  });
  audit(deps.store, deps.owner, {
    action: "secret.used", actor: entry.service === "windows" ? "your Windows Credential Manager" : `your ${entry.service === "bitwarden" ? "Bitwarden" : "1Password"} vault`,
    subject: `sign-in "${entry.name}" (${filled.join(" and ")}) on ${host}`,
    reason: "you pressed Fill on a page waiting for you to sign in", runId, outcome: "filled",
  });
  return { filled, login: entry.name, site: host };
}

/** The user name, when the page has a name box to put it in. A page without one (the name on an earlier page) is fine. */
async function typeName(deps: OwnerFillDeps, entry: SignInEntry, context: ToolContext, host: string): Promise<boolean> {
  const reference: CredentialRef = { service: entry.service as CredentialService, item: entry.item, field: "username" };
  const name = await deps.read(reference, { runId: context.runId, purpose: `filling your "${entry.name}" sign-in on ${host}` }).catch(() => "");
  if (!name) return false;
  try { await deps.page.type(context, "username", undefined, name, host); return true; } catch { return false; }
}

/** The password. Nothing thrown from here carries it: a page library's own message can quote what it was typing. */
async function typeSecret(deps: OwnerFillDeps, entry: SignInEntry, context: ToolContext, host: string): Promise<void> {
  const reference: CredentialRef = { service: entry.service as CredentialService, item: entry.item, field: "password" };
  const value = await deps.read(reference, { runId: context.runId, purpose: `filling your "${entry.name}" sign-in on ${host}` });
  try { await deps.page.type(context, "password", undefined, value, host); } catch {
    throw new Error(`Branch could not find the password box on ${host}. Take control and sign in yourself.`);
  }
}
