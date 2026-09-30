/* MODEL-123: a picture made through the owner's ChatGPT sign-in, on the route the Codex app uses, kept with the task.
   It runs only for the owner's own task, on the original ChatGPT address, and never while a dollar cap is set.
   A stand-in fetch answers for ChatGPT; nothing leaves the test. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGPTProvider, createBranch } from "../dist/index.js";
import { MediaTools } from "../dist/media.js";
import { Budget } from "../dist/contracts.js";
import { asPerson } from "../dist/people/context.js";
import { discardTemp } from "./temp-dir.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })}.sig`;
const policy = { guard: (base) => base, assertAllowed: async () => {} };

async function fixture(t, apiBase) {
  const root = await mkdtemp(join(tmpdir(), "branch-chatgpt-pictures-"));
  const provider = new ChatGPTProvider({ accessToken: async () => token }, { model: "gpt-5", ...(apiBase ? { apiBase } : {}), fetch: async () => { throw new Error("no chat here"); } });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  };
  const media = new MediaTools(app.store, app.files, app.runtime.models, policy, fetch);
  media.artifacts = app.artifacts;
  const run = app.store.createRun("local", "make a picture");
  app.store.event(run.id, "run.started", { source: "owner" });
  const context = { owner: "local", workspace: app.runtime.workspace, runId: run.id, signal: AbortSignal.timeout(20000),
    budget: new Budget(), permissions: new Set(["media.write"]), depth: 0 };
  return { app, media, seen, context };
}

test("MODEL-123: the sign-in makes a picture on ChatGPT's own picture route, bound to its account", async (t) => {
  const { app, media, seen, context } = await fixture(t);
  const made = await media.image({ prompt: "a red kite", size: "1024x1024" }, context);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://chatgpt.com/backend-api/codex/images/generations");
  assert.equal(seen[0].headers.authorization, `Bearer ${token}`);
  assert.equal(seen[0].headers["chatgpt-account-id"], "acct_1");
  assert.equal(seen[0].body.model, "gpt-image-2");
  assert.equal(made.mediaType, "image/png");
  assert.equal(made.cost.amount, null, "a plan picture is never claimed as free");
  assert.equal(app.store.events(context.runId).filter((e) => e.kind === "image.generated").length, 1);
});

test("MODEL-123: a household person, a dollar cap, or a proxy address gets no ChatGPT picture, and nothing is sent", async (t) => {
  const { app, media, seen, context } = await fixture(t);
  await assert.rejects(asPerson({ profileId: "kid", keyId: "k1" }, () => media.image({ prompt: "x", size: "1024x1024" }, context)), /Only the owner's own task/);
  app.store.save("settings", "local", "usage_budget", { maxMonthlyDollars: 5 });
  await assert.rejects(media.image({ prompt: "x", size: "1024x1024" }, context), /no bill on file/);
  assert.equal(seen.length, 0);
  const proxied = await fixture(t, "https://proxy.example.com/codex");
  await assert.rejects(proxied.media.image({ prompt: "x", size: "1024x1024" }, proxied.context), /proxy or a different service address/);
  assert.equal(proxied.seen.length, 0);
});
