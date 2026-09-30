/* A GitHub skill is inspected, then the owner approves the exact preview. A late answer draws nothing and shows no error
   if meanwhile the App lock came on or the owner switched person; after an install, the page is read again, and the new
   skill is shown only if nothing newer happened during that read (lock, person, page, another dialog, a newer import).
   The real public/app/flows/skill-github.js runs in Node next to stand-ins for the window's core modules; each read and
   the page refresh are held open by the test, so the change happens while they wait, with no timers.
   Mutations: drop unlocked() from inspect's still() -> the inspect lock cases fail; drop the checks after refresh() in
   install -> the after-install cases fail. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

const stubs = {
  "app/core/dom.js": "export const $ = (q) => globalThis.__sg.find(q); export const esc = (s) => String(s ?? \"\"); export const renderNow = () => {};",
  "app/core/ui.js": `export const openDlg = (o) => globalThis.__sg.openDlg(o); export const closeDlg = () => { globalThis.__sg.dlg = null; };
    export const toast = (m) => globalThis.__sg.toasts.push(m); export const dialog = () => globalThis.__sg.dlg;`,
  "app/core/api.js": "export const api = (path, body) => globalThis.__sg.hold(path);",
  "app/core/actions.js": "export const on = (name, fn) => { globalThis.__sg.acts[name] = fn; };",
  "app/core/features.js": "export const markLive = () => {};",
  "app/core/state.js": `export const S = globalThis.__sg.S; export const ownerHere = () => globalThis.__sg.owner;
    export const activeId = () => globalThis.__sg.profile; export const refresh = () => globalThis.__sg.hold("refresh");`,
  "app/places/customize.js": "export const showTool = (kind, id) => globalThis.__sg.shown.push([kind, id]);",
  "i18n.js": "export const t = (key) => key;",
};

async function skillPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-skill-github-stale-"));
  for (const dir of ["app/flows", "app/core", "app/places"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "app", "flows", "skill-github.js"), await readFile(new URL("../public/app/flows/skill-github.js", import.meta.url)));
  for (const [file, code] of Object.entries(stubs)) await writeFile(join(root, file), code);
  const held = [];
  const sg = { S: { view: "customize" }, owner: true, profile: null, locked: false, toasts: [], shown: [], acts: {}, dlg: null,
    hold: (path) => new Promise((resolve, reject) => held.push({ path, resolve, reject })),
    /* Each dialog drawn is a fresh set of elements, as the window's are: the form, or the preview. */
    openDlg: (o) => { sg.dlg = o.body.includes("github-skill-preview") ? { "#github-skill-preview": {} }
      : { "#github-skill-form": {}, "#github-skill-owner": { value: "octo" }, "#github-skill-repo": { value: "skills" }, "#github-skill-path": { value: "tidy" }, "#github-skill-sha": { value: "" } }; return sg.dlg; },
    find: (q) => sg.dlg?.[q] ?? null };
  globalThis.__sg = sg;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && sg.locked } } : null) };
  t.after(async () => { delete globalThis.__sg; delete globalThis.document; await discardTemp(root); });
  const page = await import(pathToFileURL(join(root, "app", "flows", "skill-github.js")).href);
  page.initGitHubSkills();
  const asked = async (path) => { for (let i = 0; i < 50 && !held.some((h) => h.path === path); i++) await Promise.resolve(); };
  const settle = async (path, how, value) => {
    await asked(path);
    const at = held.findIndex((h) => h.path === path);
    assert.ok(at >= 0, `asked for ${path}`);
    held.splice(at, 1)[0][how](value);
  };
  const answer = (path, value) => settle(path, "resolve", value), fail = (path, error) => settle(path, "reject", error);
  const button = () => ({ disabled: false, isConnected: true });
  return { page, sg, answer, fail, asked,
    inspect: () => sg.acts["github-skill-inspect"](button()), install: () => sg.acts["github-skill-install"](button()) };
}
const previewed = { ticket: "tk", blocked: false, manifest: { name: "tidy" }, origin: { url: "https://github.com/octo/skills", owner: "octo", repo: "skills", treeSha: "a".repeat(40) }, document: "" };

async function withPreview(t) {
  const w = await skillPage(t);
  w.page.openGitHubSkill();
  const inspecting = w.inspect();
  await w.answer("skill-installs/github", previewed);
  await inspecting;
  assert.ok(w.sg.dlg["#github-skill-preview"], "the preview is open");
  return w;
}

test("with nothing changed, an approved skill is shown once the page is read again", async (t) => {
  const w = await withPreview(t);
  const installing = w.install();
  await w.answer("skill-installs/github/install", { result: { skill: { id: "tidy" } } });
  await w.answer("refresh");
  await installing;
  assert.deepEqual(w.sg.shown, [["skills", "tidy"]]);
  assert.deepEqual(w.sg.toasts, ["window.flows.conn.skill-added"]);
});

const LATE = [
  ["the App lock came on", (w) => { w.sg.locked = true; }],
  ["another person's profile was switched to", (w) => { w.sg.profile = "p-2"; }],
  ["the owner moved to another page", (w) => { w.sg.S.view = "chat"; }],
  ["another dialog was opened", (w) => { w.sg.dlg = { other: {} }; }],
  ["a newer GitHub skill import was started", (w) => { w.page.openGitHubSkill(); }],
];
for (const [what, change] of LATE) {
  test(`${what} while the page was read after an install: the late skill page and toast are not shown`, async (t) => {
    const w = await withPreview(t);
    const installing = w.install();
    await w.answer("skill-installs/github/install", { result: { skill: { id: "tidy" } } });
    await w.asked("refresh");
    change(w);
    await w.answer("refresh");
    await installing;
    assert.deepEqual(w.sg.shown, []);
    assert.deepEqual(w.sg.toasts, []);
  });
}

test("the App lock came on while a skill was inspected: no preview opens over the lock", async (t) => {
  const w = await skillPage(t);
  w.page.openGitHubSkill();
  const inspecting = w.inspect();
  w.sg.locked = true;
  await w.answer("skill-installs/github", previewed);
  await inspecting;
  assert.equal(w.sg.dlg["#github-skill-preview"], undefined);
});

test("an inspect that fails behind the lock shows no error over it", async (t) => {
  const w = await skillPage(t);
  w.page.openGitHubSkill();
  const inspecting = w.inspect();
  w.sg.locked = true;
  await w.fail("skill-installs/github", new Error("GitHub is not answering"));
  await inspecting;
  assert.deepEqual(w.sg.toasts, []);
});
