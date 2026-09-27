import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, offLimitsToShortLivedKeys } from "../dist/server.js";
import { zipWrite, packSkill } from "../dist/skill-package.js";
import { readAgentSkill, agentSkillPackage, writeAgentSkill } from "../dist/agent-skills.js";
import { zipRead } from "../dist/skill-package.js";

/* Bucket 12 (A0776, A2374): Agent Skills folders in and out, and the written account of every
   install and removal made while Branch runs. No network; every file is made here. */

const skill = (name, body = "Use this when the owner asks for a tidy summary.") =>
  `---\nname: ${name}\ndescription: Tidy summaries of long notes.\nlicense: MIT\nmetadata:\n  version: "1.2.0"\n---\n\n# ${name}\n\n${body}\n`;
const folder = (name = "tidy-summary", extra = []) => zipWrite([
  [`${name}/`, ""],
  [`${name}/SKILL.md`, skill(name)],
  [`${name}/references/`, ""],
  [`${name}/references/style guide.md`, "Short sentences. No jargon."],
  [`${name}/scripts/run.py`, "print('never run')"],
  [`${name}/assets/logo.svg`, "<svg/>"],
  ["__MACOSX/._SKILL.md", "junk"],
  ...extra,
]);

test("A0776: an Agent Skills folder is read as the layout says, and its programs are named, never kept", () => {
  const read = readAgentSkill(folder());
  assert.equal(read.name, "tidy-summary");
  assert.equal(read.folder, "tidy-summary");
  assert.deepEqual(Object.keys(read.notes), ["reference-style-guide.md"]);
  assert.match(read.document, /## Reference: style-guide\.md\n\nShort sentences\. No jargon\./);
  assert.deepEqual(read.leftOut.map((item) => item.path).sort(), ["tidy-summary/assets/logo.svg", "tidy-summary/scripts/run.py"]);
  assert.match(read.leftOut.find((item) => item.path.endsWith("run.py")).why, /does not run a skill's own programs/);
  const unpacked = zipRead(agentSkillPackage(read), undefined);
  assert.deepEqual([...unpacked.keys()].sort(), ["SKILL.md", "branch-package.json", "reference-style-guide.md"]);
  assert.equal(JSON.parse(unpacked.get("branch-package.json")).packageVersion, "1.2.0", "the version in the skill's metadata is kept");
  // SKILL.md at the top of the file is a folder too.
  assert.equal(readAgentSkill(zipWrite([["SKILL.md", skill("top-level")]])).folder, null);
});

test("A0776: a folder that breaks the layout is refused before anything is installed", () => {
  assert.throws(() => readAgentSkill(zipWrite([["other-name/SKILL.md", skill("tidy-summary")]])), /needs the two to match/);
  assert.throws(() => readAgentSkill(zipWrite([["a/SKILL.md", skill("a")], ["b/SKILL.md", skill("b")]])), /more than one skill/);
  assert.throws(() => readAgentSkill(zipWrite([["notes/readme.md", "x"]])), /no SKILL\.md/);
  assert.throws(() => readAgentSkill(folder("tidy-summary", [["tidy-summary/../../etc/passwd", "x"]])), /not a plain file name/);
  assert.throws(() => readAgentSkill(zipWrite([["Bad_Name/SKILL.md", skill("Bad_Name")]])));
  assert.throws(() => readAgentSkill(zipWrite([["x/SKILL.md", "no front matter"]])), /frontmatter/);
  const many = Array.from({ length: 70 }, (_, i) => [`tidy-summary/references/n${i}.md`, "x"]);
  assert.throws(() => readAgentSkill(folder("tidy-summary", many)), /more files than allowed/);
});

test("A0776: a skill written out as an Agent Skills folder reads back the same, references and all", () => {
  const read = readAgentSkill(folder());
  const written = writeAgentSkill(read.document, read.notes);
  assert.equal(written.filename, "tidy-summary.zip");
  const files = zipRead(Buffer.from(written.base64, "base64"), { entries: 16, entryBytes: 1e6, totalBytes: 1e6 }, () => true);
  assert.deepEqual([...files.keys()], ["tidy-summary/SKILL.md", "tidy-summary/references/style-guide.md"]);
  assert.doesNotMatch(files.get("tidy-summary/SKILL.md"), /## Reference/, "the reference goes back to its own file");
  const again = readAgentSkill(Buffer.from(written.base64, "base64"));
  assert.equal(again.document, read.document, "reading it again does not add the reference twice");
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-skill-installs-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const json = async (path, body, key = server.token) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, json };
}
const file = (bytes) => bytes.toString("base64");

test("A2374: installing and removing while Branch runs writes down every step, and why it stopped", async (t) => {
  const { app, json } = await fixture(t);
  const owner = app.runtime.owner;
  // The ship-on rule: installing skills ships "when needed" (src/skill-installs.ts); each install still needs approve.
  assert.equal((await json("/api/skill-installs")).body.mode, "when-needed");
  assert.equal((await json("/api/skill-installs/settings", { mode: "off" })).status, 200);
  assert.match((await json("/api/skill-installs/install", { kind: "agent-skill", file: file(folder()), approve: true })).body.error, /switched off/);
  assert.equal((await json("/api/skill-installs/settings", { mode: "on" })).status, 200);

  const looked = await json("/api/skill-installs/inspect", { file: file(folder()) });
  assert.equal(looked.body.folder.name, "tidy-summary");
  assert.equal(app.store.skills.list(owner).length, 0, "looking installs nothing");

  const installed = await json("/api/skill-installs/install", { kind: "agent-skill", file: file(folder()), approve: true });
  assert.equal(installed.status, 200);
  const record = installed.body.record;
  assert.equal(record.ok, true);
  assert.equal(record.name, "tidy-summary");
  const steps = record.steps.join("\n");
  for (const part of [/Opened the file/, /Agent Skills folder "tidy-summary" with 1 text reference/, /Left out tidy-summary\/scripts\/run\.py/,
    /matches its fingerprint \(tidy-summary 1\.2\.0/, /It asks to:/, /The scan found nothing/, /switched off until you turn it on/])
    assert.match(steps, part);
  const [only] = app.store.skills.list(owner);
  assert.equal(only.activeVersion, null, "it arrives switched off");

  const again = await json("/api/skill-installs/install", { kind: "agent-skill", file: file(folder()), approve: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.record.ok, false);
  assert.match(again.body.record.error, /already installed/);
  assert.match(again.body.record.steps.at(-1), /^Stopped: /);

  const pasted = await json("/api/skill-installs/install", { kind: "document", document: skill("pasted-one") });
  assert.equal(pasted.body.record.ok, true);
  assert.match(pasted.body.record.steps.join(" "), /Read the pasted instructions/);

  const exported = await json(`/api/skill-installs/export?skill=${only.id}`);
  assert.equal(readAgentSkill(Buffer.from(exported.body.base64, "base64")).name, "tidy-summary");

  const removed = await json("/api/skill-installs/remove", { skillId: only.id });
  assert.equal(removed.body.record.ok, true);
  assert.match(removed.body.record.steps.join(" "), /Removed "tidy-summary", which was switched off/);
  assert.equal(app.store.skills.list(owner).some((entry) => entry.id === only.id), false);
  assert.equal(app.skillPackages.list().length, 0, "its package is forgotten too");

  const view = (await json("/api/skill-installs")).body;
  assert.deepEqual(view.records.map((entry) => [entry.action, entry.ok]), [["remove", true], ["install", true], ["install", false], ["install", true]]);
  assert.deepEqual(view.skills.map((entry) => entry.name), ["pasted-one"]);
});

test("A2374: a Branch package goes through the same record, and a short-lived key can only read it", async (t) => {
  const { app, json } = await fixture(t);
  await json("/api/skill-installs/settings", { mode: "when-needed" });
  const bytes = packSkill({ files: { "SKILL.md": skill("packed-one") }, author: "Sam", packageVersion: "2.0.0" });
  const preview = await json("/api/skill-installs/install", { kind: "package", file: file(bytes) });
  assert.match(preview.body.record.steps.at(-1), /waiting for your yes/);
  assert.equal(app.store.skills.list(app.runtime.owner).length, 0);
  const done = await json("/api/skill-installs/install", { kind: "package", file: file(bytes), approve: true });
  assert.match(done.body.record.steps.join(" "), /packed-one 2\.0\.0 by Sam/);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run" }).token;
  assert.equal((await json("/api/skill-installs", undefined, key)).status, 200);
  for (const path of ["/api/skill-installs/settings", "/api/skill-installs/inspect", "/api/skill-installs/install", "/api/skill-installs/remove"]) {
    assert.ok(offLimitsToShortLivedKeys("POST", path), path);
    assert.equal((await json(path, {}, key)).status, 401, path);
  }
});

// ---- integrator adversarial pass (bucket 12) ------------------------------------------------------

import { deflateRawSync } from "node:zlib";
/** Sets the Unix mode a zip entry claims in its central directory (e.g. a symbolic link). */
function withMode(bytes, entryName, mode) {
  const copy = Buffer.from(bytes);
  for (let at = 0; at + 46 <= copy.length; at++) {
    if (copy.readUInt32LE(at) !== 0x02014b50) continue;
    const name = copy.toString("utf8", at + 46, at + 46 + copy.readUInt16LE(at + 28));
    if (name === entryName) { copy.writeUInt16LE(0x0314, at + 4); copy.writeUInt32LE(mode * 0x10000, at + 38); }
  }
  return copy;
}

test("integrator: a zip entry that inflates past what it declares is stopped before it fills memory", () => {
  const bomb = Buffer.alloc(8 * 1024 * 1024);
  // Swap the tiny reference's data for 8 MB of zeros, while the directory still says it is 1 byte.
  const packed = deflateRawSync(bomb);
  let offset = 0;
  const entries = [["tidy-summary/SKILL.md", Buffer.from(skill("tidy-summary"))], ["tidy-summary/references/big.md", null]];
  const locals = [], central = [];
  for (const [name, data] of entries) {
    const label = Buffer.from(name), body = data ? deflateRawSync(data) : packed, size = data ? data.length : 1;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(label.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(size, 24); dir.writeUInt16LE(label.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(local, label, body); central.push(dir, label); offset += 30 + label.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  assert.throws(() => readAgentSkill(Buffer.concat([...locals, directory, end])), /more data than allowed/);
});

test("integrator: a symbolic link inside a skill folder is refused, not read as text", () => {
  const zip = withMode(folder("tidy-summary", [["tidy-summary/references/link.md", "/etc/passwd"]]), "tidy-summary/references/link.md", 0o120777);
  assert.throws(() => readAgentSkill(zip), /link/);
  const plain = withMode(folder(), "tidy-summary/references/style guide.md", 0o100644);
  assert.equal(readAgentSkill(plain).name, "tidy-summary", "an ordinary file with a Unix mode still reads");
});

test("integrator: pasted instructions arrive switched off, and an export never carries a key", async (t) => {
  const { app, json } = await fixture(t);
  const owner = app.runtime.owner;
  await json("/api/skill-installs/settings", { mode: "on" });
  const pasted = await json("/api/skill-installs/install", { kind: "document", document: skill("pasted-one") });
  assert.equal(pasted.body.record.ok, true);
  assert.match(pasted.body.record.steps.join(" "), /switched off until you turn it on/);
  assert.equal(app.store.skills.list(owner).find((entry) => entry.name === "pasted-one").activeVersion, null);

  // A reference too long to add to the instructions is kept with the package without being scanned.
  const long = `${"Background. ".repeat(1600)}\napi_key=abcdefghijklmnopqrstuvwx1234\n`;
  const leaky = await json("/api/skill-installs/install", { kind: "agent-skill", approve: true,
    file: file(zipWrite([["leaky-one/SKILL.md", skill("leaky-one")], ["leaky-one/references/notes.md", long]])) });
  assert.equal(leaky.body.record.ok, true);
  assert.match(leaky.body.record.steps.join(" "), /too long to add/);
  const id = app.store.skills.list(owner).find((entry) => entry.name === "leaky-one").id;
  const exported = await json(`/api/skill-installs/export?skill=${id}`);
  assert.notEqual(exported.status, 200);
  assert.doesNotMatch(JSON.stringify(exported.body), /abcdefghijklmnopqrstuvwx1234/);
  assert.match(exported.body.error, /key|secret/i);
});
