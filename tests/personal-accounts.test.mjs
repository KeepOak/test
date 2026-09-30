/**
 * RES-107: several accounts per service. Each account keeps its own settings and its own saved
 * sign-in, the first account keeps its old keys, and a change must name its account once there are two.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fakeStore, fakeWeb, on } from "./personal-kit.mjs";
import { SignIn } from "../dist/personal/signin.js";
import { GoogleConnector, registerGoogle } from "../dist/personal/google.js";
import { accountTools } from "../dist/personal/account-tools.js";

function twoAccounts() {
  const store = fakeStore();
  on(store, "google");
  const asked = [];
  const oauth = { saved: async (id) => { asked.push(id); return { scope: "https://www.googleapis.com/auth/calendar.events" }; },
    accessToken: async (provider) => `token-for-${provider.id}` };
  const signIn = new SignIn({ store, owner: "local", oauth, secret: async () => "" }, "google", "google");
  signIn.save({ clientId: "home", calendarWrite: true });
  const work = signIn.accounts.add({ label: "Work" });
  signIn.forAccount(work.id).save({ clientId: "work", calendarWrite: true });
  return { store, signIn, work, asked };
}

test("RES-107: each account has its own settings and sign-in; the first keeps its old keys", async () => {
  const { store, signIn, work } = twoAccounts();
  assert.equal(store.get("settings", "local", "personal-signin-google").data.clientId, "home");
  assert.equal(store.get("settings", "local", `personal-signin-google-${work.id}`).data.clientId, "work");
  assert.equal(await signIn.token(), "token-for-personal-google");
  assert.equal(await signIn.forAccount(work.id).token(), `token-for-personal-google-${work.id}`);
  assert.equal(signIn.accounts.list().accounts.length, 2);
});

test("RES-107: with two accounts a change must name one, and runs against the one named", async () => {
  const { store, signIn, work, asked } = twoAccounts();
  const web = fakeWeb([[/\/calendars\/primary\/events/, { id: "e1" }]]);
  const tools = new Map();
  registerGoogle(accountTools({ register: (tool) => tools.set(tool.name, tool) }, signIn), new GoogleConnector(store, "local", web.fetch, signIn));
  const create = tools.get("gcal.create");
  const input = { title: "Standup", starts: "2026-10-02T09:00:00Z", ends: "2026-10-02T09:15:00Z", location: "" };
  await assert.rejects(create.execute(input, {}), /Specify the account ID/);
  assert.equal(web.seen.length, 0);
  const made = await create.execute({ ...input, account: work.id }, {});
  assert.equal(made.account, work.id);
  assert.deepEqual(asked, [`personal-google-${work.id}`]);
  assert.equal(web.seen[0].headers.authorization, `Bearer token-for-personal-google-${work.id}`);
});
