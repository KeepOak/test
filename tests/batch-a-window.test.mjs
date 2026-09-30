/* Batch A of the tip audit (briefs/status/audit-tip.md), the conversation and the composer, in the real window, read back
   from the engine: /bg is offered and really starts a task in this computer's window; other computers' Trunks are not
   asked for while that part is off; greyed controls say why; empty welcomes draw no mascot; a Trunk's header carries
   its colour; the computer card follows the engine's task (Carry on resumes it) and the full-size view's Pause pauses a
   working task. Headless; a scripted model. */
import test from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { newWindow, openPlace, openSettings } from "./new-window-places.mjs";
import { openChat } from "./open-chat.mjs"; // trunk-one-row: one row per Trunk

const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
};
const chat = async (page, sid) => { await openChat(page, sid); await page.locator("#prompt").waitFor(); };

test("+ › Run it in the background is offered and starts its own task; Take a screenshot says why it waits", async (t) => {
  // Nothing switched on first: /bg's own part ("session-commands") ships on since #467.
  const { page, app, errors } = await newWindow(t);
  await page.locator("#prompt").waitFor();
  await page.locator("#prompt").fill("Tidy the notes folder");
  // The + menu reads the window's command list (GET /api/commands?surface=window), which now offers /bg.
  const offered = await until(async () => {
    await page.locator('[data-act="plusmenu"]').first().click();
    const live = await page.locator('.pop [data-act="bgrun15"]').count();
    if (!live) { await page.keyboard.press("Escape"); await page.waitForTimeout(700); }
    return live > 0;
  }, 12000);
  assert.ok(offered, "the + menu offers Run it in the background");
  const shot = page.locator('.pop [data-act="shot"]');
  assert.equal(await shot.getAttribute("aria-disabled"), "true");
  assert.match(await shot.getAttribute("data-tip"), /can't take a picture of your screen/);
  const before = app.store.runs(app.runtime.owner).length;
  await page.locator('.pop [data-act="bgrun15"]').click();
  const bg = await until(async () => app.store.runs(app.runtime.owner).find((r) => r.prompt.includes("Tidy the notes folder")));
  assert.ok(bg && app.store.runs(app.runtime.owner).length > before, "/bg started the task (POST /api/commands/run)");
  assert.deepEqual(errors, []);
});

test("while Trunks on other computers is off, the @ list and the roster never ask for them; greyed rows say why", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  await call("/api/trunks", { name: "Wren", title: "Checks" });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  const asked = [];
  page.on("request", (request) => { if (request.url().includes("/api/reach/trunks/remote")) asked.push(request.url()); });
  const toasts = [];
  await page.exposeFunction("sawToast", (text) => toasts.push(text));
  await page.evaluate(() => new MutationObserver(() => { for (const el of document.querySelectorAll(".toast")) window.sawToast(el.textContent); }).observe(document.body, { childList: true, subtree: true }));
  await page.locator("#prompt").waitFor();
  await page.locator("#prompt").fill("@");
  await page.locator("#prompt").dispatchEvent("input");
  await page.locator('.pop [data-act="mention-pick"]').first().waitFor();
  await page.keyboard.press("Escape");
  await page.locator('[data-act="roster10h"]').first().click();
  const knows = page.locator('.pop input[data-sw="knows"]').first();
  await knows.waitFor();
  assert.match(await knows.getAttribute("data-tip"), /keeps no list per Trunk/);
  assert.match(await page.locator('.pop [data-why="hops"]').getAttribute("data-tip"), /three hops/);
  await page.waitForTimeout(500);
  assert.deepEqual(asked, [], "no request for other computers' Trunks while the part is off");
  assert.ok(!toasts.some((text) => /switched off/.test(text)), `no toast: ${toasts.join(" | ")}`);
  // Switched on, the roster asks (a fresh window: the part is read at most once a minute).
  await call("/api/reach/switch", { part: "remote-trunks", mode: "on" });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  await page.locator('[data-act="roster10h"]').first().click();
  assert.ok(await until(async () => asked.length > 0), "asked once the part is on");
  assert.deepEqual(errors, []);
});

test("the empty welcomes draw no mascot, only their sentence and button", async (t) => {
  const { page, errors } = await newWindow(t);
  const place = await openPlace(page, "team", "live");
  await place.locator(".empty18c p").first().waitFor();
  assert.equal(await place.locator(".empty18c img, .empty18c video").count(), 0);
  assert.equal(await place.locator(".empty18c button").count(), 1);
  assert.deepEqual(errors, []);
});

test("a Trunk's conversation header and the title row carry the Trunk's colour", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const trunk = (await call("/api/trunks", { name: "Wren", title: "Checks" })).trunk;
  await call(`/api/trunks/${trunk.id}`, { chosenColour: "#1F5139" }); // as the Trunk editor saves it (flows/trunk.js)
  assert.equal((await call("/api/trunks")).trunks.find((x) => x.id === trunk.id).chosenColour, "#1f5139");
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  await chat(page, trunk.chatSessionId);
  const tint = await until(() => page.evaluate(() => document.querySelector(".head")?.style.getPropertyValue("--tint")));
  assert.equal(tint, "#1f513966");
  assert.equal(await page.evaluate(() => document.querySelector(".titlebar").style.getPropertyValue("--tint14")), "#1f513966", "merged into the title row");
  assert.deepEqual(errors, []);
});

/* A small grey picture, as design/redesign/tools/seed-computer.mjs makes one. */
function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8;
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
/* A conversation whose task used the computer (a desktop.screenshot step with its picture), paused by the owner. */
async function usedTheComputer(app) {
  const run = app.store.createRun(app.runtime.owner, "Check the spreadsheet on screen");
  const sid = run.sessionId;
  app.store.message(sid, { role: "user", content: run.prompt });
  app.store.message(sid, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "desktop.screenshot", arguments: "{}" }] });
  const picture = await app.runtime.artifacts.write(run.id, "desk.png", "image/png", png(48, 30));
  app.store.message(sid, { role: "tool", toolCallId: "c1", content: JSON.stringify({ ok: true, result: { ...picture, window: "", width: 48, height: 30 } }) });
  app.store.event(run.id, "run.paused", { message: "Paused after this step. Nothing is lost." }); // as runtime.ts records a pause
  app.store.finish(run.id, "interrupted", "Paused after this step. Nothing is lost.");
  return { sid, run: run.id };
}

test("the computer card: Stopped with Carry on for a paused task, which resumes it; Done after", async (t) => {
  let seeded;
  const { page, app, errors } = await newWindow(t, { seed: async (app) => { seeded = await usedTheComputer(app); } });
  await chat(page, seeded.sid);
  const card = page.locator("#main .card.comp7").first();
  await card.waitFor();
  assert.match(await card.locator(".pill").innerText(), /Stopped/);
  await until(() => card.locator(".comp7-thumb img.shot7").count().then((n) => n > 0));
  assert.equal(await card.locator('[data-act="stage"][data-v="computer"]').count(), 1, "the picture opens the computer full size");
  assert.equal(await page.locator('#main [data-act="lw-resume"]').count(), 1, "one Carry on, no second Resume for the same task");
  await card.locator('[data-act="lw-resume"]').click();
  assert.ok(await until(async () => app.store.runs(app.runtime.owner).some((r) => r.sessionId === seeded.sid && r.id !== seeded.run && r.status === "completed")), "Carry on resumed it (POST /api/runs/<id>/resume)");
  assert.ok(await until(async () => /Done/.test(await card.locator(".pill").innerText())), "the card follows: Done");
  assert.equal(await card.locator('[data-act="lw-resume"]').count(), 0, "no Carry on for a finished task");
  assert.deepEqual(errors, []);
});

test("the full-size view's Pause pauses the working task (POST /api/runs/<id>/pause)", async (t) => {
  let release;
  const gate = new Promise((done) => { release = done; });
  const provider = { name: "slow", async complete() { await gate; return { content: "Done.", toolCalls: [] }; } };
  const { page, app, errors } = await newWindow(t, { provider });
  const going = app.runtime.run({ prompt: "Work slowly", onTextDelta: () => undefined }).catch(() => null);
  t.after(async () => { release(); await going; });
  const working = await until(async () => app.store.runs(app.runtime.owner).find((r) => r.status === "running"));
  assert.ok(working, "a working task");
  const runId = working.id, sid = working.sessionId;
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  await chat(page, sid);
  await page.locator('[data-act="stage"][data-v="computer"]').first().click();
  const pause = page.locator('#stage7 [data-act="lw-pause"]');
  await until(() => pause.count().then((n) => n > 0));
  assert.notEqual(await pause.getAttribute("aria-disabled"), "true", "Pause is live");
  await pause.click();
  assert.ok(await until(async () => app.store.events(runId).some((e) => e.kind === "run.pause_asked")), "the engine was asked to pause it");
  release();
  assert.deepEqual(errors, []);
});

test("the model menu names the account each connection answers through next", async (t) => {
  const seed = async (app) => {
    const { syncChatGPTPresets } = await import("../dist/index.js");
    const { accountsServiceFor } = await import("../dist/accounts/service.js");
    const chatgpt = { accessToken: async () => "x", status: async () => ({ signedIn: true, email: "owner@example.com" }) };
    syncChatGPTPresets(app.runtime.models, chatgpt, true, "BranchTest");
    accountsServiceFor(app.runtime.models).deps.chatgpt = chatgpt;
  };
  const { page, call, errors } = await newWindow(t, { seed });
  const glance = await call("/api/usage/glance");
  const row = glance.rows.find((r) => r.inUse && r.accountLabel && /ChatGPT/.test(r.connectionName));
  assert.ok(row, JSON.stringify(glance.rows.map((r) => [r.connectionName, r.accountLabel, r.inUse])));
  await page.locator("#prompt").waitFor();
  await page.locator('[data-act="modelmenu2"]').first().click();
  const sub = page.locator(`.pop [data-act="pick-model"][data-v="${row.presets[0]}"] .mi-s`);
  assert.equal(await sub.innerText(), `${row.connectionName} · ${row.accountLabel} · used next`);
  assert.deepEqual(errors, []);
});

test("the conversation menu pins an ordinary conversation (POST /api/sessions/<id>/pin)", async (t) => {
  const { page, app, call, errors } = await newWindow(t);
  const run = await app.runtime.run({ prompt: "Plan the week", onTextDelta: () => undefined });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  await chat(page, run.sessionId);
  await page.locator('[data-act="chatmenu"]').first().click();
  const pin = page.locator('.pop [data-act="pin-id"]');
  assert.notEqual(await pin.getAttribute("aria-disabled"), "true", "Pin to top is live");
  await pin.click();
  const pinned = await until(async () => (await call("/api/sessions")).sessions.find((s) => s.sessionId === run.sessionId)?.pinned);
  assert.equal(pinned, true);
  assert.deepEqual(errors, []);
});

test("the flag dialog says why a flag can't go to the Branch team, and points to no setting", async (t) => {
  const { page, app, errors } = await newWindow(t);
  const run = await app.runtime.run({ prompt: "Say hello", onTextDelta: () => undefined });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  await chat(page, run.sessionId);
  const reply = page.locator("#conversation .b[data-i15]").last();
  await reply.hover();
  await reply.locator('[data-act="flag"]').first().click();
  const row = page.locator(".dlg .flsend17c");
  await row.waitFor();
  assert.match(await row.innerText(), /no way to send one to the Branch team/);
  assert.doesNotMatch(await page.locator(".dlg").innerText(), /Data & usage/);
  assert.equal(await page.locator('.dlg [data-act="flgo17c"]').count(), 0);
  assert.equal(await page.locator("#fl-send17c").isDisabled(), true);
  assert.deepEqual(errors, []);
});

test("Settings › General's shared commands switch shows this window's on, and turning it off keeps the phone's off", async (t) => {
  const { page, call, errors } = await newWindow(t);
  await openSettings(page, "general");
  const sw = page.locator("#g-cmds");
  await sw.waitFor();
  assert.equal(await sw.isChecked(), true, "on, as this window does");
  assert.match(await sw.locator("xpath=..").locator("small").innerText(), /never turns them on for your phone or chat apps/);
  await sw.click();
  assert.equal(await until(async () => (await call("/api/commands?surface=window")).mode === "off"), true, "off for this window");
  assert.equal((await call("/api/commands?surface=phone")).mode, "off");
  await sw.click();
  assert.equal(await until(async () => (await call("/api/commands?surface=window")).mode === "on"), true, "on again");
  assert.equal((await call("/api/commands?surface=phone")).mode, "off", "the phone's stay off");
  assert.deepEqual(errors, []);
});

test("a paused task's card says what Resume does before the owner presses it", async (t) => {
  let sid;
  const { page, errors } = await newWindow(t, { seed: (app) => {
    const run = app.store.createRun(app.runtime.owner, "Tidy the notes folder");
    sid = run.sessionId;
    app.store.message(sid, { role: "user", content: run.prompt });
    app.store.finish(run.id, "interrupted", "Paused after this step. Nothing is lost.");
  } });
  await chat(page, sid);
  const card = page.locator('#main .lw-chat').first();
  await card.waitFor({ timeout: 20000 });
  assert.match(await card.innerText(), /Resume starts a new task using this conversation’s saved messages/);
  assert.equal(await card.locator('[data-act="lw-resume"]').count(), 1);
  assert.deepEqual(errors, []);
});
