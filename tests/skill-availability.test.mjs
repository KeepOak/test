// Upstream skill metadata (OpenClaw-style requires.bins / os) is kept, and a skill whose
// requirements this computer does not meet is shown as not available and left out of the
// model's catalog. Checking starts no program and installs nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { InstalledSkills } from "../dist/skills.js";

const skill = (name, metadata) => `---\nname: ${name}\ndescription: Does ${name} things.\n${metadata}---\nUse it well.\n`;

test("a skill needing a program that is not here is kept, marked unavailable, and left out of the catalog", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings(owner TEXT, id TEXT, data TEXT)");
  const skills = new InstalledSkills(db);
  const missing = skills.install("local", { document: skill("needs-tool",
    "metadata:\n  openclaw:\n    requires:\n      bins: [\"branch-no-such-program-xyz\"]\n    emoji: \"x\"\n") });
  const plain = skills.install("local", { document: skill("plain", "") });
  assert.equal(missing.availability.available, false);
  assert.match(missing.availability.reasons.join(" "), /branch-no-such-program-xyz/);
  assert.equal(plain.availability.available, true);
  assert.deepEqual(skills.catalog("local").map((entry) => entry.name), ["plain"]);
  assert.deepEqual(skills.catalog("local", true).map((entry) => entry.name).sort(), ["needs-tool", "plain"]);
  const kept = skills.read("local", missing.id, { version: 1 }).metadata.metadata;
  assert.equal(kept["openclaw.requires.bins"], "[\"branch-no-such-program-xyz\"]");
  assert.equal(kept["openclaw.emoji"], "x");
});

test("a skill for another system is marked unavailable here", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings(owner TEXT, id TEXT, data TEXT)");
  const skills = new InstalledSkills(db);
  const other = process.platform === "win32" ? "linux" : "windows";
  const view = skills.install("local", { document: skill("elsewhere", `metadata:\n  os: [\"${other}\"]\n`) });
  assert.equal(view.availability.available, false);
  assert.deepEqual(skills.catalog("local"), []);
});
