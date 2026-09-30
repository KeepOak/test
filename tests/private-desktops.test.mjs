// SCREEN-090/142: a Trunk's private computer is chosen by the task's own Trunk, never by an argument, and only an
// existing Trunk with Lockdown off gets one; each Trunk's settings sit under their own key. Nothing here starts Docker.
import test from "node:test";
import assert from "node:assert/strict";
import { PrivateDesktops } from "../dist/integrations/private-desktops.js";
import { registerPrivateDesktops } from "../dist/integrations/private-desktop-tools.js";
import { staysOnThisComputer } from "../dist/backup.js";

function store() {
  const rows = new Map();
  return { get: (_t, _o, id) => rows.get(id), save: (_t, _o, id, data) => rows.set(id, { id, data }), event() {},
    profiles: { requireOwner() {} }, rows };
}

test("private computer tools act for the task's own Trunk only; an unknown Trunk gets none", async () => {
  const s = store(), calls = [];
  const desktops = new PrivateDesktops(s, (agent) => agent === "ada");
  const tools = new Map();
  registerPrivateDesktops({ register: (tool) => tools.set(tool.name, tool) }, { start: async (owner, agent) => { calls.push(agent); return {}; } });
  await assert.rejects(async () => tools.get("desktop.private.start").execute({}, { owner: "local" }), /named Trunk context/);
  await tools.get("desktop.private.start").execute({}, { owner: "local", trunk: "ada" });
  assert.deepEqual(calls, ["ada"]);
  await assert.rejects(desktops.create("local", "stranger", "branch-linux-desktop:latest"), /existing Trunk/);
  assert.equal(s.rows.size, 0, "nothing saved for an unknown Trunk");
  assert.equal(staysOnThisComputer("private-desktop-records"), true, "the desktop records stay on this computer");
});
