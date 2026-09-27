import { accountsServiceFor } from "../accounts/service.js";
import { connectionName, dismissNotice, switchAccount, updateAccount, viewSession } from "../accounts/manage.js";
import { poolingNotice } from "../accounts/settings.js";
import type { Call, Reply } from "./handlers.js";

/**
 * `/account` (mac6/accounts): which account the model in use answers through, and switching it by
 * hand. On its own it lists; `/account <name>` switches this conversation; `/account default <name>`
 * changes what new work uses. Switching is the owner's own, like the Settings screen.
 * mac7/account-pooling: `/account separate <name>` marks a sign-in account as someone else's or
 * work's ("kept separate"), `/account not-separate <name>` takes the mark off.
 */
export async function accountCommand(call: Call): Promise<Reply> {
  // Even the list is the owner's: a household profile or a signed-in person is refused outright.
  call.host.requireOwner("/account");
  const service = accountsServiceFor(call.host.runtime.models);
  if (!service || !service.on())
    return { text: "Several accounts per connection is switched off. Turn it on in Settings › Accounts." };
  const session = call.sessionId ?? "";
  const view = viewSession(service, session);
  if (!view.pool || !("accounts" in view))
    return { text: "The model in use has only one account. Add more in Settings › Accounts." };
  const words = call.argument.trim();
  if (!words || words === "?" || words === "list") {
    const lines = view.accounts!.map((account) => `${account.id === view.account ? "→ " : "  "}${account.label}${account.keptSeparate ? " (kept separate)" : ""}`);
    return { text: [...noticeOnce(service, view.pool, call.access === "full"), "Type /account followed by a name:", ...lines].join("\n") };
  }
  const mark = /^(separate|not-separate)\s+/i.exec(words)?.[1]?.toLowerCase();
  const asDefault = /^default\s+/i.test(words);
  const wanted = (mark || asDefault ? words.replace(/^\S+\s+/, "") : words).toLowerCase();
  const matches = view.accounts!.filter((account) => account.label.toLowerCase() === wanted || account.id === wanted);
  const found = matches.length ? matches : view.accounts!.filter((account) => account.label.toLowerCase().includes(wanted));
  if (found.length !== 1) {
    const names = view.accounts!.map((account) => account.label).join(", ");
    return { text: found.length ? `More than one account matches "${wanted}": ${names}.` : `There is no account called "${wanted}". You have: ${names}.` };
  }
  if (mark) {
    if (view.kind === "api-key") return { text: "API keys already share work between them; kept separate is for sign-in accounts." };
    await updateAccount(service, { pool: view.pool, account: found[0]!.id, keptSeparate: mark === "separate" });
    return { text: mark === "separate"
      ? `"${found[0]!.label}" is now marked kept separate: it belongs to someone else or to work.`
      : `"${found[0]!.label}" is no longer marked kept separate.` };
  }
  const bySession = !asDefault && call.sessionId;
  const result = switchAccount(service, { pool: view.pool, account: found[0]!.id, ...(bySession ? { sessionId: call.sessionId } : {}) });
  return { text: result.message, client: { do: "refresh-model" } };
}

/**
 * mac7/account-pooling: the one-time notice. Marked as read only where the owner has full access; a
 * read-only look (a dashboard, a phone key) shows it and leaves it for the owner.
 */
function noticeOnce(service: NonNullable<ReturnType<typeof accountsServiceFor>>, pool: string, markRead: boolean): string[] {
  if (!service.settings().poolingNotices.includes(pool)) return [];
  if (markRead) dismissNotice(service, { pool });
  return [poolingNotice(connectionName(service, pool)), ""]; // hardening-3: the same name the window shows
}
