/**
 * RES-101: Gmail send behind a local preview and a one-time "Send?". The send takes only the preview
 * id, so the approved words are the words sent, and a preview is used once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeStore, fakeWeb, on } from "./personal-kit.mjs";
import { SignIn } from "../dist/personal/signin.js";
import { GoogleConnector, registerGoogle } from "../dist/personal/google.js";
import { personalHold } from "../dist/personal/guard.js";

function setup(mailSend, scope) {
  const store = { ...fakeStore(), run: () => undefined };
  on(store, "google");
  const oauth = { saved: async () => ({ scope }), accessToken: async () => "access-token-1" };
  const signIn = new SignIn({ store, owner: "local", oauth, secret: async () => "" }, "google", "google");
  signIn.save({ clientId: "abc", mailSend });
  const web = fakeWeb([[/\/messages\/send/, { id: "sent-1" }]]);
  const tools = new Map();
  registerGoogle({ register: (tool) => tools.set(tool.name, tool) }, new GoogleConnector(store, "local", web.fetch, signIn));
  const context = { runId: "run-1", source: "owner", approvalKey: "chat-1", signal: new AbortController().signal };
  return { tools, web, context };
}
const draft = { to: ["ada@example.com"], subject: "Plans", text: "See you at ten." };

test("RES-101: a preview is sent once, as previewed, and Send is always asked", async () => {
  const { tools, web, context } = setup(true, "https://www.googleapis.com/auth/gmail.send");
  const made = await tools.get("gmail.preview_send").execute(draft, context);
  assert.equal(web.seen.length, 0);
  assert.equal(personalHold("gmail.send", {}, "owner")?.onceOnly, true);
  assert.match(tools.get("gmail.send").target({ previewId: made.previewId }, context), /Send\?[\s\S]*ada@example\.com[\s\S]*See you at ten\./);
  const sent = await tools.get("gmail.send").execute({ previewId: made.previewId }, context);
  assert.equal(sent.messageId, "sent-1");
  const raw = Buffer.from(JSON.parse(web.seen[0].body).raw, "base64url").toString("utf8");
  assert.match(raw, /To: ada@example.com/);
  assert.ok(raw.includes(Buffer.from("See you at ten.").toString("base64")));
  await assert.rejects(tools.get("gmail.send").execute({ previewId: made.previewId }, context), /expired/);
  assert.equal(web.seen.length, 1);
});

test("RES-101: a drafts or read grant cannot send", async () => {
  const { tools, web, context } = setup(true, "https://www.googleapis.com/auth/gmail.compose");
  const made = await tools.get("gmail.preview_send").execute(draft, context);
  await assert.rejects(tools.get("gmail.send").execute({ previewId: made.previewId }, context), /Sign in again/);
  const off = setup(false, "https://www.googleapis.com/auth/gmail.send");
  const again = await off.tools.get("gmail.preview_send").execute(draft, off.context);
  await assert.rejects(off.tools.get("gmail.send").execute({ previewId: again.previewId }, off.context), /Allow sending/);
  assert.equal(web.seen.length + off.web.seen.length, 0);
});
