/* A stand-in chat app of kind "telegram" attached to the real router, with the owner's own account named; the model is
   scripted. Shared by the chat-command tests; nothing leaves this computer. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveOwnerAccounts } from "../dist/reach/platform.js";
import { saveCommandSettings } from "../dist/commands/settings.js";

export async function chatFixture(t, { commands = "when-needed", kind = "telegram", reply = () => ({ content: "Done.", toolCalls: [] }), adapter = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-cmd-"));
  const provider = { name: "scripted", requests: [], async complete(request) { provider.requests.push(request); return reply(request); } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  const sent = [];
  await app.channels.attach({ id: "tg", kind, botName: () => "bot", async start() {}, async stop() {},
    async send(chatId, text, replyTo, format) { sent.push({ chatId, text, format }); return String(sent.length); }, ...adapter },
  { pairing: true, allowlist: ["owner-1", "friend-2"] });
  // Both approved by pairing code, as a real owner's and friend's accounts are; commands stay as shipped (off, except
  // in the owner's own paired direct chat).
  for (const sender of ["owner-1", "friend-2"]) app.store.save("settings", app.runtime.owner, `channel-pair:tg:${sender}`,
    { status: "approved", code: "123456", name: sender, requestedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
  saveOwnerAccounts(app.store, app.runtime.owner, [{ channel: "tg", sender: "owner-1" }]);
  // The shared command table ships off for chat apps; the owner turns it to "when needed" to reach the newer commands.
  if (commands) saveCommandSettings(app.store, app.runtime.owner, { mode: commands });
  let n = 0;
  const say = (senderId, text, extra = {}) => app.channels.handle({ channel: "tg", chatId: `dm-${senderId}`, chatKind: "direct", senderId,
    senderName: senderId, text, addressed: true, messageId: `m${++n}`, ...extra });
  return { app, provider, sent, say, root };
}
export const last = (sent) => sent.at(-1)?.text ?? "";
