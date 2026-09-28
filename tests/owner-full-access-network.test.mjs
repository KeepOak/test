/**
 * selfdev: in the owner's selected Full Access a command held to the self-development worktree may reach the
 * network (npm install, downloads); its writes stay held there. Nobody else's command, and no command outside
 * that mode, gets it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { confinedWall, installsPackages } from "../dist/integrations/shell.js";
import { npmScript, wslHeldPlan } from "../dist/integrations/wsl-held.js";
import { discardTemp } from "./temp-dir.mjs";

test("a held command's wall opens the network only when asked for the owner's Full Access, and never widens writes", () => {
  const shut = confinedWall(undefined, {});
  assert.equal(shut.network, "none");
  assert.equal(shut.answer("network.site", "example.com"), "deny");
  const open = confinedWall(undefined, { open: true });
  assert.equal(open.network, "open");
  assert.equal(open.answer("network.site", "example.com"), "allow");
  assert.equal(open.answer("sandbox.write", "C:/elsewhere"), "deny", "writes stay held to the worktree");
  assert.deepEqual(open.keySites, {}, "no saved key is swapped in");
  const plan = (extra) => wslHeldPlan({ executable: { path: "C:/Program Files/nodejs/npm.cmd", args: [] }, args: ["install"], cwd: "C:/w/x",
    workspace: "C:/w", env: {}, secrets: [], registry: false, timeoutMs: 1000, ...extra });
  assert.equal(plan({}).open, undefined);
  assert.equal(plan({ open: true }).open, true);
});

test("Windows' npm alias (node.exe with npm-cli.js) runs as npm inside WSL, and npm ci is still recognised", () => {
  const alias = { path: "C:/Program Files/nodejs/node.exe", args: ["C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js"] };
  assert.equal(npmScript(alias.args[0]), "npm");
  assert.equal(npmScript("C:/x/node_modules/npm/bin/npx-cli.js"), "npx");
  assert.equal(npmScript("C:/x/tools/npm-cli.js"), null, "only npm's own script");
  const plan = wslHeldPlan({ executable: alias, args: ["ci"], cwd: "C:/w/x", workspace: "C:/w", env: {}, secrets: [], registry: true, timeoutMs: 1000 });
  assert.equal(plan.program, "npm");
  assert.deepEqual(plan.args, ["ci"], "the Windows script path never goes into WSL");
  assert.equal(installsPackages(alias, ["ci"]), true);
  assert.equal(installsPackages(alias, ["ci", "--foreground-scripts"]), false);
  assert.equal(installsPackages({ path: "C:/node.exe", args: [] }, ["ci"]), false, "plain node is not npm");
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-full-network-"));
  const call = { id: "cmd", name: "shell.execute", arguments: JSON.stringify({ executable: "node", args: ["-v"] }) };
  let turn = 0;
  const provider = { name: "scripted", async complete() { return ++turn % 2 ? { content: "", toolCalls: [call] } : { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const seen = [];
  app.registry.unregister("shell.execute");
  app.registry.register({ name: "shell.execute", permission: "shell.execute", description: "stand-in", parameters: z.object({}).passthrough(),
    execute: async (_input, context) => { seen.push(context.ownerFullAccess); return { status: "completed", exitCode: 0, stdout: "v24" }; } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const run = async (body) => {
    const response = await fetch(new URL("/api/run", server.url), { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return response.json();
  };
  return { app, run, seen };
}

test("the runtime marks a command for the network only in the owner's selected Full Access", async (t) => {
  const { app, run, seen } = await fixture(t);
  const full = await run({ prompt: "Run it", mode: "full" });
  assert.equal(full.status, "completed", full.output);
  assert.deepEqual(seen, [true]);
  // The owner's own setting may let every command run, but that is not a selected Full Access conversation.
  savePolicy(app.store, app.runtime.owner, { preset: "off", rules: [], unmatchedCommands: "allow" });
  app.store.save("settings", app.runtime.owner, "conversation-mode-settings", { newConversation: "follow" });
  const loose = await run({ prompt: "Run it" });
  assert.equal(loose.status, "completed", loose.output);
  assert.deepEqual(seen, [true, undefined]);
});
