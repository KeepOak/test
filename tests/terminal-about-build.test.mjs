/**
 * Q55: the terminal's Settings > Updates & about names the installed build as the window does: the
 * version, then the commit it was built from (12 characters), or "not recorded" when there is none.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { commitOfCopy } from "../dist/desktop/build-identity.js";
import { aboutRows, settingsRows } from "../dist/terminal-settings.js";
import { loadWords } from "../dist/terminal-words.js";

const STAMPED = "0123456789abcdef0123456789abcdef01234567";
const LATER = "fedcba9876543210fedcba9876543210fedcba98";

async function copyWith(t, { git }) {
  const root = await mkdtemp(join(tmpdir(), "branch-terminal-about-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "build-info.json"), JSON.stringify({ commit: STAMPED }));
  if (git) await mkdir(join(root, ".git"));
  return root;
}

test("Q55: the terminal's about page names the commit the build came from, in English and French", () => {
  const english = aboutRows(loadWords("en"), "0.19.3", STAMPED);
  assert.equal(english[0].title, "Branch Agent 0.19.3");
  assert.equal(english[1].title, "Built from commit: 0123456789ab");
  assert.equal(english[1].detail, STAMPED);
  const french = aboutRows(loadWords("fr"), "0.19.3", STAMPED);
  assert.equal(french[1].title, "Construite depuis le commit : 0123456789ab");
});

test("Q55: without a recorded commit the terminal says so instead of leaving the line out", () => {
  const [, english] = aboutRows(loadWords("en"), "0.19.3", null);
  assert.equal(english.title, "Built from commit: not recorded");
  assert.equal(english.tone, "muted");
  const [, french] = aboutRows(loadWords("fr"), "0.19.3", null);
  assert.equal(french.title, "Construite depuis le commit : non enregistré");
});

test("Q55: an installed copy believes its stamp; a source checkout only while it is still at that commit", async (t) => {
  const installed = await copyWith(t, { git: false });
  assert.equal(await commitOfCopy(installed, async () => LATER), STAMPED);
  const source = await copyWith(t, { git: true });
  assert.equal(await commitOfCopy(source, async () => STAMPED), STAMPED);
  assert.equal(await commitOfCopy(source, async () => LATER), null);
  assert.equal(await commitOfCopy(source, async () => null), null);
});

test("Q55: Settings > Updates & about in the terminal carries the built-from line before the window pointer", () => {
  const app = { version: "0.19.3", store: { get: () => undefined }, runtime: { owner: "local" } };
  const state = { look: {}, mode: "dark", themeName: "Forest", switches: {} };
  const rows = settingsRows(app, loadWords("en"), "updates", "", state);
  assert.equal(rows[0].title, "Branch Agent 0.19.3");
  assert.match(rows[1].title, /^Built from commit: ([0-9a-f]{12}|not recorded)$/);
});
