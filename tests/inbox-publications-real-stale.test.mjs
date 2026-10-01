/* SELF-026 / RES711: the Inbox's after-review read with the REAL publication reader behind it. After the requests are
   read, the real self-development-publication.js asks for the saved publications; if the App lock comes on, another
   person's profile is switched to, or the owner leaves the Inbox while that second request waits, its late answer is not
   kept (the cards stay as they were) and nothing is redrawn.
   inbox.js and self-development-publication.js are the real modules; every other import is a stand-in generated from
   inbox.js's own import list. Each request is held open by the test.
   Mutation: drop the context check before `publications = fresh` in readSourcePublications, or stop inbox.js handing it
   its context -> the late cases fail. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

/* Names this path needs with a real shape; every other imported name is a function that does nothing. */
const SPECIAL = {
  S: "globalThis.__ib.S", E: "globalThis.__ib.E",
  api: "(path, body) => globalThis.__ib.api(path, body)",
  toast: "(m) => globalThis.__ib.toasts.push(m)",
  renderNow: "() => { globalThis.__ib.renders++; }",
  ownerHere: "() => globalThis.__ib.owner", activeId: "() => globalThis.__ib.profile",
  initSourceReview: "(after) => { globalThis.__ib.reread = after; }",
  t: "(key) => key",
  esc: "(s) => String(s ?? \"\")",
};

async function inboxPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-inbox-reread-"));
  const source = await readFile(new URL("../public/app/places/inbox.js", import.meta.url), "utf8");
  await mkdir(join(root, "app", "places"), { recursive: true });
  await writeFile(join(root, "app", "places", "inbox.js"), source);
  const modules = new Map([["../core/actions.js", ["on"]], ["../core/features.js", ["markLive"]], ["../core/dom.js", ["esc", "renderNow"]],
    ["../core/ui.js", ["toast"]], ["../core/state.js", ["S", "ownerHere", "activeId"]], ["../core/api.js", ["api"]], ["../../i18n.js", ["t"]]]);
  for (const [, names, from] of source.matchAll(/^import \{([^}]*)\} from "([^"]+)";/gm)) {
    const list = modules.get(from) ?? [];
    list.push(...names.split(",").map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    modules.set(from, list);
  }
  const real = "./self-development-publication.js";
  await writeFile(join(root, "app", "places", real), await readFile(new URL("../public/app/places/self-development-publication.js", import.meta.url)));
  for (const [from, names] of modules) {
    if (from === real) continue;
    const file = join(root, "app", "places", from);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, [...new Set(names)].map((n) => `export const ${n} = ${SPECIAL[n] ?? "() => \"\""};`).join("\n"));
  }
  const held = [];
  const ib = { S: { view: "inbox", tabs: {} }, E: { state: {}, profiles: { isOwner: true } }, owner: true, profile: null, locked: false,
    toasts: [], renders: 0, reread: null, api: (path) => new Promise((resolve, reject) => held.push({ path, resolve, reject })),
  };
  globalThis.__ib = ib;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && ib.locked } } : null),
    addEventListener: () => {}, querySelector: () => null };
  t.after(async () => { delete globalThis.__ib; delete globalThis.document; await discardTemp(root); });
  const page = await import(pathToFileURL(join(root, "app", "places", "inbox.js")).href);
  page.init();
  assert.equal(typeof ib.reread, "function", "the Inbox hands the review its after-answer read");
  const cards = await import(pathToFileURL(join(root, "app", "places", real)).href);
  const next = async () => { for (let i = 0; i < 50 && !held.length; i++) await Promise.resolve(); assert.ok(held.length, "the requests were read"); return held.shift(); };
  return { ib, next, cards };
}

const LATE = [
  ["the App lock came on", (ib) => { ib.locked = true; }],
  ["another person's profile was switched to", (ib) => { ib.profile = "p-2"; }],
  ["the owner moved to another page", (ib) => { ib.S.view = "chat"; }],
];
const blocked = { publications: [{ id: "p1", state: "blocked", repository: "owner/private-repo", branch: "branch/change", reason: "held" }] };

test("with nothing changed, the real publication read after a review is kept and drawn", async (t) => {
  const { ib, next, cards } = await inboxPage(t);
  const reading = ib.reread(true);
  (await next()).resolve({ requests: [] });
  const publications = await next();
  assert.equal(publications.path, "self-development/publications");
  publications.resolve(blocked);
  await reading;
  assert.match(cards.sourcePublicationCards(), /private-repo/);
  assert.equal(ib.renders, 1);
});

for (const [what, change] of LATE) {
  test(`${what} while the real publication read waited after a review: its answer is not kept and nothing is redrawn`, async (t) => {
    const { ib, next, cards } = await inboxPage(t);
    const reading = ib.reread(true);
    (await next()).resolve({ requests: [] });
    const publications = await next();
    change(ib);
    publications.resolve(blocked);
    await reading;
    assert.equal(cards.sourcePublicationCards(), "");
    assert.equal(ib.renders, 0);
  });
}
