import { audit } from "../audit.js";
import type { ChatGPTAuth, ChatGPTStatus } from "../chatgpt-auth.js";
import { TrunkRecords } from "../trunks/record.js";
import type { AccountsService } from "./service.js";
import { type Account, type Pool, primaryAccount, saveAccountsSettings, saveSessionChoice, sessionChoice } from "./settings.js";

/**
 * One ChatGPT account is one connection. An extra account is added to the list before it signs in, and the device
 * sign-in then approves whoever the browser is signed in as, which is often the account Branch already has. Nothing
 * compared the two, so the same account showed twice. After every ChatGPT sign-in, and once at start (for lists
 * already doubled), sign-ins of the same account are merged into one: the first sign-in is kept whenever it is one
 * of them (it is the connection itself), else the one earliest in the list.
 *
 * Same account means the same ChatGPT account id AND the same email, both read from the sign-in's own tokens. The
 * account id alone is shared by everyone in a work or school workspace, so it never decides by itself; a sign-in
 * missing either value is never merged.
 */
export interface ChatGPTIdentity { accountId: string | null; email: string | null }

export function sameChatGPTAccount(a: ChatGPTIdentity, b: ChatGPTIdentity): boolean {
  if (!a.accountId || !b.accountId || !a.email || !b.email) return false;
  return a.accountId === b.accountId && a.email.trim().toLowerCase() === b.email.trim().toLowerCase();
}

interface Seat { id: string; auth: ChatGPTAuth; status: ChatGPTStatus }
export interface Merge { from: string; into: string; label: string }

/** Every signed-in ChatGPT sign-in, the first one first, then the list's order. */
async function seatsOf(service: AccountsService, pool: Pool): Promise<Seat[]> {
  const first = service.deps.chatgpt;
  const seats: Seat[] = [];
  if (first) seats.push({ id: primaryAccount, auth: first, status: await first.status() });
  for (const account of pool.accounts) {
    if (account.id === primaryAccount) continue;
    const auth = service.chatgptAccounts.auth(account.id);
    seats.push({ id: account.id, auth, status: await auth.status() });
  }
  return seats.filter((seat) => seat.status.signedIn);
}

/** Sign-ins of one account, in order; only groups of two or more. */
function groupsOf(seats: Seat[]): Seat[][] {
  const groups: Seat[][] = [];
  for (const seat of seats) {
    const group = groups.find((one) => sameChatGPTAccount(one[0]!.status, seat.status));
    if (group) group.push(seat); else groups.push([seat]);
  }
  return groups.filter((group) => group.length > 1);
}

/**
 * Merges every doubled ChatGPT sign-in in the owner's list. Running it again changes nothing. `fresh` names the sign-in
 * that has just finished: when it is merged away, the kept sign-in takes its new credentials, so signing in again
 * updates the existing connection rather than leaving it on older ones.
 */
export async function mergeChatGPTDuplicates(service: AccountsService, options: { fresh?: string } = {}): Promise<Merge[]> {
  const settings = service.settings();
  const pool = settings.pools.find((entry) => entry.pool === "chatgpt");
  if (!pool) return [];
  const merges: Merge[] = [];
  for (const group of groupsOf(await seatsOf(service, pool))) {
    const kept = group[0]!;
    // The kept sign-in keeps working credentials: when its own last refresh failed and another's did not, it takes those.
    const fresh = group.find((seat) => seat.id === options.fresh && seat !== kept);
    const healthy = group.find((seat) => !seat.status.lastError);
    if (fresh) await kept.auth.takeOver(fresh.auth);
    else if (kept.status.lastError && healthy && healthy !== kept) await kept.auth.takeOver(healthy.auth);
    if (!(await kept.auth.status()).signedIn) continue; // never sign one out before the kept one is known to hold tokens
    for (const gone of group.slice(1)) merges.push(await mergeOne(service, pool, kept.id, gone.id));
  }
  if (merges.length) saveAccountsSettings(service.deps.store, service.deps.owner, settings);
  for (const merge of merges) {
    await service.chatgptAccounts.forget(merge.from);
    service.mergedInto.set(merge.from, merge.into);
  }
  return merges;
}

/** Takes one account out of the list, pointing everything that named it at the kept one, and writes down what it was. */
async function mergeOne(service: AccountsService, pool: Pool, into: string, from: string): Promise<Merge> {
  const record = pool.accounts.find((account) => account.id === from)!;
  const keptLabel = pool.accounts.find((account) => account.id === into)?.label ?? into;
  pool.accounts = pool.accounts.filter((account) => account.id !== from);
  if (pool.defaultAccount === from) pool.defaultAccount = into;
  repointChoices(service, from, into);
  carryWindows(service, from, into);
  service.dropBuilt("chatgpt", from);
  service.statesOf("chatgpt").delete(from);
  service.rests.forget(service.deps.owner, "chatgpt", from);
  audit(service.deps.store, service.deps.owner, {
    action: "connection.changed", actor: service.deps.owner, subject: `${record.label} (chatgpt)`,
    reason: `The same ChatGPT account was signed in twice, so it was merged into "${keptLabel}". The merged-away entry was: ${describe(record)}`.slice(0, 500),
    outcome: "merged",
  });
  return { from, into, label: record.label };
}

const describe = (account: Account): string => JSON.stringify({ id: account.id, label: account.label, createdAt: account.createdAt,
  pinned: account.pinned, disabled: account.disabled, monthlyCapUsd: account.monthlyCapUsd });

/** Conversations and Trunks that picked the merged-away account now use the kept one. */
function repointChoices(service: AccountsService, from: string, into: string): void {
  const { store, owner } = service.deps;
  const rows = store.sqlite.prepare("SELECT id FROM settings WHERE owner=? AND id LIKE 'account-session:%'").all(owner) as { id: string }[];
  for (const { id } of rows) {
    const sessionId = id.slice("account-session:".length);
    if (sessionChoice(store, owner, sessionId).chatgpt === from) saveSessionChoice(store, owner, sessionId, "chatgpt", into);
  }
  const trunks = new TrunkRecords(store, owner);
  for (const trunk of trunks.list())
    if (trunk.keys.accounts.chatgpt === from) trunks.put({ ...trunk, keys: { ...trunk.keys, accounts: { ...trunk.keys.accounts, chatgpt: into } } });
}

/** The merged-away sign-in's plan windows, where they are newer than the kept one's. */
function carryWindows(service: AccountsService, from: string, into: string): void {
  const kept = service.planWindows.get("chatgpt", into);
  const newer = service.planWindows.get("chatgpt", from).filter((window) => {
    const same = kept.find((one) => one.id === window.id);
    return !same || Date.parse(window.measuredAt) > Date.parse(same.measuredAt);
  });
  if (newer.length) service.planWindows.record("chatgpt", into, newer);
}
