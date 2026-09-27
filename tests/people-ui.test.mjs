/**
 * Bucket 19: the owner's "Signing in from other devices" switch and the page a person signs in on (public/people.html),
 * opened the way a person opens them. Headless browser only; a scripted provider stands in for every model.
 * Redesign: the switch is Team › Signing in in the new window (prototype.html signinTab, "Let people sign in from their
 * own device"), reached from Settings › People › "Signing in from other devices".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn, openSettings, placeRoot } from "./new-window-places.mjs";

async function fixture(t, width = 1440) {
  const scratch = join(tmpdir(), "claude-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-people-ui-"));
  const provider = { name: "scripted", async complete() { return { content: "Hello from Branch.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const httpCall = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await httpCall("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  app.store.profiles.create({ name: "Ada", pin: "1234" });
  return { app, server, browser, page, errors, width };
}

/* Settings › People › "Signing in from other devices" opens Team › Signing in. */
async function signingIn({ page, server }) {
  await signIn(page, server);
  await openSettings(page, "people");
  await page.locator('[data-act="p-open-team"][data-v="signin"]').click();
  await page.locator('#main .place [data-act="ptab"][data-v="signin"][aria-selected="true"]').waitFor({ timeout: 10000 });
  return placeRoot(page);
}
const signInSwitch = (place) => place.getByRole("group", { name: "Let people sign in from their own device", exact: true });

// Team › Signing in is live since #353.
test("P1 the switch is in Team › Signing in, starts off, and saves", async (t) => {
  const f = await fixture(t);
  const place = await signingIn(f);
  // WINDOW BUG: public/app/places/team.js draw() draws Team › Signing in as an empty .runs6; the prototype draws the switch.
  const seg = signInSwitch(place);
  await seg.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await seg.getByRole("button", { name: "Off", exact: true }).getAttribute("aria-pressed"), "true", "it ships off");
  await seg.getByRole("button", { name: "On", exact: true }).click();
  await f.page.waitForFunction(() => document.querySelector('#main .place [aria-label="Let people sign in from their own device"] [data-v="on"]')?.getAttribute("aria-pressed") === "true");
  assert.equal(f.app.people.settings().mode, "on");
  assert.deepEqual(f.errors, []);
});

test("P2 at 400 px the switch fits and every people word has real French", async (t) => {
  const english = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const ours = Object.keys(english).filter((key) => key.startsWith("people."));
  assert.ok(ours.length >= 90);
  for (const key of ours) {
    assert.ok(french[key], `${key} has French`);
    assert.notEqual(french[key], english[key], `${key} is really translated`);
  }
  // Redesign: replaced by the new window (its words are the design document's, drawn without data-t keys), so the
  // "every word has a key" check of the old card is not made here.
  const f = await fixture(t, 400);
  const place = await signingIn(f);
  const wide = await f.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false);
  await signInSwitch(place).waitFor({ state: "visible", timeout: 10000 });
  const fits = await f.page.waitForFunction(() => {
    const box = document.querySelector('#main .place [aria-label="Let people sign in from their own device"]')?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "the sign-in switch fits inside 400 px");
  assert.deepEqual(f.errors, []);
});

test("P3 a person signs in on the page with their PIN, talks, and sees only their own", async (t) => {
  // WINDOW BUG: public/people.js:9 imports /i18n.js, which the redesign removed (21eca9ec), so the page never starts.
  const f = await fixture(t, 400);
  await f.app.people.parts.store.save("settings", f.app.runtime.owner, "people-signin", { mode: "on" });
  const owners = await f.app.runtime.run({ prompt: "the owner's own words" });
  const phone = await f.browser.newPage({ viewport: { width: 400, height: 900 } });
  const errors = [];
  phone.on("pageerror", (error) => errors.push(error.message));
  await phone.goto(`${f.server.url}/people`);
  await phone.getByLabel("Your name").first().fill("Ada");
  await phone.getByRole("button", { name: "Next" }).click();
  await phone.getByLabel("Your PIN").fill("1234");
  await phone.getByRole("button", { name: "Check my PIN" }).click();
  await phone.getByText("Hello, Ada").waitFor();
  // mac7/linux-fixes: isVisible() asks whether it is on the page this instant and never waits,
  // so on a slow machine this read the list before it had drawn. waitFor() asks the same
  // question and gives the page time to answer.
  await phone.getByText("Nothing yet. Start a conversation below.").waitFor();
  await phone.getByRole("button", { name: "New conversation" }).click();
  await phone.getByLabel("Your message").fill("what is on today?");
  await phone.getByRole("button", { name: "Send" }).click();
  await phone.getByText("Hello from Branch.").waitFor();
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false);
  assert.equal(await phone.getByText("the owner's own words").count(), 0);
  // The key stays in the tab, never in the address.
  assert.doesNotMatch(phone.url(), /branch_person_/);
  assert.ok(f.app.store.recentSessions(`profile:${f.app.store.profiles.list()[0].id}`).sessions.length === 1);
  assert.ok(owners.sessionId);
  assert.deepEqual(errors, []);
});
