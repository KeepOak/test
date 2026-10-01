import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { MorningBrief } from "../dist/brief.js";

/* TRUNK-127: the morning brief cites the public health and news pages the owner picked, with links, read only when it
   is sent or refreshed; with no pages picked it has no such headings at all. */
async function fixture(t, page = { text: "Rain later today. Bring a coat." }) {
  const root = await mkdtemp(join(tmpdir(), "branch-brief-sources-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const web = { fetched: [], privateOn: false,
    settings() { return { allowPrivateAddresses: this.privateOn }; },
    async fetchPage(url) { this.fetched.push(url); return { url, text: page.text }; },
    injectionPolicy: "block" };
  return { app, web, brief: new MorningBrief(app.store, undefined, undefined, undefined, web) };
}

test("with no pages picked the brief has no health or news headings", async (t) => {
  const { brief } = await fixture(t);
  const { markdown } = brief.preview("local");
  assert.doesNotMatch(markdown, /Health sources|News sources|sources selected/);
  assert.match(markdown, /\*\*Reminders\*\*/);
});

test("a picked news page is cited with its link, read on refresh and never by preview", async (t) => {
  const { brief, web } = await fixture(t);
  brief.configure("local", { sources: [{ section: "news", label: "Town news", url: "https://news.example/today" }] });
  assert.match(brief.preview("local").markdown, /\*\*News sources\*\*\n- \[Town news\]\(https:\/\/news\.example\/today\) — not read yet/);
  assert.deepEqual(web.fetched, [], "preview reads nothing");
  const { markdown } = await brief.refresh("local");
  assert.deepEqual(web.fetched, ["https://news.example/today"]);
  assert.match(markdown, /- \[Town news\]\(https:\/\/news\.example\/today\) — Page excerpt: Rain later today\. Bring a coat\. \(checked /);
  assert.doesNotMatch(markdown, /Health sources/, "no health page was picked");
});

test("a picked page is never read while private addresses are allowed, and says so", async (t) => {
  const { brief, web } = await fixture(t);
  web.privateOn = true;
  brief.configure("local", { sources: [{ section: "health", label: "Pollen", url: "https://health.example/pollen" }] });
  const { markdown } = await brief.refresh("local");
  assert.deepEqual(web.fetched, []);
  assert.match(markdown, /\[Pollen\]\(https:\/\/health\.example\/pollen\) — Source unavailable; no excerpt retained\./);
  assert.throws(() => brief.configure("local", { sources: [{ section: "news", label: "x", url: "file:///etc/passwd" }] }));
});
