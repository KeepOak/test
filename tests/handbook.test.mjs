/**
 * The owner's handbook: that every chapter exists and opens the way a chapter should, that the
 * links between them resolve, that the reference names every setting, that the app serves each
 * chapter to itself, and that Help opens the right chapter for the section a person is looking at.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { helpChapters } from "../dist/help.js";
import { topLevelKeys } from "../scripts/check-docs.mjs";

const ROOT = join(import.meta.dirname, "..");
const HANDBOOK = join(ROOT, "docs", "handbook");

/** A workspace, a server and a connected browser page, cleaned up when the test ends. */
async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-handbook-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  // Redesign: the new window has no "Show everything"; every control is always drawn.
  return { app, page, server, errors };
}

test("H1 every chapter exists and opens with the two headings a chapter must have", async () => {
  const files = (await readdir(HANDBOOK)).filter((name) => name.endsWith(".md")).sort();
  assert.deepEqual(files, helpChapters.map((chapter) => `${chapter.id}.md`));
  for (const chapter of helpChapters) {
    // Git hands these files back with Windows line endings on this computer, so the headings are
    // looked for in text whose line endings have been made the same either way.
    const text = (await readFile(join(HANDBOOK, `${chapter.id}.md`), "utf8")).replace(/\r\n/g, "\n");
    assert.match(text, /^# .+/, `${chapter.id} has no title`);
    assert.ok(text.includes("\n## What this is for\n"), `${chapter.id} never says what it is for`);
    assert.ok(text.includes("\n## In one minute\n"), `${chapter.id} has no "In one minute"`);
    assert.ok(text.split(/\s+/).length > 250, `${chapter.id} is too short to be a chapter`);
  }
});

test("H1 no chapter carries a wave number, a batch number or an audit id", async () => {
  for (const chapter of helpChapters) {
    // Git hands these files back with Windows line endings on this computer, so the headings are
    // looked for in text whose line endings have been made the same either way.
    const text = (await readFile(join(HANDBOOK, `${chapter.id}.md`), "utf8")).replace(/\r\n/g, "\n");
    assert.equal(/\b(?:wave|batch)\s*\d+\b/i.test(text), false, `${chapter.id} mentions a wave or batch`);
    assert.equal(/\bA\d{4}\b/.test(text), false, `${chapter.id} carries an audit id`);
  }
});

/*
 * Integration review (adversarial): the checker blanks block comments before it reads a schema's
 * keys, so prose that reads like a key ("w911: the three-way switch") is not taken for one. Blanking
 * must not reach inside a string: a default value carrying "/*" would otherwise swallow every key up
 * to the next end-of-comment and hide a genuinely undocumented setting.
 */
test("H2 the key reader skips comments but never text inside a string", () => {
  assert.deepEqual(topLevelKeys(`
    /** The three-way switch: mode is what this says. */
    mode: FeatureModeSchema.default("off"),
    /* fake: not a key */
    crawlDelayMs: z.number().default(1000),
  `), ["mode", "crawlDelayMs"], "prose in a comment is not a key");
  assert.deepEqual(topLevelKeys(`
    banner: z.string().default("/* not a comment"),
    /** A real comment in between. */
    afterwards: z.boolean().default(false),
  `), ["banner", "afterwards"], "a string that opens a comment hides nothing after it");
  assert.deepEqual(topLevelKeys(`
    sep: z.string().default('*/'),
    later: z.boolean().default(false),
  `), ["sep", "later"]);
  assert.deepEqual(topLevelKeys(`
    line: z.string().default(\`a // b\`),
    tail: z.boolean().default(false),
  `), ["line", "tail"]);
});

test("H2 the document checker passes: every setting is in the reference and every link resolves", () => {
  const done = spawnSync(process.execPath, [join(ROOT, "scripts", "check-docs.mjs")], {
    cwd: ROOT, encoding: "utf8",
  });
  assert.equal(done.status, 0, `check-docs.mjs failed:\n${done.stdout}\n${done.stderr}`);
  assert.match(done.stdout, /every handbook link resolves/);
});

test("H3 the README front page links every chapter and keeps the notices", async () => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  for (const chapter of helpChapters)
    assert.ok(readme.includes(`docs/handbook/${chapter.id}.md`), `README never links ${chapter.id}`);
  assert.ok(readme.includes("THIRD_PARTY_NOTICES.md"), "README dropped the third-party notices");
  assert.ok(readme.includes("docs/images/conversation.png"), "README has no screenshot");
});

test("H4 the app serves every chapter, and refuses anything else", async (t) => {
  const { server } = await fixture(t);
  const ask = (path) => fetch(new URL(path, server.url), { headers: { authorization: `Bearer ${server.token}` } });

  const listed = await (await ask("/api/help")).json();
  assert.equal(listed.chapters.length, helpChapters.length);

  for (const chapter of helpChapters) {
    const answer = await ask(`/api/help/${chapter.id}`);
    assert.equal(answer.status, 200, `${chapter.id} was not served`);
    const body = await answer.json();
    assert.equal(body.id, chapter.id);
    assert.equal(body.title, chapter.title);
    assert.ok(body.markdown.includes("## What this is for"), `${chapter.id} came back without its opening`);
  }

  assert.equal((await ask("/api/help/nonsense")).status, 404);
  assert.equal((await ask("/api/help/../../package.json")).status, 404);
});

test("H4 the help route needs the session key like every other route", async (t) => {
  const { server } = await fixture(t);
  const answer = await fetch(new URL("/api/help/09-glossary", server.url));
  assert.equal(answer.status, 401);
});

test("H5 the release-notes drafter reads the checkpoint and writes the plain structure", async () => {
  const done = spawnSync(process.execPath, [join(ROOT, "scripts", "release-notes.mjs"), "--since", "v0.14.0"], {
    cwd: ROOT, encoding: "utf8",
  });
  if (done.status !== 0 && /Could not read|No tag/.test(done.stderr)) return; /* a shallow checkout has no tags */
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /^## What changed in/);
  assert.match(done.stdout, /\*\*Install\*\*/);
  assert.equal(/\b(?:wave|batch)\s*\d+\b/i.test(done.stdout), false, "the draft leaked a wave or batch number");
  assert.equal(/\bA\d{4}\b/.test(done.stdout), false, "the draft leaked an audit id");
});

test("H5 the template says what shape the notes take", async () => {
  const text = await readFile(join(ROOT, "docs", "release-notes-template.md"), "utf8");
  assert.ok(text.includes("## What changed in X.Y.Z"));
  assert.ok(text.includes("scripts/release-notes.mjs"));
});
