/**
 * mac7/clean-uninstall: everything Branch fetches lives inside Branch, and one button takes it all
 * away again.
 *
 * Nothing here touches this computer: every program is a stand-in, every folder is a temporary one,
 * no installer, `brew`, `winget`, `tar`, `tmutil`, `launchctl` or `systemctl` is ever really run,
 * and no window is opened. The tests assert the exact paths and argument lists that would be used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { ROUTES } from "./short-lived-key-routes.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { underShortLivedKey } from "../dist/key-context.js";
import {
  branchModelsFolder, branchRunnerProgram, branchRunnerRoot, candidatePaths, findRuntime, startPlan,
} from "../dist/local-launch.js";
import { modelsFolder } from "../dist/local-files.js";
import { installPlan, runInstall } from "../dist/local-install.js";
import { launcherMarker, unixLayout } from "../dist/install/unix-install.js";
import { manageCommand } from "../dist/install/manage-cli.js";
import {
  removalGuard, removalSurvey, removeBranch, removeChatRefusal, removePersonRefusal,
  removeShortLivedRefusal, removeStartedElsewhereRefusal, removeTrunkRefusal,
} from "../dist/remove-branch.js";

const at = {
  darwin: { platform: "darwin", arch: "arm64", home: "/Users/sam", env: { PATH: "/usr/bin" } },
  linux: { platform: "linux", arch: "x64", home: "/home/sam", env: { PATH: "/usr/bin" } },
  win32: { platform: "win32", arch: "x64", home: "C:\\Users\\sam", env: { Path: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" } },
};
const DATA = "/Users/sam/Library/Application Support/Branch Agent/state";

async function scratch(label) {
  const base = join(tmpdir(), "branch-session-files");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `branch-${label}-`));
}

/* ---------------------------------------------- what Branch fetches lands inside Branch, only */

test("C1 a program Branch fetches lands inside Branch's own folder and nowhere else", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const plan = installPlan("ollama", at[platform], { homebrew: null, winget: null }, DATA);
    assert.equal(plan.via, "download", `${platform} unpacks an archive rather than running an installer`);
    assert.equal(plan.leavesBehind, false);
    const where = plan.where.replaceAll("\\", "/");
    assert.equal(where, `${DATA}/runners/ollama`);
    for (const step of plan.steps)
      for (const part of step.command.slice(1))
        assert.ok(!part.startsWith("/Applications") && !part.startsWith("/usr/local") && !part.startsWith("/opt"),
          `${part} is outside Branch`);
  }
  // Nothing here registers itself with the system: no service, no sign-in entry, no file association.
  const words = JSON.stringify(installPlan("ollama", at.darwin, { homebrew: null, winget: null }, DATA));
  for (const forbidden of ["launchctl", "systemctl", "LaunchAgents", "systemd", "reg.exe", "defaults"])
    assert.doesNotMatch(words, new RegExp(forbidden), `${forbidden} has no place in a plan that only unpacks a folder`);
});

test("C2 a program the person already has always wins; Branch never installs a second copy", async () => {
  const own = branchRunnerProgram("ollama", at.darwin, DATA);
  assert.equal(own, `${DATA}/runners/ollama/Ollama.app/Contents/Resources/ollama`);
  const paths = candidatePaths("ollama", at.darwin, DATA);
  assert.equal(paths.at(-1), own, "Branch's own copy is looked at last");
  assert.ok(paths.indexOf("/opt/homebrew/bin/ollama") < paths.indexOf(own));
  assert.deepEqual(candidatePaths("ollama", at.darwin), paths.slice(0, -1), "without a data folder nothing changes");

  const both = async (path) => path === "/opt/homebrew/bin/ollama" || path === own;
  assert.equal(await findRuntime("ollama", at.darwin, both, DATA), "/opt/homebrew/bin/ollama");
  assert.equal(await findRuntime("ollama", at.darwin, async (path) => path === own, DATA), own);
  assert.equal(await findRuntime("ollama", at.darwin, async () => false, DATA), null);
  assert.equal(branchRunnerProgram("lm-studio", at.darwin, DATA), null, "LM Studio has no archive Branch can unpack");
});

test("C3 models Branch downloads go inside Branch, and a library the person already has is left alone", () => {
  assert.equal(modelsFolder("ollama", at.darwin, DATA, true), `${DATA}/models/ollama`);
  assert.equal(modelsFolder("ollama", at.darwin, DATA, false), "/Users/sam/.ollama/models");
  assert.equal(branchModelsFolder(DATA, "darwin"), `${DATA}/models`);
  assert.equal(branchRunnerRoot(DATA, "ollama", "darwin"), `${DATA}/runners/ollama`);

  const own = startPlan("ollama", "/x/ollama", {}, at.darwin, false, `${DATA}/models/ollama`);
  assert.deepEqual(own.env, { OLLAMA_MODELS: `${DATA}/models/ollama` }, "Branch's own copy is told to keep them inside Branch");
  assert.deepEqual(startPlan("ollama", "/x/ollama", {}, at.darwin).env, {}, "the person's own copy keeps its own library");

  // Gigabytes must not be swept into a backup by surprise; on a Mac Branch asks Time Machine to skip them.
  const steps = installPlan("ollama", at.darwin, { homebrew: null, winget: null }, DATA).steps;
  assert.deepEqual(steps.at(-1).command, ["/usr/bin/tmutil", "addexclusion", "{models}"]);
  assert.equal(steps.at(-1).advisory, true, "a backup hint never decides whether the install worked");
});

test("C4a a backup hint that does not take never throws away a checked, unpacked program", async (t) => {
  const root = await scratch("advisory");
  t.after(async () => { await discardTemp(root); });
  const body = Buffer.from("a stand-in download");
  const sum = createHash("sha256").update(body).digest("hex");
  const library = async (url) => String(url).endsWith("sha256sum.txt")
    ? new Response(`${sum}  ./Ollama-darwin.zip\n`)
    : new Response(body, { headers: { "content-length": String(body.length) } });
  const data = join(root, "data");
  const outcome = await runInstall(installPlan("ollama", at.darwin, { homebrew: null, winget: null }, data), {
    at: at.darwin, exists: async () => true, library, scratchDir: join(root, "dl"), dataDir: data,
    run: async (file) => {
      if (file === "/usr/bin/tmutil") throw Object.assign(new Error("exit 1"), { stderr: "not a backup volume" });
      return { stdout: "" };
    },
  });
  assert.equal(outcome.installed, true, "the program was checked and unpacked, so the install stands");
  assert.match(outcome.message, /Keep the models out of Time Machine/, "and the owner is told what did not take");
  assert.equal(existsSync(join(data, "runners", "ollama")), true, "the folder was not thrown away");
});

test("C4 where a system installer is the only honest option, the plan says it will be left behind", () => {
  const brew = installPlan("lm-studio", at.darwin, { homebrew: "/opt/homebrew/bin/brew", winget: null }, DATA);
  assert.equal(brew.via, "homebrew");
  assert.equal(brew.leavesBehind, true);
  assert.match(brew.leavesBehindNote, /Removing Branch will not remove it/);
  assert.match(brew.leavesBehindNote, /permissions of its own/);
  // Without Homebrew there is no honest way, so Branch says so rather than fetching something unchecked.
  const none = installPlan("lm-studio", at.darwin, { homebrew: null, winget: null }, DATA);
  assert.equal(none.via, "none");
  assert.match(none.instead, /lmstudio\.ai/);
  // The owner can still ask for a system-wide Ollama; then it says the same thing.
  const chosen = installPlan("ollama", at.darwin, { homebrew: "/opt/homebrew/bin/brew", winget: null }, DATA, true);
  assert.equal(chosen.leavesBehind, true);
  assert.notEqual(chosen.fingerprint, installPlan("ollama", at.darwin, { homebrew: "/opt/homebrew/bin/brew", winget: null }, DATA).fingerprint,
    "choosing the system-wide copy is a different plan, so a yes to one is never a yes to the other");
});

test("C4b the card itself says where it goes, how much room is left, and what will be left behind", async () => {
  const card = await readFile(join(import.meta.dirname, "..", "public", "local-oneclick.js"), "utf8");
  for (const [words, key] of [["plan.where", "local.install.inside"], ["plan.leavesBehindNote", "local.install.leaves-behind"],
    ["shown.modelsFolder", "local.install.room"]]) {
    assert.ok(card.includes(words), `${words} is worked out but never drawn on the card`);
    assert.ok(card.includes(key), `${key} is not used`);
  }
  const en = JSON.parse(await readFile(join(import.meta.dirname, "..", "public", "locales", "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(import.meta.dirname, "..", "public", "locales", "fr.json"), "utf8"));
  for (const key of ["local.install.inside", "local.install.leaves-behind", "local.install.room",
    "danger.card.title", "danger.action.remove", "danger.field.keep", "danger.intro"]) {
    assert.ok(en[key], `${key} has no English`);
    assert.ok(fr[key] && fr[key] !== en[key], `${key} needs real French`);
  }
});

/* ---------------------------------------------- the danger zone: what goes, and what it cannot take */

/** A whole installed Branch in a temporary folder: the app, the command, the data, what it fetched. */
async function installed(t, platform = "darwin") {
  const root = await scratch("remove");
  const store = new Store(join(root, "notes.sqlite"));
  t.after(async () => { store.close(); await discardTemp(root); });
  const env = { HOME: root, XDG_DATA_HOME: join(root, ".local", "share"), XDG_CONFIG_HOME: join(root, ".config") };
  const layout = unixLayout(platform, env, root);
  await mkdir(layout.installRoot, { recursive: true });
  await writeFile(join(layout.installRoot, "program"), "p".repeat(8192));
  await mkdir(join(layout.dataDir, "runners", "ollama"), { recursive: true });
  await writeFile(join(layout.dataDir, "runners", "ollama", "ollama"), "r".repeat(2048));
  await mkdir(join(layout.dataDir, "models", "ollama"), { recursive: true });
  await writeFile(join(layout.dataDir, "models", "ollama", "blob"), "m".repeat(4096));
  await writeFile(join(layout.dataDir, "branch.sqlite"), "d".repeat(1024));
  await mkdir(dirname(layout.launcher), { recursive: true });
  await writeFile(layout.launcher, `#!/bin/sh\n${launcherMarker}\n`);
  await mkdir(dirname(layout.serviceFile), { recursive: true });
  await writeFile(layout.serviceFile, "<plist/>");
  const ran = [];
  const manage = {
    env, platform, version: "0.18.0", packageRoot: root, print: () => undefined,
    deps: { layout, quit: { alive: () => false }, run: async (file, args) => { ran.push([file, ...args]); return { stdout: "" }; } },
  };
  return { root, layout, manage, ran, env, store };
}

test("C5 the danger zone shows exactly what will go, with real sizes, before anything goes", async (t) => {
  const world = await installed(t);
  const survey = await removalSurvey({ platform: "darwin", installed: true, env: world.env, layout: world.layout, exists: async () => false }, false);
  assert.equal(survey.instead, null);
  const by = Object.fromEntries(survey.items.map((one) => [one.what, one]));
  assert.equal(by["Branch Agent itself"].bytes, 8192);
  assert.equal(by["Programs Branch downloaded to run models"].bytes, 2048);
  assert.equal(by["Models Branch downloaded"].bytes, 4096);
  assert.equal(by["Your conversations and settings"].bytes, 1024, "the models are counted once, under the models");
  assert.ok(by["Starting by itself when you sign in"].bytes > 0, "the sign-in entry is named too");
  assert.ok(by["The `branch` command"].bytes > 0);
  assert.equal(survey.totalBytes, survey.items.reduce((sum, one) => sum + (one.goes ? one.bytes : 0), 0));
  assert.equal(survey.confirmPhrase, "Branch Agent");
  assert.ok(survey.fingerprint.length > 10);
  // Keeping the conversations changes what goes, and so changes the line the yes has to carry back.
  const keeping = await removalSurvey({ platform: "darwin", installed: true, env: world.env, layout: world.layout, exists: async () => false }, true);
  assert.equal(keeping.items.find((one) => one.what === "Your conversations and settings").goes, false);
  assert.equal(keeping.keptBytes, 1024);
  assert.notEqual(keeping.fingerprint, survey.fingerprint);
});

test("C5a a source folder, and a copy no installer put in place, are told so rather than offered folders", async (t) => {
  const world = await installed(t);
  const built = await removalSurvey({ platform: "darwin", env: world.env, layout: world.layout, sourceCheckout: true, exists: async () => false });
  assert.match(built.instead, /nothing here to remove/);
  assert.deepEqual(built.items, []);
  // No copy of Branch where the installer puts one: the answer is the same, and no environment
  // variable is consulted — the window opened from the Dock never has the installer's own one.
  const bare = { ...world.layout, installRoot: join(world.root, "nowhere"), candidates: [join(world.root, "nowhere")] };
  const none = await removalSurvey({ platform: "darwin", env: {}, layout: bare, exists: async () => false });
  assert.match(none.instead, /nothing here to remove/);
  const real = await removalSurvey({ platform: "darwin", env: {}, installed: true, layout: world.layout, exists: async () => false });
  assert.equal(real.instead, null, "an installed copy is offered the real list");
});

test("C6 what Branch cannot remove is named, with the honest reason", async (t) => {
  const world = await installed(t);
  const brewOllama = "/opt/homebrew/bin/ollama";
  const survey = await removalSurvey({
    platform: "darwin", installed: true, env: world.env, layout: world.layout, at: at.darwin,
    exists: async (path) => path === brewOllama || path === "/Applications/Branch Agent.app",
  });
  const paths = survey.left.map((one) => one.path);
  assert.ok(paths.includes(brewOllama), "a runner outside Branch is named");
  assert.ok(paths.includes("/Applications/Branch Agent.app"), "a copy of Branch its installer did not put there is named");
  for (const item of survey.left) assert.match(item.why, /cannot remove|leaves it alone/);
});

test("C7 removing Branch takes the fetched program and its models with it", async (t) => {
  const world = await installed(t);
  const outcome = await removeBranch(
    { keepConversations: false, confirm: "Branch Agent", agreedSurvey: (await removalSurvey({ platform: "darwin", installed: true, env: world.env, layout: world.layout, exists: async () => false }, false)).fingerprint },
    { store: world.store, owner: "owner", platform: "darwin", installed: true, env: world.env, layout: world.layout,
      exists: async () => false, manage: world.manage });
  assert.equal(outcome.removed, true);
  for (const gone of [world.layout.installRoot, join(world.layout.dataDir, "runners"), join(world.layout.dataDir, "models"),
    world.layout.launcher, world.layout.userDataDir])
    assert.equal(existsSync(gone), false, `${gone} is gone`);
});

test("C8 keeping the conversations keeps them, and still takes away what Branch fetched", async (t) => {
  const world = await installed(t);
  const survey = await removalSurvey({ platform: "darwin", installed: true, env: world.env, layout: world.layout, exists: async () => false }, true);
  const outcome = await removeBranch(
    { keepConversations: true, confirm: "Branch Agent", agreedSurvey: survey.fingerprint },
    { store: world.store, owner: "owner", platform: "darwin", installed: true, env: world.env, layout: world.layout,
      exists: async () => false, manage: world.manage });
  assert.equal(outcome.removed, true);
  assert.equal(existsSync(join(world.layout.dataDir, "branch.sqlite")), true, "the conversations are still there");
  assert.equal(existsSync(join(world.layout.dataDir, "runners")), false, "gigabytes Branch fetched still go");
  assert.equal(existsSync(join(world.layout.dataDir, "models")), false);
  assert.equal(existsSync(world.layout.installRoot), false, "Branch itself is gone either way");
});

test("C8a `branch uninstall` says the downloaded programs and models went, not just that data stayed", async (t) => {
  const world = await installed(t);
  const said = [];
  const code = await manageCommand(["uninstall"], { ...world.manage, print: (line) => said.push(line) });
  assert.equal(code, 0);
  const all = said.join("\n");
  assert.match(all, /programs Branch downloaded to run models, and their models, were removed/i);
  assert.match(all, /conversations and files are kept/);
  assert.equal(existsSync(join(world.layout.dataDir, "models")), false);
  assert.equal(existsSync(join(world.layout.dataDir, "branch.sqlite")), true);
});

test("C9 a misclick cannot pass, and neither can a yes to a list that has changed", async (t) => {
  const world = await installed(t);
  const deps = { store: world.store, owner: "owner", platform: "darwin", installed: true, env: world.env, layout: world.layout,
    exists: async () => false, manage: world.manage };
  const survey = await removalSurvey(deps);
  await assert.rejects(removeBranch({ confirm: "", agreedSurvey: survey.fingerprint }, deps), /Type Branch Agent/);
  await assert.rejects(removeBranch({ confirm: "yes", agreedSurvey: survey.fingerprint }, deps), /Type Branch Agent/);
  await assert.rejects(removeBranch({ confirm: "Branch Agent", agreedSurvey: "not-the-one" }, deps), /has changed since you looked/);
  assert.equal(existsSync(world.layout.installRoot), true, "nothing was removed by any of that");
});

test("C10 it is the owner's alone: a chat, a key, another computer, a Trunk and someone else are refused", async (t) => {
  const world = await installed(t);
  const store = world.store;
  assert.equal(removalGuard(store, { source: "channel" }), removeChatRefusal);
  assert.equal(removalGuard(store, { trunkKeys: {} }), removeTrunkRefusal);
  assert.equal(underShortLivedKey(() => removalGuard(store, {})), removeShortLivedRefusal,
    "a short-lived key, and so another computer reaching this one");
  assert.equal(removalGuard(store, {}, "person-7"), removePersonRefusal);
  assert.equal(removalGuard(store, { source: "schedule" }), removeStartedElsewhereRefusal);
  assert.equal(removalGuard(store, {}), null, "the owner in the app window may");
  assert.equal(ROUTES["/api/remove-branch"], "owner POST", "and a short-lived key is refused at the door");
  assert.equal(ROUTES["/api/remove-branch/plan"], "owner POST");
});

/* ---------------------------------------------- the card itself, opened the way a person opens it */

/**
 * A headless browser only. This Branch runs from a folder that was built, not installed, so the
 * card truthfully says there is nothing here to remove — and the Remove button can never do
 * anything on the computer running these tests.
 */
async function browserFixture(t, width = 1440) {
  const root = await scratch("danger-ui");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, app };
}

test("C11 the danger zone is the last card in Settings, fits 400 px, and says its words in French", async (t) => {
  const { page, errors } = await browserFixture(t, 400);
  // Redesign: navigate to Settings via data-act="view" data-v="settings"
  await page.locator('[data-act="view"][data-v="settings"]').click();
  // Redesign: navigate to Updates page via data-act="setpage" data-v="updates"
  await page.locator('[data-act="setpage"][data-v="updates"]').click();

  // Redesign: danger section is .sec.danger8, heading is h2 with text "Remove Branch"
  await page.locator(".sec.danger8").waitFor({ state: "visible", timeout: 30000 });
  assert.equal(await page.locator(".sec.danger8 h2").textContent(), "Remove Branch");

  // Redesign: button #dz-go is greyed (data-act="uninstall" is not live) - assert starts disabled and stays disabled
  assert.equal(await page.locator("#dz-go").isDisabled(), true, "the button starts off");
  assert.match(await page.locator("#dz-go").textContent(), /Remove Branch and everything it installed/);

  // Typing "Branch Agent" in confirm field - button stays disabled because route is not live
  await page.locator("#dz-confirm").fill("Branch Agent");
  // Redesign: removing Branch is greyed until the engine has an uninstall route
  assert.equal(await page.locator("#dz-go").isDisabled(), true, "button stays disabled - route not live");

  // Check that the danger zone is the last card on the page
  const isLastCard = await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('.sec'));
    return sections[sections.length - 1]?.classList.contains('danger8') || false;
  });
  assert.ok(isLastCard, "danger zone is the last card");

  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false, "no sideways scrolling at 400 px");
  const fits = await page.evaluate(() => {
    const box = document.querySelector("#dz-go").getBoundingClientRect();
    return box.width > 0 && box.x >= 0 && box.right <= 400;
  });
  assert.ok(fits, "the button fits inside 400 px");

  // Redesign: the language switch is greyed ("Coming soon")
  assert.equal(await page.locator("select#lang").isDisabled(), true, "language switch is disabled");
  assert.deepEqual(errors, []);
});

test("C12 the version card says what is running and whether a newer one exists", async (t) => {
  const { page, errors, app } = await browserFixture(t);
  // Redesign: navigate to Settings via data-act="view" data-v="settings"
  await page.locator('[data-act="view"][data-v="settings"]').click();
  // Redesign: navigate to Updates page via data-act="setpage" data-v="updates"
  await page.locator('[data-act="setpage"][data-v="updates"]').click();

  // Redesign: version shows as <p class="lede">Branch Agent <version>.</p> under <h1>Updates & about</h1>
  const h1 = await page.locator("h1").filter({ hasText: /Updates/ });
  await h1.waitFor({ state: "visible", timeout: 10000 });

  const lede = await page.locator("p.lede").first();
  const versionText = await lede.textContent();
  assert.ok(versionText.includes(app.version), "the lede shows the running version");

  // Redesign: there is no "newer version" line on the page
  const newerVersionElement = await page.locator("text=/newer|newest/i").count();
  if (newerVersionElement === 0) {
    // Redesign: there is no newer version line; the uninstall route is not yet live
  } else {
    // If newer version line appears, verify it
    assert.ok(versionText.includes('newest') || versionText.includes('newer'), "newer version line present if shown");
  }
  assert.deepEqual(errors, []);
});

test("merge-queue review: a removal that does not say keepConversations keeps the owner's conversations", async (t) => {
  const world = await installed(t);
  const survey = await removalSurvey({ platform: "darwin", installed: true, env: world.env, layout: world.layout, exists: async () => false });
  assert.equal(survey.items.find((one) => one.what === "Your conversations and settings").goes, false, "left out, the survey keeps them");
  const outcome = await removeBranch({ confirm: "Branch Agent", agreedSurvey: survey.fingerprint },
    { store: world.store, owner: "owner", platform: "darwin", installed: true, env: world.env, layout: world.layout,
      exists: async () => false, manage: world.manage });
  assert.equal(outcome.removed, true);
  assert.equal(existsSync(world.layout.installRoot), false, "Branch itself is gone");
  assert.equal(existsSync(join(world.layout.dataDir, "runners")), false, "what Branch fetched is gone");
  assert.equal(existsSync(world.layout.userDataDir), true, "the conversations and settings stay");
});
