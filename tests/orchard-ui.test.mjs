/**
 * Orchard in the window (public/app/places/orchard.js), in a headless browser against a scratch engine: Automations'
 * board tab, a card posted from New card, planted, grown and picked; a card dragged onto a Trunk's face is given to that
 * Trunk; a growing card's question is answered on the card by its exact fingerprint and the same task ripens it; every
 * word has English and real French; nothing scrolls sideways at 400 px; no page errors. Each step is checked through
 * the engine's own GET /api/orchard, never through what the page says.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { newWindow, openPlace } from "./new-window-places.mjs";
import { savePolicy } from "../dist/index.js";

const allowedNote = /The call you asked about did not run/;
/** "Done." for every card; a card called "write <file>" writes that file, and again after a yes. */
const provider = { name: "scripted", async complete(request) {
  const last = request.messages.at(-1), text = String(last?.content ?? "");
  const named = /^write (\S+)$/m.exec(request.messages.map((m) => String(m.content ?? "")).join("\n"));
  const write = { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: named?.[1] ?? "x.txt", content: "hello" }) }] };
  if (named && last?.role === "user") return write;
  if (named && last?.role === "tool" && !/"ok":true/.test(text) && allowedNote.test(String(request.messages[0]?.content ?? ""))) return write;
  return { content: "Done.", toolCalls: [] };
} };
const until = async (check, what) => {
  for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.fail(what);
};

test("every word Orchard shows has English and real French", async () => {
  const PUBLIC = new URL("../public/", import.meta.url);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  const source = await readFile(new URL("app/places/orchard.js", PUBLIC), "utf8");
  const keys = [...new Set([...source.matchAll(/\bt\(\s*[`"]([A-Za-z0-9_.-]+)[`"]/g)].map((m) => m[1]))];
  const lanes = [...["seed", "growing", "ripe", "picked", "blocked"].map((lane) => `window.places.orchard.lane.${lane}`),
    ...["owner", "chat", "key"].map((by) => `window.places.orchard.by.${by}`), "window.places.orchard.failed-count", "window.places.orchard.failed-count.one"];
  const brand = new Set(["window.places.orchard.tab"]); // "Orchard" is Branch's name for it in every language
  assert.deepEqual([...keys, ...lanes].filter((key) => !en[key] || !fr[key] || (en[key] === fr[key] && !brand.has(key))), []);
});

test("Orchard from the window: post, plant, grow, pick, give by dragging onto a face, and answer a card's question", async (t) => {
  const { app, page, errors, call, root } = await newWindow(t, { width: 1280, height: 900, provider, seed: async (branch) => {
    savePolicy(branch.store, branch.runtime.owner, { preset: "ask-before-changes" });
    branch.trunks.create({ name: "Ed" });
    branch.flowsBoards.orchard.add({ title: "Sweep the path" }, { kind: "chat" });
    branch.flowsBoards.orchard.add({ title: "Clean the gutters" }, { kind: "chat" });
  } });
  const lanes = async () => (await call("/api/orchard")).lanes;
  const find = async (title) => Object.values(await lanes()).flat().find((c) => c.title === title);
  const place = await openPlace(page, "automations", "board");

  // A chat's card waits for the owner's yes; Plant it grows it, and it ripens.
  const sweep = place.locator(".orc-card", { hasText: "Sweep the path" });
  await sweep.locator('[data-act="orc-plant"]').click();
  await until(async () => (await find("Sweep the path"))?.lane === "ripe", "planted, it grew and ripened");
  await place.locator(".col15[data-col15='ripe'] .orc-card", { hasText: "Sweep the path" }).locator('[data-act="orc-pick"]').click();
  await until(async () => (await find("Sweep the path"))?.lane === "picked", "picked");

  // Dragged onto Ed's face, the other card is given to Ed (that is the owner's yes too).
  const ed = app.trunks.records.list().find((tr) => tr.name === "Ed");
  await place.locator(".orc-card", { hasText: "Clean the gutters" }).dragTo(place.locator(`.orc-give[data-orc-to="${ed.id}"]`));
  await until(async () => (await find("Clean the gutters"))?.assignee === ed.id, "given to Ed");

  // New card: its question shows on the card, and Allow once carries the same task on to ripe.
  await place.locator('[data-act="orc-new"]').click();
  await page.locator("#orc-title").fill("write gate.txt");
  await page.locator('[data-act="orc-save"]').click();
  const gate = place.locator(".orc-card", { hasText: "write gate.txt" });
  await gate.locator('.orc-ask [data-act="orc-ask"][data-v="allow"]').waitFor({ timeout: 30000 });
  const asked = await find("write gate.txt");
  assert.equal(asked.lane, "growing");
  assert.equal(asked.asks.length, 1);
  await gate.locator('.orc-ask [data-act="orc-ask"][data-v="allow"]').click();
  await until(async () => (await find("write gate.txt"))?.lane === "ripe", "the yes carried the task on");
  assert.equal((await find("write gate.txt")).runId, asked.runId, "the same task, not a second one");
  assert.ok(existsSync(join(root, "workspace", "gate.txt")));

  // At 400 px the board scrolls inside itself; the page never scrolls sideways.
  await page.setViewportSize({ width: 400, height: 900 });
  await place.locator(".orc-board").waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0);
  assert.deepEqual(errors, []);
});
