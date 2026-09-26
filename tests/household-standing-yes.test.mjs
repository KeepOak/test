/**
 * Q182: a household person answers their own task's questions, but a standing yes ("Yes, always") is a rule in the
 * owner's own policy, which then covers the owner's tasks too, and an adult "may not change how Branch is set up".
 * So only the owner gives one: the engine refuses it from anyone else, and their window does not offer it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { runForCurrentPerson } from "../dist/collab-server.js";
import { readPolicy, savePolicy } from "../dist/policy.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

/** A model that writes one file when asked to, then says it is done. */
const writer = { name: "writer", async complete(request) {
  const last = request.messages.at(-1);
  if (last?.role === "user" && /^write /.test(String(last.content)))
    return { content: "", toolCalls: [{ id: `w${Date.now()}`, name: "files.write", arguments: JSON.stringify({ path: String(last.content).slice(6).trim(), content: "hello" }) }] };
  return { content: "Done.", toolCalls: [] };
} };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-standing-yes-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writer });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await app.close(); await discardTemp(root); });
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.runtime.roles.save(sam.id, { role: "adult" });
  const rules = () => readPolicy(app.store, app.runtime.owner).rules.filter((rule) => rule.tool === "files.write");
  return { app, root, sam, rules };
}

test("a household adult's Always is refused and writes nothing; once and this conversation still work", async (t) => {
  const { app, sam, rules } = await fixture(t);
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const run = await runForCurrentPerson(app, { prompt: "write notes.txt", onTextDelta: () => undefined });
  const asked = app.runtime.approvals.questionFor(run.sessionId);
  assert.ok(asked, "control: Sam's task asks before writing");
  assert.equal(asked.source, "owner", "a household person's own task carries the window's source");
  assert.throws(() => app.runtime.approve(run.sessionId, "allow", "always", asked.fingerprint), /the owner's to give/);
  assert.deepEqual(rules(), [], "the owner's policy is unchanged");
  assert.ok(app.runtime.approvals.questionFor(run.sessionId, asked.fingerprint), "the question is still waiting for an answer");
  assert.equal(app.runtime.approve(run.sessionId, "allow", "session", asked.fingerprint).remembered, "session");
  assert.deepEqual(rules(), []);
});

test("the owner's own Always still writes the rule", async (t) => {
  const { app, rules } = await fixture(t);
  const run = await app.runtime.run({ prompt: "write owner.txt" });
  const asked = app.runtime.approvals.questionFor(run.sessionId);
  assert.equal(app.runtime.approve(run.sessionId, "allow", "always", asked.fingerprint).remembered, "always");
  assert.equal(rules().length, 1);
});

test("a household window is not offered Yes, always; the owner's window is", async (t) => {
  const { app, root, sam } = await fixture(t);
  // New conversations follow the owner's rules, not Ask first (which keeps no standing yes for anybody, Q59).
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  app.store.save("settings", app.runtime.owner, "onboarding", { done: true }); // setup opens on the first draw otherwise (flows/flows.js); not what this is about
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const ask = async (file) => {
    await page.locator("#prompt").fill(`write ${file}`);
    await page.locator("#send").click();
    const card = page.locator("#live-ask");
    await card.waitFor({ state: "visible", timeout: 20000 });
    return (await card.locator("button").allTextContents()).map((text) => text.trim());
  };
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  if (await page.locator("#first-run").isVisible()) await page.locator("#first-run-done").click().catch(() => undefined);
  // The redesigned window's card: the tool's verb (once), "Always allow" (the standing yes) and "Don't allow".
  const mine = await ask("owner.txt"); assert.ok(mine.includes("Always allow"), `control: the owner is offered a standing yes: ${mine}`);
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  // The redesigned window reads who is here (GET /api/profiles) with its first state, before it draws anything.
  const offered = await ask("sam.txt");
  assert.ok(offered.includes("Change it"), `Sam can still say yes: ${offered}`);
  assert.equal(offered.includes("Always allow"), false, `Sam is not offered a standing yes: ${offered}`);
  assert.deepEqual(errors, []);
});

test("a short-lived key never makes a standing rule: approve refuses, and a flow carried on takes it as this conversation (NAS 68eb8b2)", async (t) => {
  const { app, rules } = await fixture(t);
  const run = await app.runtime.run({ prompt: "write key.txt" });
  const asked = app.runtime.approvals.questionFor(run.sessionId);
  assert.throws(() => underShortLivedKey(() => app.runtime.approve(run.sessionId, "allow", "always", asked.fingerprint), { keyId: "k1" }),
    /the owner's to give/);
  assert.deepEqual(rules(), []);
  // A graph flow's question carries its own "always"; a key carrying the flow on is the same shape as this call.
  underShortLivedKey(() => app.runtime.grantApproval("flow-key", { tool: "files.write", target: "g1.txt", label: "Write g1.txt", source: "owner" }, "always"),
    { keyId: "k1" });
  assert.deepEqual(rules(), [], "no standing rule in the owner's policy");
  assert.equal(app.runtime.approvals.answer("flow-key", "files.write", "g1.txt"), "allow", "the flow may still carry on in its own conversation");
  // Control: the owner's own flow keeps its standing yes.
  app.runtime.grantApproval("flow-owner", { tool: "files.write", target: "g2.txt", label: "Write g2.txt", source: "owner" }, "always");
  assert.equal(rules().length, 1);
});
