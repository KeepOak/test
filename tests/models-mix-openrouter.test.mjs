/**
 * Settings › Models: "Only ones I list" under OpenRouter picks, and "Mix models on hard questions".
 * - OpenRouter's companies come from its own documented list (GET /api/v1/providers, no key sent), asked only through the
 *   owner's route, only when an OpenRouter connection is set up, never under Lockdown, and kept for a day; a slug that is
 *   not plain is left out. The chosen companies travel as `provider.only`, to openrouter.ai alone.
 * - Mixing: with the difficulty card's easy and hard picks two different connections and `mixHard` on, a hard task is
 *   asked of both and the hard one writes the answer (a mixture in the model picker, named after them); an easy task, or
 *   the switch off, goes to one connection as before. No real service is called.
 *
 * Mutation notes (each turns this file red):
 * - openrouter.ts openRouterCompanies: drop the isOpenRouterEndpoint refusal -> "another address is refused" fails.
 * - openrouter.ts: drop the slug filter                                      -> "a slug that is not plain" fails.
 * - openrouter.ts: drop the day's cache                                      -> "asked once a day" fails.
 * - api.ts companies: drop the lockedDown check                              -> "Lockdown" fails.
 * - difficulty.ts: hard always the hardModel                                -> "a hard task is asked of both" fails.
 * - mixture.ts hardMixture: drop the easy !== hard check                     -> "one connection picked twice" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveSavings, readSavings, openRouterRouting } from "../dist/index.js";
import { openRouterCompanies, openRouterAddress } from "../dist/model-savings/openrouter.js";
import { savingsApi } from "../dist/model-savings/api.js";
import { setLockdown } from "../dist/lockdown.js";
import { startServer } from "../dist/server.js";

const answer = (content) => ({ content, toolCalls: [] });
function scripted(name, reply) {
  const provider = { name, requests: [], async complete(request) { provider.requests.push(request); return reply(request); } };
  return provider;
}
const openRouterProvider = (endpoint = "https://openrouter.ai/api/v1") => ({ name: "openai", audio: () => ({ endpoint, apiKey: "k" }), embeddings: () => null, async complete() { return answer("or"); } });
const listing = { data: [
  { name: "Cerebras", slug: "cerebras", headquarters: "US" },
  { name: "Black Forest Labs", slug: "black-forest-labs" },
  { name: "Odd <b>", slug: "odd slug!" },
  { name: "Anthropic", slug: "anthropic" },
] };
function fetcher(body = listing, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), headers: init?.headers }); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); };
  return { fetchImpl, calls };
}

async function fixture(t, presets) {
  const root = await mkdtemp(join(tmpdir(), "branch-mix-or-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const url = (path) => new URL(`http://branch.invalid${path}`);
  const call = (path, method, body) => savingsApi(app, { method }, path, url(path), async () => body);
  return { app, call, owner: app.runtime.owner, root };
}

test("OpenRouter's companies: its own list, plain slugs only, sorted, kept for a day, never another address", async () => {
  const { fetchImpl, calls } = fetcher();
  const companies = await openRouterCompanies("https://openrouter.ai/api/v1", fetchImpl, 1_000);
  assert.deepEqual(companies, [{ slug: "anthropic", name: "Anthropic" }, { slug: "black-forest-labs", name: "Black Forest Labs" }, { slug: "cerebras", name: "Cerebras" }]);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/providers");
  assert.equal(calls[0].headers, undefined, "no key is sent");
  await openRouterCompanies("https://openrouter.ai/api/v1", fetchImpl, 2_000);
  assert.equal(calls.length, 1, "asked once a day");
  await openRouterCompanies("https://openrouter.ai/api/v1", fetchImpl, 1_000 + 25 * 3600_000);
  assert.equal(calls.length, 2, "and again the next day");
  await assert.rejects(openRouterCompanies("https://evil.example/api/v1", fetchImpl, 1), /not OpenRouter's address/);
  assert.equal(calls.length, 2, "another address is refused before anything is sent");
  await assert.rejects(openRouterCompanies("https://sub.openrouter.ai/api/v1", fetcher({}, 503).fetchImpl, 1), /answered 503/);
  await assert.rejects(openRouterCompanies("https://eu.openrouter.ai/api/v1", fetcher({ nope: 1 }).fetchImpl, 1), /shape/);
  assert.equal(openRouterAddress([{ provider: openRouterProvider() }]), "https://openrouter.ai/api/v1");
  assert.equal(openRouterAddress([{ provider: { audio: () => ({ endpoint: "https://api.openai.com/v1" }) } }, { provider: { audio: () => { throw new Error("x"); } } }]), null);
});

test("the owner's route: refused with no OpenRouter connection and under Lockdown; the list, then only those companies are sent", async (t) => {
  const plain = await fixture(t, [{ id: "main", name: "Main", provider: scripted("main", () => answer("hi")), model: "m" }]);
  assert.equal((await plain.call("/api/model-savings", "GET")).openRouter, false);
  await assert.rejects(plain.call("/api/model-savings/companies", "POST", {}), (error) => error.status === 409 && /No OpenRouter connection/.test(error.message));
  const { app, call, owner } = await fixture(t, [{ id: "or", name: "OpenRouter", provider: openRouterProvider("https://openrouter.ai/api/v1/"), model: "x/y" }]);
  const { fetchImpl, calls } = fetcher();
  app.companiesFetch = fetchImpl;
  assert.equal((await call("/api/model-savings", "GET")).openRouter, true);
  await assert.rejects(call("/api/model-savings/companies", "GET"), (error) => error.status === 405);
  setLockdown(app.store, owner, { on: true });
  await assert.rejects(call("/api/model-savings/companies", "POST", {}), (error) => error.status === 409 && /Lockdown/.test(error.message));
  assert.equal(calls.length, 0, "nothing asked under Lockdown");
  setLockdown(app.store, owner, { on: false });
  const listed = await call("/api/model-savings/companies", "POST", {});
  assert.ok(listed.companies.some((c) => c.slug === "cerebras"));
  await call("/api/model-savings", "POST", { card: "openrouter", values: { mode: "on", sort: null, only: ["cerebras", "anthropic"] } });
  assert.deepEqual(openRouterRouting(app.store, owner), { only: ["cerebras", "anthropic"] });
  await assert.rejects(call("/api/model-savings", "POST", { card: "openrouter", values: { only: ["bad slug!"] } }), (error) => error.status === 400);
});

test("mixing: a hard task is asked of both picks and the hard one writes; easy tasks and the switch off use one", async (t) => {
  const verdicts = [];
  const cheap = scripted("cheap", (request) => (/You sort tasks/.test(request.messages[0].content) ? answer(verdicts.shift() ?? "EASY") : answer("cheap draft")));
  const strong = scripted("strong", (request) => answer(request.messages.some((m) => /Other models were asked/.test(String(m.content))) ? "merged answer" : "strong alone"));
  const { app, call, owner, root } = await fixture(t, [{ id: "cheap", name: "Cheap", provider: cheap, model: "cheap-1" }, { id: "strong", name: "Strong", provider: strong, model: "strong-1" }]);
  assert.equal(readSavings(app.store, owner, "difficulty").mixHard, false, "off until the owner chooses");
  await call("/api/model-savings", "POST", { card: "difficulty", values: { mode: "on", classifierModel: "cheap", easyModel: "cheap", hardModel: "strong", mixHard: true } });
  const mixture = app.runtime.models.presets.get("mixture-hard-questions");
  assert.ok(mixture, "the mixture is in the model picker");
  assert.equal(mixture.name, "Strong + Cheap", "named after its two connections");
  const view = await call("/api/model-savings", "GET");
  assert.deepEqual(view.liveMixtures, ["mixture-hard-questions"]);
  assert.ok(!view.connections.some((c) => c.id === "mixture-hard-questions"));

  verdicts.push("HARD");
  const hard = await app.runtime.run({ prompt: "Work out why the invoices from March do not add up and what to change" });
  assert.equal(hard.output, "merged answer", "the hard connection wrote the answer from both");
  assert.ok(cheap.requests.some((r) => !/You sort tasks/.test(r.messages[0].content) && r.tools.length === 0), "the easy pick was asked the hard question too");
  const routed = app.store.events(hard.id).find((e) => e.kind === "model.routed").data;
  assert.equal(routed.preset, "mixture-hard-questions");

  verdicts.push("EASY");
  const easy = await app.runtime.run({ prompt: "Write a short note about the meeting we had on Tuesday with our suppliers, covering the new prices" });
  assert.equal(easy.output, "cheap draft", "an easy task goes to the easy pick alone");

  await call("/api/model-savings", "POST", { card: "difficulty", values: { mixHard: false } });
  assert.equal(app.runtime.models.presets.has("mixture-hard-questions"), false, "switched off, the mixture leaves the picker");
  verdicts.push("HARD");
  const alone = await app.runtime.run({ prompt: "Work out why the invoices from April do not add up and what to change" });
  assert.equal(alone.output, "strong alone");

  saveSavings(app.store, owner, "difficulty", { easyModel: "strong", hardModel: "strong", mixHard: true });
  await call("/api/model-savings", "POST", { card: "difficulty", values: { mixHard: true } });
  assert.equal(app.runtime.models.presets.has("mixture-hard-questions"), false, "one connection picked twice: nothing to mix");
  await assert.rejects(call("/api/model-savings", "POST", { card: "mixtures", values: { mixtures: [{ id: "hard-questions", name: "Mine", references: ["cheap", "strong"], aggregator: "strong" }] } }),
    (error) => error.status === 400 && /Branch's own/.test(error.message), "the hard-questions id is Branch's own");

  // A member connection taken out takes the mixture with it.
  await call("/api/model-savings", "POST", { card: "difficulty", values: { easyModel: "cheap", hardModel: "strong", mixHard: true } });
  assert.ok(app.runtime.models.presets.has("mixture-hard-questions"));
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const forgot = await fetch(new URL("/api/connections/forget", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "cheap" }) });
  assert.equal(forgot.status, 200);
  assert.equal(app.runtime.models.presets.has("mixture-hard-questions"), false, "no mixture left pointing at a connection that is gone");
});

test("the window: Only ones I list opens OpenRouter's companies as chips across the card, and a chip saves the list", async (t) => {
  const { newWindow } = await import("./new-window-places.mjs");
  const { openSettingsPage, setLevel } = await import("./settings-window.mjs");
  const presets = [{ id: "or", name: "OpenRouter · Qwen3.6 Coder 480B", provider: openRouterProvider(), model: "qwen/qwen3.6-coder" }];
  const { app, page, errors } = await newWindow(t, { options: { presets }, width: 1280, height: 900 });
  const { fetchImpl, calls } = fetcher();
  app.companiesFetch = fetchImpl;
  await openSettingsPage(page, "models");
  await setLevel(page, "technical");
  const only = page.locator('.set-col [data-act="m-orlist"]');
  await only.waitFor({ timeout: 20000 });
  assert.equal(calls.length, 0, "nothing is asked of OpenRouter until the list is opened");
  await only.click();
  const chips = page.locator('.set-col [data-act="m-orco"]');
  await chips.nth(2).waitFor({ timeout: 20000 });
  assert.deepEqual(await chips.allTextContents(), ["Anthropic", "Black Forest Labs", "Cerebras"], "plain slugs only, sorted");
  await page.locator('.set-col [data-act="m-orco"][data-v="cerebras"]').click();
  await page.locator('.set-col [data-act="m-orco"][data-v="cerebras"][aria-pressed="true"]').waitFor();
  assert.deepEqual(openRouterRouting(app.store, app.runtime.owner), { only: ["cerebras"] }, "the chip saved the list");
  for (const width of [900, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const group = document.querySelector('.set-col .chips8[role="group"]'), row = group.closest(".ctl");
      const box = (node) => node.getBoundingClientRect();
      const picks = document.querySelector('.set-col [data-act="m-orlist"]').closest(".ctl");
      const style = getComputedStyle(row), inner = box(row).width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { group: box(group).toJSON(), inner, picks: box(picks).toJSON(),
        chips: [...group.querySelectorAll("button")].map((chip) => box(chip).toJSON()) };
    });
    assert.ok(layout.group.width >= layout.inner - 1, `${width}: the chips run across the whole row, not its title column (${Math.round(layout.group.width)} of ${Math.round(layout.inner)} px)`);
    assert.ok(layout.group.top >= layout.picks.bottom - 0.5, `${width}: the chips sit below OpenRouter picks, never over it`);
    for (const chip of layout.chips) assert.ok(chip.left >= layout.group.left - 0.5 && chip.right <= layout.group.right + 0.5, `${width}: each chip stays inside its row`);
  }
  assert.deepEqual(errors, []);
});
