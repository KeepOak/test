/**
 * Q12: Branch's never-break check names its own service exactly. The owner's copy of Branch's source
 * (`branch-agent-source/...`) and the repository's name (`stabrea/Branch-Agent`) are not Branch's
 * service, so preparing a change to Branch is no longer refused as "stop Branch itself". Branch's
 * install folder, its service under every spelling the check knew, its process and its updater are
 * still refused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { expandBraces, protectedAreas, protectedTarget } from "../dist/never-break/protected.js";
import { discardTemp } from "./temp-dir.mjs";

// The same areas the never-break tests use: a Linux install in /opt/branch, Branch's process 4242.
const areas = protectedAreas({ workspace: "/home/o/work", dataDir: "/home/o/.branch", installRoot: "/opt/branch",
  platform: "linux", selfPids: [4242, 4241] });
const check = (tool, args, target = "") => protectedTarget({ tool, readOnly: false, args, target }, areas);
const sh = (line) => check("shell.execute", { executable: "sh", args: ["-c", line] });
const stops = /stop, reinstall or update Branch itself/;
const worktree = "/home/o/work/branch-agent-source/.branch-worktrees/self-remove-button";
const contract = { allowedPaths: ["src/ui/**"], permissions: ["files.write"], expectedTests: ["tests/ui.test.mjs"],
  definitionOfDone: "The button is gone", sideEffects: [], rollbackPlan: "Remove the worktree" };

test("the owner's copy of Branch's source and the repository's name are not Branch's service", () => {
  assert.equal(check("branch.prepare_source_change", { name: "remove-button", repository: "https://github.com/stabrea/Branch-Agent.git",
    base: "redesign/window", contract }, worktree), null, "the real prepare_source_change target shape");
  assert.equal(check("files.write", { path: `${worktree}/src/ui/button.ts`, content: "x" }), null);
  assert.equal(check("files.write", { path: "branch-agent-source/src/ui/button.ts", content: "x" }), null);
  assert.equal(check("github.pull_request_from_changes", { name: "self-remove-button", title: "Remove the button", summary: "Why merge this",
    targetRepository: "stabrea/Branch-Agent", base: "redesign/window" }, "send changes to GitHub on branch/self-remove-button and open a pull request"), null);
  assert.equal(sh("git -C branch-agent-source/.branch-worktrees/self-remove-button status"), null);
  assert.equal(sh("npm test --prefix branch-agent-source"), null);
});

test("Branch's service, process, updater and install folder are still refused", () => {
  for (const line of [
    "systemctl --user stop branch-agent.service", "systemctl --user stop branch-agent", "launchctl bootout gui/501/com.keepoak.branch-agent",
    // Named only by the exact service name, with no service tool in front of it.
    "dbus-send --session --dest=org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager.StopUnit string:branch-agent.service string:replace",
    "rm ~/.config/systemd/user/branch-agent.service",
    "rm ~/Library/LaunchAgents/com.keepoak.branch-agent.plist",
    "node dist/cli.js daemon uninstall", "branch update", "pkill -f cli.js", "kill -9 4242",
  ]) assert.match(sh(line) ?? "", stops, line);
  assert.match(check("files.delete", { path: "/opt/branch/dist/cli.js" }) ?? "", /Branch's own files/, "the install folder");
  assert.match(check("files.write", { path: "/home/o/.branch/gateway.json", content: "{}" }) ?? "", /gateway's settings|Branch's own files/);
});

test("in the real app, preparing a change to Branch is no longer refused by the never-break check", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-never-break-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  app.registry.register({ name: "git.push", permission: "git.remote", description: "test double", parameters: z.object({}).passthrough(),
    execute: async () => ({}) });
  const run = app.store.createRun(app.runtime.owner, "change Branch");
  app.store.event(run.id, "run.started", { source: "owner" });
  const context = app.runtime.context({ runId: run.id, source: "owner" });
  const verdict = app.runtime.checkPolicy("branch.prepare_source_change", { name: "remove-button", contract }, context, "fp-prepare");
  assert.notEqual(verdict.decision, "deny", verdict.reason);
  assert.doesNotMatch(verdict.reason ?? "", stops);
});

test("a global reinstall or removal of Branch through a package manager is refused, by name, tarball or folder", () => {
  for (const line of [
    "npm install -g branch-agent@latest", "npm i -g ./branch-agent-2.0.0.tgz", "pnpm add -g branch-agent@latest",
    "yarn global add branch-agent", "bun add -g branch-agent@2.0.0", "npm install -g ../branch-agent", "npm install branch-agent --global",
    "npm uninstall -g branch-agent", "npm update -g branch-agent",
    // Every other way to say "global" (NAS, second review at 4fa4535e).
    "npm install --location=global branch-agent@latest", "npm install --location global branch-agent@latest",
    "npm install --global=true branch-agent@latest", "npm install --global=1 branch-agent@latest",
    "npm_config_global=true npm install branch-agent@latest", "env npm_config_location=global npm i branch-agent@latest",
    "NPM_CONFIG_GLOBAL=1 npm install ./branch-agent-2.0.0.tgz", "npm i -gf branch-agent@latest", "npm i -fg ../branch-agent",
    "pnpm add --global branch-agent@latest", "pnpm remove -g branch-agent", "yarn global remove branch-agent",
    "bun add --global branch-agent@latest", "bun remove -g branch-agent", "/usr/local/bin/npm install -g branch-agent",
    // The termux installer's own spelling: the package only through a variable, named earlier in the same command.
    'PACKAGE=./branch-agent-2.0.0.tgz; npm install -g "$PACKAGE"',
  ]) assert.match(sh(line) ?? "", stops, line);
  for (const line of ["npm install -g typescript", "npm install", "npm i -D @types/node", "npm test --prefix branch-agent-source",
    "npm install --location=project branch-agent-helper", "npm i -f ./branch-agent-source/packages/x"])
    assert.equal(sh(line), null, line);
});

/* Q12: brace patterns are spelled out before anything is checked, as bash, zsh and macOS's /bin/sh do. */
// Fixed POSIX homes, so these layouts read the same on any computer the tests run on (Windows included):
// the commands name the home in full rather than with ~, which each computer spells its own way.
const home = homedir(), H = "/home/u", M = "/Users/u";
const layouts = {
  linux: protectedAreas({ workspace: `${H}/work`, dataDir: `${H}/.local/share/branch-agent/data`,
    installRoot: `${H}/.local/share/branch-agent/app`, platform: "linux", selfPids: [4242],
    extra: [`${H}/.config/systemd/user/branch-agent.service`, "/tmp/branch-agent-update"] }),
  darwin: protectedAreas({ workspace: `${M}/work`, dataDir: `${M}/Library/Application Support/Branch Agent`,
    installRoot: "/Applications/Branch Agent.app", platform: "darwin", selfPids: [4242],
    extra: [`${M}/Library/LaunchAgents/com.keepoak.branch-agent.plist`, "/tmp/branch-agent-update", "/opt/branch"] }),
};
const shIn = (areas, line) => protectedTarget({ tool: "shell.execute", readOnly: false, args: { executable: "sh", args: ["-c", line] }, target: "" }, areas);

test("brace patterns are spelled out the way the shell does", () => {
  assert.deepEqual(expandBraces("~/.local/share/{branch-agent,x}"), ["~/.local/share/branch-agent", "~/.local/share/x"]);
  assert.deepEqual(expandBraces("branch-agent{,}"), ["branch-agent", "branch-agent"]);
  assert.deepEqual(expandBraces("a{b,c{d,e}}f"), ["abf", "acdf", "acef"]);
  assert.deepEqual(expandBraces("{plain}"), ["{plain}"], "a group with no comma is left as written");
  assert.equal(expandBraces("{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}"), null, "past 64 words it is refused, not guessed at");
  assert.deepEqual(expandBraces("branch-agen{s..u}"), ["branch-agens", "branch-agent", "branch-agenu"], "a letter sequence");
  assert.deepEqual(expandBraces("v{1..3}"), ["v1", "v2", "v3"]);
  assert.deepEqual(expandBraces("{10..1..3}"), ["10", "7", "4", "1"], "a number sequence with a step, counting down");
  assert.equal(expandBraces("{1..1000}"), null, "a sequence past 64 words is refused too");
  assert.deepEqual(expandBraces("{a..9}"), ["{a..9}"], "a group that is not a sequence is left as written");
});

const reinstalls = ["npm install -g {branch-agent,x}@latest", "pnpm add -g branch-{agent,x}@latest", "npm i -g ./branch-agent-2.0.0.tgz",
  "pnpm add -g branch-agent@latest", "npm uninstall -g branch-agent"];
const spellings = {
  linux: [
    `rm -rf ${H}/.local/share/{branch-agent,x}`, `rm -rf ${H}/.local/share/branch-agent{,}`, `rm -rf ${H}/.local/share/branch-agent/{app,x}`,
    "rm -rf /tmp/{branch-agent-update,x}", `rm ${H}/.config/systemd/user/{branch-agent.service,x}`,
    `mv ${H}/.config/systemd/user/branch-agent.service{,.off}`,
    `rm -rf ${H}/.local/share/branch-agen{s..u}`, `mv ${H}/.config/systemd/user/branch-agent.servic{d..f}`,
  ],
  darwin: [
    "rm -rf /Applications/{Branch\\ Agent.app,x}", `rm -rf ${M}/Library/Application\\ Support/{Branch\\ Agent,x}`,
    "rm -rf /tmp/{branch-agent-update,x}", "rm -rf /opt/{branch,x}", 'rm -rf "/opt/"{branch,x}',
    `mv ${M}/Library/LaunchAgents/com.keepoak.branch-agent.plist{,.off}`, "launchctl bootout gui/501/com.keepoak.{branch-agent,x}",
    "rm -rf /opt/branc{g..i}",
  ],
};
for (const [name, areas] of Object.entries(layouts)) {
  test(`every brace spelling of Branch's own places is refused (${name} layout)`, () => {
    for (const line of [...spellings[name], ...reinstalls]) assert.notEqual(shIn(areas, line), null, `${name}: ${line}`);
    assert.match(shIn(areas, "echo {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}") ?? "", /brace patterns stand for more places than Branch can check/);
    assert.equal(shIn(areas, "echo {one,two}.txt"), null, "an ordinary brace pattern is fine");
    const json = JSON.stringify(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, index])));
    assert.equal(protectedTarget({ tool: "files.write", readOnly: false, args: { path: "notes/data.json", content: json }, target: "notes/data.json" }, areas),
      null, "a file tool's JSON is taken literally, not as a brace pattern");
  });
}

test("the systemd drop-in folder of Branch's service is refused like the unit file", () => {
  const dropIn = "~/.config/systemd/user/branch-agent.service.d";
  for (const line of [`rm -rf ${dropIn}`, `mkdir -p ${dropIn} && printf '[Service]\\nExecStart=\\n' > ${dropIn}/override.conf`, `mv ${dropIn}{,.off}`])
    assert.match(sh(line) ?? "", stops, line);
  assert.match(check("files.write", { path: "/home/o/.config/systemd/user/branch-agent.service.d/override.conf", content: "[Service]\n" }) ?? "", stops);
  // systemd also applies the "branch-" prefix drop-in and the one for every service to Branch's unit.
  for (const line of ["rm -rf ~/.config/systemd/user/branch-.service.d", "echo x > ~/.config/systemd/user/service.d/override.conf",
    "mv /etc/systemd/system/service.d{,.off}"]) assert.match(sh(line) ?? "", stops, line);
  assert.equal(sh("rm -rf ~/.config/systemd/user/other.service.d"), null, "another service's drop-in is not Branch's");
});

test("NAS's own spelling with $TMPDIR is refused on this computer's layout", () => {
  // The updater's folder sits under this computer's temporary folder, which $TMPDIR names; where it is
  // not set, the variable cannot be read and the removal is refused as unreadable instead.
  const here = protectedAreas({ workspace: join(home, "work"), dataDir: join(home, ".never-branch-data"), installRoot: "/opt/branch", platform: process.platform });
  assert.notEqual(shIn(here, "rm -rf $TMPDIR/{branch-agent-update,x}"), null);
});

test("a brace group holding a quoted space is spelled out as the shell does it", () => {
  const areas = layouts.linux;
  for (const line of [
    `rm -rf ${H}/.local/share/{branch-agent,"a b"}`, `rm -rf ${H}/.local/share/{branch-agent,'a b'}`, `rm -rf ${H}/.local/share/{"a b",branch-agent}`,
    `mv ${H}/.config/systemd/user/branch-agent.service{,".off x"}`, `rm -rf ${H}/.local/share/{branch-agent,a\\ b}`,
    `rm -rf ${H}/.local/share/branch{-agent,"-x y"}`,
  ]) assert.notEqual(shIn(areas, line), null, line);
  // Braces entirely inside quotes are not opened by bash: the command names a folder literally called
  // "{branch-agent,x}", which is not Branch's, so never-break lets it through, as the shell would run it.
  assert.equal(shIn(areas, `rm -rf "${H}/.local/share/{branch-agent,x}"`), null);
  assert.equal(shIn(areas, "echo '{a,b}' {c,\"d e\"}"), null, "an ordinary quoted brace pattern is fine");
});
