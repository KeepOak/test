/* SELF-026: after the owner answers a source review, its dialog closes and the Inbox reads the requests again. What comes
   back is kept and drawn only for the owner who answered, unlocked and still on the Inbox; if the App lock came on, the
   owner switched person or page meanwhile, nothing is redrawn and a failed read says nothing.
   The real public/app/places/inbox.js runs in Node; every module it imports is a stand-in made from its own import list
   (each name a no-op), with the few this path uses answering for the test. The read is held open by the test.
   Mutation: drop still() from the initSourceReview callback -> every late case fails. */
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
  readSourcePublications: "(still) => globalThis.__ib.publications(still)",
  t: "(key) => key",
};

async function inboxPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-inbox-reread-"));
  const source = await readFile(new URL("../public/app/places/inbox.js", import.meta.url), "utf8");
  await mkdir(join(root, "app", "places"), { recursive: true });
  await writeFile(join(root, "app", "places", "inbox.js"), source);
  const modules = new Map();
  for (const [, names, from] of source.matchAll(/^import \{([^}]*)\} from "([^"]+)";/gm)) {
    const list = modules.get(from) ?? [];
    list.push(...names.split(",").map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    modules.set(from, list);
  }
  for (const [from, names] of modules) {
    const file = join(root, "app", "places", from);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, [...new Set(names)].map((n) => `export const ${n} = ${SPECIAL[n] ?? "() => \"\""};`).join("\n"));
  }
  const held = [];
  const ib = { S: { view: "inbox", tabs: {} }, E: { state: {}, profiles: { isOwner: true } }, owner: true, profile: null, locked: false,
    toasts: [], renders: 0, reread: null, api: (path) => new Promise((resolve, reject) => held.push({ path, resolve, reject })),
    /* The publications read: handed the callback's own context, held open like any read. */
    publications: (still) => new Promise((resolve, reject) => held.push({ path: "publications", still, resolve, reject })) };
  globalThis.__ib = ib;
  globalThis.document = { getElementById: (id) => (id === "app" ? { classList: { contains: (c) => c === "locked-b17" && ib.locked } } : null),
    addEventListener: () => {}, querySelector: () => null };
  t.after(async () => { delete globalThis.__ib; delete globalThis.document; await discardTemp(root); });
  const page = await import(pathToFileURL(join(root, "app", "places", "inbox.js")).href);
  page.init();
  assert.equal(typeof ib.reread, "function", "the Inbox hands the review its after-answer read");
  const next = async () => { for (let i = 0; i < 50 && !held.length; i++) await Promise.resolve(); assert.ok(held.length, "the requests were read"); return held.shift(); };
  return { ib, next };
}

test("with nothing changed, the requests read after a review are drawn", async (t) => {
  const { ib, next } = await inboxPage(t);
  const reading = ib.reread(true);
  (await next()).resolve({ requests: [] });
  const publications = await next();
  assert.equal(publications.still(), true, "the publications read is handed the callback's context");
  publications.resolve(false);
  await reading;
  assert.equal(ib.renders, 1);
});

const LATE = [
  ["the App lock came on", (ib) => { ib.locked = true; }],
  ["another person's profile was switched to", (ib) => { ib.profile = "p-2"; }],
  ["the owner moved to another page", (ib) => { ib.S.view = "chat"; }],
];
for (const [what, change] of LATE) {
  test(`${what} while the requests were read after a review: nothing is redrawn`, async (t) => {
    const { ib, next } = await inboxPage(t);
    const reading = ib.reread(true);
    const read = await next();
    change(ib);
    read.resolve({ requests: [{ id: "r1", status: "waiting", text: "Owner's private change" }] });
    await reading;
    assert.equal(ib.renders, 0);
  });
  test(`${what} while the requests were read after a review: a failed read says nothing`, async (t) => {
    const { ib, next } = await inboxPage(t);
    const reading = ib.reread(false);
    const read = await next();
    change(ib);
    read.reject(new Error("The engine is not answering"));
    await reading;
    assert.deepEqual(ib.toasts, []);
    assert.equal(ib.renders, 0);
  });
}

for (const [what, change] of LATE) {
  test(`${what} while the publications were read after a review: their context says so and nothing is redrawn`, async (t) => {
    const { ib, next } = await inboxPage(t);
    const reading = ib.reread(true);
    (await next()).resolve({ requests: [] });
    const publications = await next();
    change(ib);
    assert.equal(publications.still(), false, "the publications read sees the change, so it keeps nothing");
    publications.resolve(false);
    await reading;
    assert.equal(ib.renders, 0);
  });
}
