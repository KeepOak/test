/* The usage bar's "more usage" offers (src/usage-offers.ts): which services sell more usage at a limit, the page where the
   owner does it, and the rule that decides which rows show it. Built from real rows through limitsView and glanceFrom,
   the same path GET /api/usage/glance takes. Nothing here reaches the network. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { usageOffers, isOfferUrl, offerFor, withOffers, atOrNearLimit, offerEntryFor } from "../dist/usage-offers.js";
import { limitsView } from "../dist/usage-limits.js";
import { glanceFrom } from "../dist/usage-glance.js";

const now = Date.parse("2026-09-27T12:00:00Z");
const later = new Date(now + 3 * 3600_000).toISOString(), earlier = new Date(now - 60_000).toISOString();
const plan = (used, extra = {}) => ({ id: "five_hour", title: "This 5-hour window", kind: "plan", limit: 100, remaining: 100 - used,
  resetAt: later, measuredAt: new Date(now).toISOString(), state: "measured", from: "test", ...extra });
const row = (extra) => ({ connection: "chatgpt", connectionName: "ChatGPT plan", presets: [], signIn: true, account: "primary",
  accountLabel: "owner@example.test", inUse: true, state: "measured", windows: [], note: "", ...extra });

test("the catalogue holds each service's own option, one https page it was confirmed on, and a source", async () => {
  assert.deepEqual(usageOffers.map((entry) => entry.id), ["claude", "chatgpt", "copilot", "openrouter"]);
  const providers = usageOffers.flatMap((entry) => entry.providers);
  assert.equal(new Set(providers).size, providers.length, "a service belongs to one entry");
  const hosts = { claude: "claude.ai", chatgpt: "chatgpt.com", copilot: "github.com", openrouter: "openrouter.ai" };
  for (const entry of usageOffers) {
    const url = new URL(entry.url);
    assert.equal(url.protocol, "https:", entry.id);
    assert.equal(url.hostname, hosts[entry.id], `${entry.id} opens the service's own site`);
    assert.equal(url.search + url.hash, "", `${entry.id} carries nothing of the owner's in its address`);
    assert.match(entry.source, /^https:\/\//, `${entry.id} says where it was confirmed`);
    assert.ok(entry.option.length > 0);
  }
  assert.equal(offerEntryFor("cli-gemini-cli"), null, "Gemini CLI's personal tiers were replaced on 18 June 2026: nothing to offer");
  assert.equal(offerEntryFor("anthropic"), null, "an unconfirmed page never ships");
  assert.equal(offerEntryFor(undefined), null);
  for (const language of ["en", "fr", "es", "de"]) {
    const words = JSON.parse(await readFile(new URL(`../public/locales/${language}.json`, import.meta.url), "utf8"));
    for (const key of [...usageOffers.map((entry) => `glance.offer.${entry.id}`), "glance.offerNote", "glance.offerNoteFor", "glance.offerOpened", "glance.poolSwitches"])
      assert.ok(words[key], `${language} says ${key}`);
    for (const key of ["glance.offerNote", "glance.offerNoteFor", "glance.offerOpened"]) assert.match(words[key], /\{site\}/, `${language} ${key} names the site`);
    assert.match(words["glance.offerNoteFor"], /\{account\}/, `${language} names the account`);
  }
});

test("only the catalogue's exact pages may be opened: no prefix, lookalike, query or other scheme", async () => {
  for (const entry of usageOffers) assert.equal(isOfferUrl(entry.url), true, entry.url);
  for (const url of ["https://claude.ai/settings/usage/../billing", "https://claude.ai/settings/usage?next=https://evil.test",
    "https://claude.ai/settings/usage#x", "https://claude.ai.evil.test/settings/usage", "http://claude.ai/settings/usage",
    "https://user@claude.ai/settings/usage", "https://claude.ai/settings", "https://github.com/settings/billing/x", "not a url", 42, null])
    assert.equal(isOfferUrl(url), false, String(url));
  const ipc = await readFile(new URL("../src/desktop/updater-ipc.ts", import.meta.url), "utf8");
  const handler = ipc.slice(ipc.indexOf('ipcMain.handle("branch:open-external"'));
  assert.match(handler.slice(0, handler.indexOf("shell.openExternal")), /isOfferUrl\(url\)/, "the desktop window opens those pages through the same check");
});

test("a sign-in at 95% used, or at its plan limit, gets its service's offer; below that, estimated or refilled, none", () => {
  const claude = row({ connection: "cli-claude-code", provider: "cli-claude-code", connectionName: "Claude plan" });
  assert.deepEqual(offerFor({ ...claude, windows: [plan(96)] }, now), { id: "claude", url: "https://claude.ai/settings/usage", option: "Usage credits" });
  assert.equal(offerFor({ ...claude, windows: [plan(95)] }, now)?.id, "claude", "95% used is the line, as for saving progress");
  assert.equal(offerFor({ ...claude, windows: [plan(94)] }, now), null, "not near its limit yet");
  assert.equal(offerFor({ ...claude, windows: [plan(99, { state: "estimated" })] }, now), null, "only what the service measured");
  assert.equal(offerFor({ ...claude, windows: [plan(99, { resetAt: earlier })] }, now), null, "a window that already refilled");
  assert.equal(offerFor({ ...claude, windows: [plan(20)], limited: true }, now)?.id, "claude", "the program said it reached its limit");
  const copilot = row({ connection: "cli-copilot", provider: "cli-copilot", signIn: false, windows: [] });
  assert.equal(offerFor(copilot, now), null, "Copilot publishes no share: nothing until it says it is at its limit");
  assert.equal(offerFor({ ...copilot, limited: true }, now)?.url, "https://github.com/settings/billing");
  const gemini = row({ connection: "cli-gemini-cli", provider: "cli-gemini-cli", windows: [plan(99)], limited: true });
  assert.equal(offerFor(gemini, now), null, "a service that offers nothing shows nothing");
  assert.equal(atOrNearLimit(gemini, now), true, "though it is at its limit");
});

test("a key's per-minute rate windows never get an offer; OpenRouter's 402 does", () => {
  const key = row({ connection: "openrouter", provider: "openrouter", signIn: false, account: null, accountLabel: null,
    windows: [{ ...plan(100), id: "requests", title: "Requests", kind: "requests", limit: 60, remaining: 0 }] });
  assert.equal(offerFor(key, now), null, "buying credit does not lift a rate limit");
  assert.equal(atOrNearLimit(key, now), false);
  assert.equal(offerFor({ ...key, outOfCredit: true }, now)?.url, "https://openrouter.ai/settings/credits");
  assert.equal(offerFor(row({ connection: "chatgpt", provider: "chatgpt", outOfCredit: true }), now), null, "a plan offer needs a plan limit");
});

test("rows built by limitsView carry the offer, the pool's sentence flags, and glanceFrom keeps them", () => {
  const connections = [
    { id: "chatgpt-gpt-5", name: "GPT-5", local: false, group: "chatgpt", signIn: true, planName: "ChatGPT plan", provider: "chatgpt" },
    { id: "cli-gemini-cli", name: "Gemini CLI", local: false, group: "cli-gemini-cli", provider: "cli-gemini-cli" },
    { id: "or", name: "OpenRouter", local: false, keyed: true, provider: "openrouter", outOfCredit: true },
  ];
  const accounts = {
    "chatgpt-gpt-5": [
      { account: "primary", label: "first@example.test", inUse: false, signIn: true, remaining: null, windows: [plan(97)], switches: true, limited: true, verified: true },
      { account: "a1b2c3d4", label: "second@example.test", inUse: true, signIn: true, remaining: null, windows: [plan(10)], switches: true },
    ],
    "cli-gemini-cli": [{ account: "primary", label: "Your sign-in", inUse: true, signIn: true, remaining: null, windows: [plan(98)] }],
  };
  const view = limitsView({ connections, reading: () => null, accounts: (id) => accounts[id] ?? [], polled: () => null, callsLastMinute: () => 0, now });
  const rows = withOffers(view.rows, now);
  const [first, second, gemini, openrouter] = rows;
  assert.equal(first.offer?.id, "chatgpt");
  assert.equal(first.limitNear, true);
  assert.equal(first.switches, true, "its list moves on to the next account");
  assert.equal(first.provider, "chatgpt");
  assert.equal(first.verified, true, "its label is who the service said it is");
  assert.equal(second.verified, undefined);
  assert.equal(second.offer, undefined, "the account with room left gets nothing");
  assert.equal(second.limitNear, undefined);
  assert.equal(gemini.offer, undefined);
  assert.equal(gemini.limitNear, true);
  assert.equal(gemini.switches, undefined, "one account: no pool to move along");
  assert.equal(openrouter.offer?.id, "openrouter");
  assert.equal(openrouter.account, null);
  const glance = glanceFrom({ ...view, rows }, { ring: "shown", saveProgress: "ask" }, 0, now);
  assert.deepEqual(glance.rows.map((one) => one.offer?.id ?? null), ["chatgpt", null, null, "openrouter"]);
});
