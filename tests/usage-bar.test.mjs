/**
 * mac7/usage-bar: Branch's own answer to the menu-bar usage apps.
 *
 * The point of the feature is honesty, so these are mostly tests that a number does NOT appear:
 * that an unknown remainder never renders as a figure, that a service which publishes nothing gets
 * a sentence rather than a full bar, that a subscription account is never asked a question whose
 * asking would spend the allowance it measures, and that somebody else in the house is refused the
 * owner's figures outright rather than shown a thinned-out version of them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readRateLimit, goDurationSeconds, resetInstant } from "../dist/rate-limit-headers.js";
import { limitsView, limitLines, notPublished, runsHere } from "../dist/usage-limits.js";
import { askable, windowsFromKey, nextDelayMs, backoffMs, OpenRouterKeyReader } from "../dist/usage-limits-openrouter.js";
import { smartOrder, freshState, remainingShown, unknownRemainingForOrder } from "../dist/accounts/pool.js";
import { usageLimits } from "../dist/usage-limits-api.js";
import { createBranch } from "../dist/index.js";
import { asPerson } from "../dist/people/context.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const windowOf = (reading, id, source) =>
  reading.windows.find((window) => window.id === id && (source === undefined || window.source.includes(source)));

/* ---------------------------------------------------------------- the reader */

test("every documented header family is read, the token side and Anthropic's included", () => {
  const openai = readRateLimit(new Headers({
    "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-requests": "499", "x-ratelimit-reset-requests": "6m0s",
    "x-ratelimit-limit-tokens": "30000", "x-ratelimit-remaining-tokens": "29500", "x-ratelimit-reset-tokens": "6ms",
  }), NOW);
  assert.equal(windowOf(openai, "requests").remaining, 499);
  assert.equal(windowOf(openai, "requests").resetSeconds, 360, "6m0s is six minutes");
  const tokens = windowOf(openai, "tokens");
  assert.equal(tokens.limit, 30000);
  assert.equal(tokens.remaining, 29500, "the token side was never read before mac7/usage-bar");
  assert.equal(tokens.counts, "tokens");

  /* Branch read nothing at all from an Anthropic answer before this change. */
  const anthropic = readRateLimit(new Headers({
    "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-requests-remaining": "49",
    "anthropic-ratelimit-requests-reset": "2026-09-18T12:05:00Z",
    "anthropic-ratelimit-tokens-limit": "40000", "anthropic-ratelimit-tokens-remaining": "39000",
    "anthropic-ratelimit-input-tokens-limit": "20000", "anthropic-ratelimit-input-tokens-remaining": "19000",
    "anthropic-ratelimit-output-tokens-limit": "8000", "anthropic-ratelimit-output-tokens-remaining": "7000",
  }), NOW);
  assert.deepEqual(anthropic.windows.map((one) => one.id).sort(),
    ["input-tokens", "output-tokens", "requests", "tokens"]);
  assert.equal(windowOf(anthropic, "requests").resetSeconds, 300, "an RFC 3339 reset is a real clock time");
  assert.equal(windowOf(anthropic, "output-tokens").remaining, 7000);
  for (const window of anthropic.windows) assert.match(window.source, /anthropic-ratelimit/);

  const groq = readRateLimit(new Headers({
    "x-ratelimit-limit-requests": "14400", "x-ratelimit-remaining-requests": "14399", "x-ratelimit-reset-requests": "2.3s",
    "x-ratelimit-limit-tokens": "18000", "x-ratelimit-remaining-tokens": "17500", "x-ratelimit-reset-tokens": "7.66s",
  }), NOW);
  assert.equal(windowOf(groq, "tokens").remaining, 17500);
  assert.equal(readRateLimit(new Headers({}), NOW), null, "nothing said is still null, not a zero");
});

test("Go durations parse, and 6ms is six milliseconds and not six minutes", () => {
  assert.equal(goDurationSeconds("6m0s"), 360);
  assert.equal(goDurationSeconds("1s"), 1);
  assert.equal(goDurationSeconds("6ms"), 0.006, "matching m before ms would report a reset 360,000x too far away");
  assert.equal(goDurationSeconds("500ms"), 0.5);
  assert.equal(goDurationSeconds("1h2m3s"), 3723);
  assert.equal(goDurationSeconds("1.5s"), 1.5);
  assert.equal(goDurationSeconds("6m"), 360);
  assert.equal(goDurationSeconds("later"), null, "what it does not recognise is null, never a guess");
  assert.equal(goDurationSeconds("6x0y"), null);
  /* The old reader stripped a trailing "s" and called Number() on the rest, so "6m0s" became
     "6m0" became NaN became null: the reset was silently missing in the common case. */
  assert.ok(Number.isNaN(Number("6m0s".replace(/s$/, ""))), "the shape of the old bug");
});

test("a reset value is read in every documented shape, and nothing else", () => {
  assert.equal(resetInstant("30", NOW), NOW + 30_000, "plain seconds");
  assert.equal(resetInstant("6m0s", NOW), NOW + 360_000, "a Go duration");
  assert.equal(resetInstant("2026-09-18T12:05:00Z", NOW), Date.parse("2026-09-18T12:05:00Z"), "an RFC 3339 instant");
  assert.equal(resetInstant("Fri, 18 Sep 2026 12:05:00 GMT", NOW), Date.parse("2026-09-18T12:05:00Z"), "an HTTP date");
  assert.equal(resetInstant("soon", NOW), null);
  assert.equal(resetInstant(null, NOW), null);
});

/* ---------------------------------------------------------------- never a made-up number */

test("smartOrder may prefer an unknown in the middle, but that stand-in never reaches a screen", () => {
  const states = new Map([
    ["known-low", { ...freshState(), remaining: 10 }],
    ["unknown", freshState()],
    ["known-high", { ...freshState(), remaining: 90 }],
  ]);
  const accounts = ["known-low", "unknown", "known-high"].map((id) => ({ id, pinned: false }));
  assert.deepEqual(smartOrder(accounts, states).map((one) => one.id), ["known-high", "unknown", "known-low"]);
  assert.equal(unknownRemainingForOrder, 50, "the routing tie-break is still there");
  assert.equal(remainingShown(states.get("unknown")), null, "but a screen is handed nothing, not 50");
  assert.equal(remainingShown(undefined), null);
});

const deps = (over = {}) => ({
  connections: [], reading: () => null, accounts: () => [], polled: () => null,
  callsLastMinute: () => 0, now: NOW, ...over,
});

test("an unknown remaining never renders as a number anywhere on the panel", () => {
  const view = limitsView(deps({
    connections: [{ id: "chatgpt", name: "ChatGPT", local: false }],
    accounts: () => [
      { account: "a", label: "Work", inUse: true, remaining: null, signIn: true },
      { account: "b", label: "Home", inUse: false, remaining: 64, signIn: true },
    ],
  }));
  const [silent, said] = view.rows;
  assert.equal(silent.state, "not_published");
  assert.deepEqual(silent.windows, [], "no window at all, so nothing can draw a bar");
  assert.equal(said.windows[0].remaining, 64);
  const text = limitLines(view, NOW).join("\n");
  assert.ok(!/\b50\b/.test(text), `the routing stand-in leaked onto the screen:\n${text}`);
  assert.match(text, /Work \(in use\): This service does not say what it allows/);
  assert.match(text, /ChatGPT — Home:/);
  assert.match(text, /1 of 2 connections reports a limit\. The other one does not publish one\./);
});

test("a service that publishes nothing gets the honest sentence, and a local model its own", () => {
  const view = limitsView(deps({
    connections: [{ id: "gemini", name: "Gemini", local: false }, { id: "ollama", name: "Llama here", local: true }],
  }));
  assert.equal(view.rows[0].state, "not_published");
  assert.equal(view.rows[0].note, notPublished);
  assert.deepEqual(view.rows[0].windows, []);
  assert.equal(view.rows[1].note, runsHere);
  assert.deepEqual(view.rows[1].windows, [], "a local model is never shown as 100% of anything");
  assert.equal(limitsView(deps()).empty, true);
  assert.match(limitsView(deps()).summary, /No model connection is set up yet/);
});

test("a limit with no remainder beside it is an estimate, says so, and says from what", () => {
  const view = limitsView(deps({
    connections: [{ id: "groq", name: "Groq", local: false }],
    callsLastMinute: () => 12,
    reading: () => readRateLimit(new Headers({ "x-ratelimit-limit-requests": "30" }), NOW),
  }));
  const [window] = view.rows[0].windows;
  assert.equal(view.rows[0].state, "estimated");
  assert.equal(window.remaining, 18);
  assert.match(window.from, /estimated from Branch's own count of 12 call\(s\)/);
  assert.match(limitLines(view, NOW).join("\n"), /estimate —/);
});

test("the ChatGPT plan row is measured, and says the service reports it unofficially", () => {
  const view = limitsView(deps({
    connections: [{ id: "chatgpt", name: "ChatGPT", local: false }],
    accounts: () => [{ account: "a", label: "Mine", inUse: true, remaining: 66, signIn: true }],
  }));
  assert.equal(view.rows[0].state, "measured");
  assert.match(view.rows[0].windows[0].from, /unofficially/);
  assert.match(limitLines(view, NOW).join("\n"), /Plan window: 66% left/);
});

/* ---------------------------------------------------------------- never poll a plan account */

test("a plan account is never asked: no address is derived for it at all", () => {
  const openRouter = { id: "or", provider: { audio: () => ({ endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-or-x" }) } };
  assert.equal(askable(openRouter, "api-key").url, "https://openrouter.ai/api/v1/key");
  assert.equal(askable(openRouter, null).url, "https://openrouter.ai/api/v1/key", "a connection with no pool is a plain key");
  for (const kind of ["chatgpt", "cli", "claude"])
    assert.equal(askable(openRouter, kind), null, `${kind} is a subscription: asking would spend what it measures`);
  const openai = { id: "oa", provider: { audio: () => ({ endpoint: "https://api.openai.com/v1", apiKey: "sk-x" }) } };
  assert.equal(askable(openai, "api-key"), null, "only the one documented source is ever asked");
  assert.equal(askable({ id: "x", provider: {} }, "api-key"), null);
  assert.equal(askable({ id: "x", provider: { audio: () => { throw new Error("no"); } } }, "api-key"), null);
});

test("the reader makes no call for a connection it may not ask", async () => {
  const calls = [];
  const reader = new OpenRouterKeyReader({ fetchImpl: async (url) => { calls.push(url); return new Response("{}"); } });
  const plan = { id: "chatgpt", provider: { audio: () => ({ endpoint: "https://openrouter.ai/api/v1", apiKey: "k" }) } };
  assert.equal(await reader.refresh("chatgpt", askable(plan, "chatgpt")), false);
  assert.deepEqual(calls, [], "a subscription account must never be probed");
  assert.equal(reader.reading("chatgpt"), null);
});

test("OpenRouter's documented answer becomes rows; credit is money, never a share", async () => {
  const body = { data: { limit: 20, limit_remaining: 12.5, limit_reset: "2026-09-19T00:00:00Z",
    free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } };
  const reader = new OpenRouterKeyReader({ fetchImpl: async () => new Response(JSON.stringify(body)), now: () => NOW });
  const target = askable({ id: "or", provider: { audio: () => ({ endpoint: "https://openrouter.ai/api/v1", apiKey: "k" }) } }, "api-key");
  assert.equal(await reader.refresh("or", target), true);
  const view = limitsView(deps({ connections: [{ id: "or", name: "OpenRouter", local: false }], polled: (id) => reader.reading(id) }));
  const money = view.rows[0].windows.find((one) => one.id === "credits");
  assert.equal(money.kind, "money");
  assert.equal(money.remaining, 12.5);
  assert.match(money.from, /documented key endpoint/);
  assert.ok(!/%/.test(limitLines(view, NOW).find((line) => line.includes("Credit"))), "money has no denominator, so no percentage");
  assert.deepEqual(windowsFromKey({ data: {} }, NOW), [], "nothing said is no window");
  assert.deepEqual(windowsFromKey("rubbish", NOW), []);
});

test("a refusal keeps the last reading with its real age and says it could not be refreshed", async () => {
  let answer = new Response(JSON.stringify({ data: { limit: 20, limit_remaining: 20 } }));
  const reader = new OpenRouterKeyReader({ fetchImpl: async () => answer, now: () => NOW });
  const target = { url: "https://openrouter.ai/api/v1/key", apiKey: "k" };
  assert.equal(await reader.refresh("or", target), true);
  answer = new Response("", { status: 429, headers: { "retry-after": "30" } });
  assert.equal(await reader.refresh("or", target), false);
  assert.equal(reader.reading("or").windows[0].remaining, 20, "the row does not go blank");
  assert.match(reader.reading("or").note, /asked us to wait/);
  assert.equal(await reader.refresh("or", target), false, "and it does not retry in a tight loop");
});

test("the cadence stays in the 2-to-30-minute band and a refusal backs off to an hour", () => {
  assert.equal(nextDelayMs({ panelOpenedAgoMs: 0, workingAgoMs: null, onBattery: false }), 120_000);
  assert.equal(nextDelayMs({ panelOpenedAgoMs: 20 * 60_000, workingAgoMs: null, onBattery: false }), 300_000);
  assert.equal(nextDelayMs({ panelOpenedAgoMs: null, workingAgoMs: 60_000, onBattery: false }), 300_000);
  assert.equal(nextDelayMs({ panelOpenedAgoMs: 2 * 60 * 60_000, workingAgoMs: null, onBattery: false }), 900_000);
  assert.equal(nextDelayMs({ panelOpenedAgoMs: null, workingAgoMs: null, onBattery: false }), 1_800_000);
  assert.equal(nextDelayMs({ panelOpenedAgoMs: 0, workingAgoMs: 0, onBattery: true }), 1_800_000);
  assert.equal(backoffMs(1, 30_000), 30_000, "the service's own Retry-After wins");
  assert.equal(backoffMs(9, null, () => 0.5), 3_600_000, "and it never climbs past an hour");
  assert.equal(backoffMs(1, null, () => 0.5), 60_000);
});

/* ---------------------------------------------------------------- whose figures these are */

test("a household person is refused the owner's figures outright, not shown a thinned-out view", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-usage-bar-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });

  const owner = await usageLimits(app);
  assert.ok(Array.isArray(owner.rows), "the owner sees the panel");

  /* The profile switch: whoever is sitting at this computer. */
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  await assert.rejects(() => usageLimits(app), /Only the owner|owner/i, "the switch hides the owner's figures");
  app.store.profiles.switch({ profileId: null });

  /* And a person signed in from their own device is held to the same rule. */
  await assert.rejects(() => asPerson({ profileId: person.id, keyId: "phone" }, () => usageLimits(app)),
    (error) => error.status === 403, "a person's own key is refused too");
});

