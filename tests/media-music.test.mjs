/**
 * MODEL-131: media.music makes one 30-second MP3 clip through the owner's chosen Gemini API-key connection, keeps it
 * with the task, and refuses plainly where it cannot run. A stand-in fetch answers for Google; nothing leaves the test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { MediaTools } from "../dist/media.js";
import { GeminiProvider, OpenAIProvider } from "../dist/providers.js";
import { Budget } from "../dist/contracts.js";

const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(61, 1)]);
const google = "https://generativelanguage.googleapis.com";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-music-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body), redirect: init.redirect });
    return Response.json({ candidates: [{ content: { parts: [{ text: "Verse: rivers" }, { inlineData: { mimeType: "audio/mpeg", data: mp3.toString("base64") } }] } }] });
  };
  const media = new MediaTools(app.store, app.files, app.runtime.models, { guard: (base) => base }, fetch);
  media.artifacts = app.artifacts;
  app.runtime.models.register({ id: "gem", name: "Gemini", provider: new GeminiProvider({ endpoint: google, model: "gemini-2.5-flash", apiKey: "secret-key" }), model: "gemini-2.5-flash" });
  app.runtime.models.register({ id: "elsewhere", name: "Elsewhere", provider: new GeminiProvider({ endpoint: "https://gemini.example.com", model: "gemini-2.5-flash", apiKey: "k" }), model: "gemini-2.5-flash" });
  app.runtime.models.register({ id: "oai", name: "OpenAI", provider: new OpenAIProvider({ endpoint: "https://api.openai.com/v1", model: "gpt-4o", apiKey: "k" }), model: "gpt-4o" });
  return { app, media, seen, workspace: join(root, "workspace") };
}
const context = (app, extra = {}) => ({ owner: "local", workspace: app.runtime.workspace, runId: app.store.createRun("local", "music").id, signal: AbortSignal.timeout(20000),
  budget: new Budget(), permissions: new Set(["media.write"]), depth: 0, ...extra });

test("MODEL-131: a clip is asked of Google's music model with the key in a header, and kept with the task", async (t) => {
  const { app, media, seen } = await fixture(t);
  const task = context(app);
  const made = await media.music({ connection: "gem", prompt: "a calm piano theme", instrumental: true, save: "theme.mp3" }, task);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${google}/v1beta/models/lyria-3-clip-preview:generateContent`);
  assert.equal(seen[0].headers["x-goog-api-key"], "secret-key");
  assert.doesNotMatch(seen[0].url, /secret-key/);
  assert.equal(seen[0].redirect, "error");
  assert.match(seen[0].body.contents[0].parts[0].text, /calm piano theme\nInstrumental only, no vocals\./);
  assert.equal(made.mediaType, "audio/mpeg");
  assert.equal(made.lyrics, "Verse: rivers");
  assert.equal(made.cost.amount, null, "an unknown price is never claimed as free");
  assert.ok(made.savedAs.endsWith("theme.mp3"));
  assert.deepEqual(await readFile(join(app.runtime.workspace, made.savedAs)), mp3);
  assert.equal(app.store.events(task.runId).filter((e) => e.kind === "music.generated").length, 1);
});

test("MODEL-131: practice says what it would ask and sends nothing", async (t) => {
  const { app, media, seen } = await fixture(t);
  const would = await media.music({ connection: "gem", prompt: "a march" }, context(app, { dryRun: true }));
  assert.equal(would.wouldMake, "a music clip");
  assert.equal(seen.length, 0);
});

test("MODEL-131: a connection that is not Google's own Gemini, or a dollar cap, is refused before anything is sent", async (t) => {
  const { app, media, seen } = await fixture(t);
  await assert.rejects(media.music({ connection: "elsewhere", prompt: "x" }, context(app)), /Google Gemini connection with an API key at Google's own address/);
  await assert.rejects(media.music({ connection: "oai", prompt: "x" }, context(app)), /Google Gemini API-key connection/);
  await assert.rejects(media.music({ connection: "missing", prompt: "x" }, context(app)), /not set up/);
  app.store.save("settings", "local", "usage_budget", { maxMonthlyDollars: 5 });
  await assert.rejects(media.music({ connection: "gem", prompt: "x" }, context(app)), /price is not on file/);
  assert.equal(seen.length, 0);
});
