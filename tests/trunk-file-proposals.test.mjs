/* TRUNK-022: a Trunk only proposes a change to its own personality file; the owner sees the exact before and after and
   accepts or rejects it, and a proposal made before the file changed is refused rather than written over the change. */
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./trunks-helpers.mjs";

test("a proposal changes nothing until accepted, a rejection leaves the file, and a stale one is refused", async (t) => {
  const { app } = await fixture(t);
  const trunk = app.trunks.create({ name: "Writer" });
  const permission = app.registry.permissionOf("trunk.propose_file");
  assert.ok(app.runtime.trunkShape({ prompt: "", trunkId: trunk.id }).permissions.includes(permission), "the Trunk's own turn may propose");
  const files = app.trunks.files;
  const text = (name) => files.view(trunk.id).files.find((file) => file.name === name).text;
  files.edit(trunk.id, { name: "USER.md", text: "Likes short answers." });

  const first = files.propose(trunk.id, { name: "USER.md", text: "Likes short answers with sources.", reason: "asked twice for sources" });
  assert.equal(text("USER.md"), "Likes short answers.", "nothing changes on proposing");
  assert.deepEqual(files.view(trunk.id).proposals.map((one) => [one.name, one.before, one.text]),
    [["USER.md", "Likes short answers.", "Likes short answers with sources."]], "the owner sees the exact before and after");
  files.edit(trunk.id, { proposalId: first.id, decision: "accept" });
  assert.equal(text("USER.md"), "Likes short answers with sources.");
  assert.deepEqual(files.view(trunk.id).proposals, []);

  const rejected = files.propose(trunk.id, { name: "USER.md", text: "Something else.", reason: "a guess" });
  files.edit(trunk.id, { proposalId: rejected.id, decision: "reject" });
  assert.equal(text("USER.md"), "Likes short answers with sources.", "a rejection leaves the file as it was");

  const stale = files.propose(trunk.id, { name: "USER.md", text: "Old idea.", reason: "before the owner's edit" });
  files.edit(trunk.id, { name: "USER.md", text: "The owner's own words." });
  assert.throws(() => files.edit(trunk.id, { proposalId: stale.id, decision: "accept" }), /changed after this suggestion/);
  assert.equal(text("USER.md"), "The owner's own words.", "the owner's change is never written over");
  assert.throws(() => files.propose(trunk.id, { name: "USER.md", text: "The owner's own words.", reason: "same" }), /no change to review/);
});
