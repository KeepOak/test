/**
 * Reading a page with Branch's own browser asks first where the approval rules say so. Each of those questions carries
 * the fingerprint of its exact request, and a yes given with it lets the read go on without asking again; a no refuses.
 *
 * The browser tools here are stand-ins that only count what they were asked to open: no browser starts, and the page's
 * address is never fetched. Temporary folders and a scripted model only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy, saveWebPagesSettings } from "../dist/index.js";
import { argumentFingerprint } from "../dist/runtime.js";
import { discardTemp } from "./temp-dir.mjs";

const hex32 = /^[a-f0-9]{32}$/;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-page-prints-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const provider = { name: "scripted", queue: [],
    async complete() { return provider.queue.shift() ?? { content: "done", toolCalls: [] }; } };
  const app = await createBranch({ workspace, dataDir: join(root, "data"), presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }] });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  saveWebPagesSettings(app.store, owner, { mode: "on" });
  const opened = [];
  app.registry.register({ name: "browser.navigate", permission: "browser.read", description: "stand-in",
    parameters: z.object({ url: z.string() }).strict(), execute: async ({ url }) => { opened.push(url); return { url, title: "stand-in" }; } });
  app.registry.register({ name: "browser.snapshot", permission: "browser.read", description: "stand-in",
    parameters: z.object({}).strict(), execute: async () => ({ url: opened.at(-1), accessibility: "- paragraph: stand-in" }) });
  // Opening the page is allowed by the rules, but its address carries a key, so it is asked about all the same and its
  // yes counts only for these exact bytes. Looking at the page is asked about by the rules themselves.
  savePolicy(app.store, owner, { preset: "custom", rules: [
    { tool: "web.page", match: "*", decision: "allow", remember: "session" },
    { tool: "browser.navigate", match: "*", decision: "allow", remember: "session" },
    { tool: "browser.snapshot", match: "*", decision: "ask", remember: "session" }] });
  const run = (prompt, args, sessionId) => {
    provider.queue.splice(0, provider.queue.length,
      { content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name: "web.page", arguments: JSON.stringify(args) }] });
    return app.runtime.run({ prompt, ...(sessionId ? { sessionId } : {}) });
  };
  const waiting = (sessionId) => app.runtime.waitingApprovals(sessionId);
  const asked = (runId) => app.store.events(runId).filter((event) => event.kind === "policy.ask");
  return { app, opened, run, waiting, asked };
}

const url = "http://127.0.0.1:9/page?api_key=abc123def456";
const read = { url, route: "browser" };

/** Runs the read, answering each question it stops on with `decision` for the browser and yes for the read itself. */
async function answerEach(app, run, waiting, asked, decision) {
  let sessionId, seen = [];
  for (let round = 0; round < 5; round++) {
    const attempt = await run("read the page", read, sessionId);
    sessionId = attempt.sessionId;
    if (attempt.status !== "needs_input") return { sessionId, seen, last: attempt };
    const [question] = waiting(sessionId);
    const [event] = asked(attempt.id).slice(-1);
    seen.push({ tool: question.tool, fingerprint: question.fingerprint, event: event?.data.fingerprint });
    app.runtime.approve(sessionId, question.tool === "web.page" ? "allow" : decision, "session", question.fingerprint);
  }
  throw new Error(`still asking after five answers: ${JSON.stringify(seen)}`);
}

test("the browser's questions for a page carry their fingerprints, and a yes with them lets the page be read", async (t) => {
  const { app, opened, run, waiting, asked } = await fixture(t);
  const { seen, last } = await answerEach(app, run, waiting, asked, "allow");
  assert.equal(last.status, "completed", last.output);
  const browser = seen.filter((one) => one.tool.startsWith("browser."));
  assert.deepEqual(browser.map((one) => one.tool), ["browser.navigate", "browser.snapshot"], "each is asked once, then not again");
  for (const one of browser) {
    assert.match(String(one.fingerprint), hex32, `${one.tool}: the waiting question carries a fingerprint`);
    assert.equal(one.event, one.fingerprint, `${one.tool}: the event carries the same one`);
  }
  assert.equal(browser[0].fingerprint, argumentFingerprint("browser.navigate", JSON.stringify({ url })), "bound to the page it opens");
  assert.equal(browser[1].fingerprint, argumentFingerprint("browser.snapshot", "{}"));
  assert.deepEqual(opened, [url], "the page was opened once, after the yes");
});

test("a no to the browser's question refuses the read and is not asked again", async (t) => {
  const { app, opened, run, waiting, asked } = await fixture(t);
  const { sessionId, seen, last } = await answerEach(app, run, waiting, asked, "deny");
  assert.equal(last.status, "completed", last.output);
  assert.deepEqual(seen.filter((one) => one.tool.startsWith("browser.")).map((one) => one.tool), ["browser.navigate"]);
  assert.equal(asked(last.id).length, 0);
  assert.equal(waiting(sessionId).length, 0);
  assert.deepEqual(opened, [], "nothing was opened");
});
