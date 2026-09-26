/**
 * Wave 6: the web app's own screens. Markdown that is rendered and never trusted, the "Look inside"
 * panel, stepping into a task while it works, the context meter, the developer playground, the
 * installable-app files, and switching the language.
 *
 * Redesign: the new window (public/app/**). Replies are #conversation > .b, their words .txt, drawn by
 * public/app/chat/markdown.js text(); the approval card is #live-ask with the action's verb (.btn.pri).
 */
import test from "node:test";
import { openPlace, openSettingFor, showEverything } from "./places.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "markdown-sample.md");

/** A workspace, a server and a connected browser page, cleaned up when the test ends. */
async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-web-ui-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    ...(provider ? { provider } : {}),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  /* Redesign phase 1: a conversation begun in the window starts on Ask first. These tests are about
     something else, so their conversations follow the setting as before (tests/conversation-mode.test.mjs
     covers Ask first). */
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, server, errors, browser };
}
/** Walks past the first-run panel, when there is one, so the conversation column is what is on screen. */
async function settle(page) {
  /* Redesign: the new window opens on the conversation; setup is opened from Guide, not in the way. */
  if (await page.locator("#first-run").count() === 0 || await page.locator("#first-run").isHidden()) return;
  /* "Try it without an account" finishes first run in one click. */
  await page.getByRole("button", { name: /Try it without an account/ }).click();
  await page.locator("#first-run").waitFor({ state: "hidden" });
}

test("U1 the markdown fixture renders its real structure and never becomes markup", async (t) => {
  const { page, errors } = await fixture(t);
  const source = await readFile(FIXTURE, "utf8");
  /* Redesign: the new window's renderer, public/app/chat/markdown.js text(), which returns the reply's HTML. */
  const shape = await page.evaluate(async (markdown) => {
    const { text } = await import("/app/chat/markdown.js");
    const host = document.createElement("div");
    host.className = "txt";
    host.innerHTML = text(markdown);
    document.body.append(host);
    const code = host.querySelector("pre")?.closest(".code-block") ?? host.querySelector("pre")?.parentElement;
    return {
      headings: [...host.querySelectorAll("h1,h2,h3")].map((n) => n.textContent),
      listItems: [...host.querySelectorAll("ul li")].map((n) => n.textContent),
      ordered: host.querySelectorAll("ol li").length,
      tableHeads: [...host.querySelectorAll("table th")].map((n) => n.textContent),
      tableCells: host.querySelectorAll("table td").length,
      link: host.querySelector("a")?.getAttribute("href") ?? null,
      linkTarget: host.querySelector("a")?.getAttribute("target") ?? null,
      inlineCode: [...host.querySelectorAll("p code")].map((n) => n.textContent),
      language: code?.querySelector(".code-language")?.textContent ?? null,
      copyLabel: code?.querySelector(".code-copy, button")?.textContent ?? null,
      codeText: code?.querySelector("pre code")?.textContent ?? null,
      quote: host.querySelector("blockquote")?.textContent ?? null,
      /* Nothing in the source may have become a real element or a live handler. */
      scripts: host.querySelectorAll("script").length,
      images: host.querySelectorAll("img").length,
      rawTextHasTag: host.textContent.includes("<script>"),
      javascriptLinks: [...host.querySelectorAll("a")].filter((a) => a.href.startsWith("javascript:")).length,
    };
  }, source);
  assert.equal(shape.scripts, 0, "a script tag in the source is never a script tag on the page");
  assert.equal(shape.images, 0, "an onerror image in the source is never an image on the page");
  assert.equal(shape.javascriptLinks, 0, "a javascript: link is never followable");
  assert.ok(shape.rawTextHasTag, "the tag survives as visible text, which is the point");
  assert.deepEqual(shape.listItems, ["a plain bullet", "a bullet with bold inside", "a bullet with code inside"]);
  assert.equal(shape.ordered, 2, "the numbered list rendered");
  assert.ok(shape.inlineCode.includes("branch start"), "inline code became a code element");
  assert.match(shape.codeText, /const answer = 42;/);
  assert.deepEqual(shape.headings, ["A sample document", "What it covers", "One more level"]);
  assert.deepEqual(shape.listItems, ["a plain bullet", "a bullet with bold inside", "a bullet with code inside"]);
  assert.equal(shape.ordered, 2, "the numbered list rendered");
  assert.deepEqual(shape.tableHeads, ["Thing", "What it does"]);
  assert.equal(shape.tableCells, 4);
  assert.equal(shape.link, "https://example.com/docs");
  assert.equal(shape.linkTarget, "_blank", "links open outside the app");
  assert.ok(shape.inlineCode.includes("branch start"), "inline code became a code element");
  assert.match(shape.codeText, /const answer = 42;/);
  assert.match(shape.quote, /quoted line/);
  assert.equal(shape.scripts, 0, "a script tag in the source is never a script tag on the page");
  assert.equal(shape.images, 0, "an onerror image in the source is never an image on the page");
  assert.equal(shape.javascriptLinks, 0, "a javascript: link is never followable");
  assert.ok(shape.rawTextHasTag, "the tag survives as visible text, which is the point");
  assert.deepEqual(errors, []);
});

test("U1 a reply written in markdown is rendered in the conversation, not shown raw", async (t) => {
  const { page, errors } = await fixture(t, {
    name: "scripted",
    async complete() { return { content: "# Heading\n\nSome **bold** words.\n\n```js\nlet x = 1;\n```", toolCalls: [] }; },
  });
  await settle(page);
  await page.locator("#prompt").fill("Say something in markdown.");
  await page.locator("#send").click();
  await page.locator("#conversation > .b .txt").waitFor({ timeout: 30000 });
  assert.equal(await page.locator("#conversation > .b .txt strong").innerText(), "bold");
  assert.match(await page.locator("#conversation > .b .txt pre").innerText(), /let x = 1;/);
  assert.doesNotMatch(await page.locator("#conversation > .b .txt").innerText(), /```/, "the fence is not shown raw");
  assert.equal(await page.locator("#conversation > .b .txt h1").innerText({ timeout: 5000 }), "Heading", "a heading is not shown raw");
  assert.deepEqual(errors, []);
});

test("U1 a saved note keeps its inline formatting and still cannot carry markup", async (t) => {
  const { app, page, errors } = await fixture(t);
  await settle(page);
  /* Redesign: replaced by the new window (typing a note into Library › Memory; in the design a Trunk suggests what to
     remember and the person keeps it). The note is kept through the engine, and Library › Memory draws it. */
  app.store.save("memory", "local", "web-ui-note", { text: "Prefer **short** answers and `npm start`, never <script>alert(1)</script>." });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator('#side [data-act="view"][data-v="library"]').click();
  await page.locator('#main [data-act="ptab"][data-place="library"][data-v="memory"]').click();
  const card = page.locator("#main .prow").filter({ hasText: "answers" }).first();
  await card.waitFor({ timeout: 10000 });
  assert.equal(await card.locator("strong").innerText(), "short", "bold became a real element");
  assert.equal(await card.locator("code").innerText(), "npm start", "inline code became a real element");
  assert.equal(await card.locator("script").count(), 0, "a script tag in a saved note is never a script tag");
  assert.match(await card.innerText(), /<script>/, "it survives as visible text instead");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (inspect: "Look inside the last reply" in the conversation's More menu, chatmenu), checked at
// ef021c57; a reply's own Look inside is not drawn.
test.skip("U2 Look inside shows a scripted task's tool rows and saves as JSON", async (t) => {
  let asked = 0;
  const { app, page, errors } = await fixture(t, {
    name: "scripted",
    async complete() {
      asked += 1;
      return asked === 1
        ? { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hello" }) }] }
        : { content: "Written.", toolCalls: [] };
    },
  });
  await settle(page);
  await page.locator("#prompt").fill("Write a note.");
  await page.locator("#send").click();
  await page.locator(".message.assistant").waitFor({ timeout: 30000 });
  /* The route answers whatever the panel will draw, so check it directly as well as on screen. */
  const runId = app.store.runs(app.runtime.owner).at(0).id;
  await openPlace(page, "runs");
  await page.locator("#runs-list").getByRole("button", { name: "Look inside" }).first().click();
  await page.locator("#inspect-panel").waitFor({ state: "visible" });
  await page.locator(".inspect-call").first().waitFor();
  const names = await page.locator(".inspect-call summary strong").allInnerTexts();
  assert.ok(names.includes("files.write"), `the tool it used is listed: ${names.join(", ")}`);
  const headings = await page.locator(".inspect-section h3").evaluateAll((nodes) => nodes.map((n) => n.textContent));
  for (const heading of ["Times it asked the model", "Tools it used", "Step by step"])
    assert.ok(headings.includes(heading), `${heading} is one of the sections`);
  /* The round rows must carry real numbers, not just the model's name and a duration. */
  const roundLine = await page.locator(".inspect-section").filter({ hasText: /Times it asked the model/i }).locator(".inspect-row .meta").first().innerText();
  assert.match(roundLine, /\d[\d,]*\s+words of prompt/, `the prompt size is shown: ${roundLine}`);
  assert.match(roundLine, /\d[\d,]*\s+in, \d[\d,]*\s+out/, `the tokens are shown: ${roundLine}`);
  assert.match(roundLine, /counted by the provider|our own estimate/, `where the numbers came from is said: ${roundLine}`);
  /* Opening a tool row must show what it was actually given and what actually came back. */
  const call = page.locator(".inspect-call").filter({ has: page.locator("summary strong", { hasText: "files.write" }) }).first();
  await call.locator("summary").click();
  const opened = await call.innerText();
  assert.match(opened, /note\.txt/, `the arguments it was given are shown: ${opened}`);
  assert.match(opened, /GIVEN|Given/, "the input is labelled");
  assert.match(opened, /CAME BACK|Came back/, "the output is labelled");
  /* And the same numbers have to be in the saved file, not only on the screen. */
  const view = await page.evaluate(async (id) =>
    (await fetch(`/api/runs/${id}/inspect`, { headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token") } })).json(), runId);
  assert.ok(view.rounds.length >= 1, "the answer carries the model rounds");
  assert.ok(view.rounds.every((r) => typeof r.tokens.input === "number" && r.promptTokens !== null), `every round is counted: ${JSON.stringify(view.rounds)}`);
  assert.ok(view.rounds.every((r) => r.cost && "display" in r.cost), "every round is priced, or says there is no price");
  const written = view.calls.find((c) => c.name === "files.write");
  assert.ok(written?.input?.includes("note.txt"), `the call's input is kept: ${written?.input}`);
  assert.ok(written?.output, "the call's output is kept");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save this as a file" }).click();
  const saved = await download;
  assert.match(saved.suggestedFilename(), new RegExp(`branch-task-${runId}\\.json`));
  await page.getByRole("button", { name: "Close", exact: true }).click();
  assert.ok(await page.locator("#inspect-panel").isHidden());
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window ("Ask it to wait", "Tell it to carry on" and telling a working task something
// from its live row are not in the design; Stop in Send's place is checked in calm-ui "a running task reads under its message").
test.skip("U3 the live row appears during a slow task and Stop cancels it", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { page, errors } = await fixture(t, {
    name: "scripted",
    async complete(_request, options) {
      /* Hold the first answer open long enough to see the row and press Stop. */
      await Promise.race([held, new Promise((r) => setTimeout(r, 15000))]);
      options?.signal?.throwIfAborted?.();
      return { content: "Finished.", toolCalls: [] };
    },
  });
  await settle(page);
  await page.locator("#prompt").fill("Take your time.");
  await page.locator("#send").click();
  await page.locator("#live-row").waitFor({ state: "visible" });
  await page.locator("#live-stop").waitFor();
  assert.match(await page.locator("#live-line").innerText(), /s so far|Working/);
  for (const id of ["live-pause", "live-steer", "live-stop"])
    assert.ok(await page.locator("#" + id).isVisible(), `${id} is offered`);
  /* Asking it to wait and telling it to carry on are both notes to a working task, and both must
     come back without an error; neither may touch the resume route, which refuses a running task. */
  await page.locator("#live-pause").click();
  await page.locator("#live-status").filter({ hasText: /Told to wait/ }).waitFor();
  assert.equal(await page.locator("#live-pause").innerText(), "Tell it to carry on");
  await page.locator("#live-pause").click();
  await page.locator("#live-status").filter({ hasText: /picks up where it left off/ }).waitFor();
  assert.equal(await page.locator("#live-pause").innerText(), "Ask it to wait");
  /* Telling it something mid-task lands on the steer route too. */
  await page.locator("#live-steer").click();
  await page.locator("#live-steer-text").fill("Keep it short.");
  await page.locator("#live-steer-send").click();
  await page.locator("#live-status").filter({ hasText: /take that into account/ }).waitFor();
  await page.locator("#live-stop").click();
  await page.locator("#live-status").filter({ hasText: "Stopped." }).waitFor();
  release();
  await page.waitForTimeout(500);
  assert.deepEqual(errors, []);
});

/* Redesign: the new card's own verb allows once; the answer is checked where it lands (the write happens). */
test("U3 an approval question appears in the conversation and the answer reaches the policy route (the new window)", async (t) => {
  let asked = 0;
  const { app, page, errors } = await fixture(t, {
    name: "scripted",
    async complete() {
      asked += 1;
      return asked === 1
        ? { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: "gated.txt", content: "x" }) }] }
        : asked === 2 ? { content: "", toolCalls: [{ id: "c2", name: "files.write", arguments: JSON.stringify({ path: "gated.txt", content: "x" }) }] }
        : { content: "Done.", toolCalls: [] };
    },
  });
  await page.evaluate(async (token) => {
    await fetch("/api/policy", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ preset: "ask-before-changes" }) });
  }, await page.evaluate(() => sessionStorage.getItem("branch-token")));
  await page.locator("#prompt").fill("Write a gated file.");
  await page.locator("#send").click();
  await page.locator("#live-ask").waitFor({ state: "visible", timeout: 20000 });
  assert.match(await page.locator("#live-ask").innerText(), /gated\.txt/, "the card says what it is about");
  const approved = page.waitForRequest((request) => request.url().endsWith("/api/policy/approve"));
  await page.locator("#live-ask .btn.pri").click();
  assert.equal((await approved).postDataJSON().decision, "allow", "the answer reached the policy route");
  for (let i = 0; i < 100 && !(await app.registry.execute("files.list", { path: "." }, app.runtime.context()).then((r) => JSON.stringify(r).includes("gated.txt"), () => false)); i++)
    await page.waitForTimeout(100);
  assert.ok(JSON.stringify(await app.registry.execute("files.list", { path: "." }, app.runtime.context())).includes("gated.txt"), "the yes let the write happen");
  assert.equal(await page.locator("#live-ask").count(), 0, "the card is gone once answered");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (ask-always, "Always allow"), checked at ef021c57; "Yes, just now", "Yes, for this conversation"
// and "Before I go ahead" are replaced by the new card (the action's verb, Always allow, Don’t allow).
test.skip("U3 an approval question appears in the conversation and the answer reaches the policy route", async (t) => {
  let asked = 0;
  const { app, page, errors } = await fixture(t, {
    name: "scripted",
    async complete() {
      asked += 1;
      return asked === 1
        ? { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: "gated.txt", content: "x" }) }] }
        : { content: "Done.", toolCalls: [] };
    },
  });
  /* Ask before anything that changes something, so the write below has to stop and ask. */
  await page.evaluate(async (token) => {
    await fetch("/api/policy", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ preset: "ask-before-changes" }) });
  }, await page.evaluate(() => sessionStorage.getItem("branch-token")));
  await settle(page);
  await page.locator("#prompt").fill("Write a gated file.");
  await page.locator("#send").click();
  await page.locator("#live-ask").waitFor({ state: "visible", timeout: 20000 });
  assert.match(await page.locator("#live-ask p").innerText(), /Before I go ahead/);
  for (const label of ["Yes, just now", "Yes, for this conversation", "Yes, always", "No"])
    assert.ok(await page.locator("#live-ask").getByRole("button", { name: label, exact: true }).isVisible(), `${label} is offered`);
  await page.locator("#live-ask").getByRole("button", { name: "Yes, always", exact: true }).click();
  await page.locator("#live-ask .meta").waitFor();
  /* "Always" is written into the policy, which is how we know the answer reached the route. */
  const rules = app.store.get("settings", app.runtime.owner, "policy")?.data?.rules ?? [];
  assert.ok(rules.some((rule) => rule.tool === "files.write" && rule.decision === "allow"), `the yes was remembered: ${JSON.stringify(rules)}`);
  assert.deepEqual(errors, []);
});

test("U4 the context chip and the cost under the box fill in after a task (DG-101)", async (t) => {
  const { page, errors } = await fixture(t, {
    name: "scripted",
    async complete() { return { content: "A short answer.", toolCalls: [] }; },
  });
  await settle(page);
  await page.locator("#prompt").fill("Hello there.");
  await page.locator("#send").click();
  await page.locator("#conversation > .b .txt").waitFor({ timeout: 30000 });
  /* Redesign: the context meter is the status bar's "Room left" (prototype data-act="roommenu"), and the conversation's
     cost is the prototype's .cost15 ("What this conversation has cost so far"). */
  await page.waitForFunction(() => /Room left/.test(document.querySelector('#statusbar [data-act="roommenu"]')?.textContent ?? ""), null, { timeout: 10000 });
  assert.equal(await page.locator("#meter-row").count(), 0, "the old meter bar is gone");
  assert.match(await page.evaluate(() => document.querySelector(".cost15")?.textContent ?? ""), /\$|^$/, "a price shows only when one is known");
  assert.deepEqual(errors, []);
});

test("U5 the playground runs a read-only tool and shows what came back", async (t) => {
  const { page, errors } = await fixture(t);
  await settle(page);
  /* Redesign: the Playground is a row on Settings › Developer ("Try any tool through a form.", Open), shown at Technical.
     Settings' search filters page names only, so the page is opened directly. */
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setlevel"][data-v="technical"]').click();
  await page.locator('[data-act="setpage"][data-v="developer"]').click();
  await page.locator("#main").getByRole("button", { name: "Open", exact: true }).first().click({ timeout: 10000 });
  await page.waitForFunction(() => (document.getElementById("play-tool")?.options.length ?? 0) > 1);
  // The playground (claude/unhold-control): its button reads "Run <tool>" as in the prototype.
  await page.locator("#play-tool").selectOption("files.write");
  await page.locator("#play-field-path").fill("playground.txt");
  await page.locator("#play-field-content").fill("written by hand");
  await page.getByRole("button", { name: /^Run / }).first().click();
  await page.locator("#play-result .code-block").waitFor();
  assert.match(await page.locator("#play-result .code-body").innerText(), /playground\.txt/);
  await page.locator("#play-tool").selectOption("files.read");
  await page.locator("#play-field-path").fill("playground.txt");
  await page.getByRole("button", { name: /^Run / }).first().click();
  await page.locator("#play-result .code-block").waitFor();
  assert.match(await page.locator("#play-result .code-body").innerText(), /written by hand/);
  assert.deepEqual(errors, []);
});

test("U5 a tool the settings say to ask about stops and asks before it runs", async (t) => {
  const { app, page } = await fixture(t);
  await page.evaluate(async (token) => {
    await fetch("/api/policy", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ preset: "ask-before-changes" }) });
  }, await page.evaluate(() => sessionStorage.getItem("branch-token")));
  await settle(page);
  /* Redesign: the Playground is a row on Settings › Developer ("Try any tool through a form.", Open), shown at Technical.
     Settings' search filters page names only, so the page is opened directly. */
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setlevel"][data-v="technical"]').click();
  await page.locator('[data-act="setpage"][data-v="developer"]').click();
  await page.locator("#main").getByRole("button", { name: "Open", exact: true }).first().click({ timeout: 10000 });
  await page.waitForFunction(() => (document.getElementById("play-tool")?.options.length ?? 0) > 1);
  await page.locator("#play-tool").selectOption("files.write");
  await page.locator("#play-field-path").fill("asked.txt");
  await page.locator("#play-field-content").fill("only after a yes");
  await page.getByRole("button", { name: /^Run / }).first().click();
  await page.locator("#play-confirm").waitFor();
  // The engine's own question, as the prototype words it: "Before I go ahead: run X on Y. Is that all right?"
  assert.match(await page.locator("#play-result").innerText(), /Before I go ahead/);
  const before = await app.registry.execute("files.list", { path: "." }, app.runtime.context()).catch(() => ({ entries: [] }));
  assert.ok(!JSON.stringify(before).includes("asked.txt"), "nothing was written before the yes");
  await page.locator("#play-confirm").click();
  await page.locator("#play-result .code-block").waitFor();
  assert.match(await page.locator("#play-result .code-body").innerText(), /asked\.txt/);
});

test("U6 the installable-app files are served and the worker is skipped inside the desktop app", async (t) => {
  const { page, server, browser } = await fixture(t);
  for (const [path, type] of [
    ["/manifest.webmanifest", /application\/manifest\+json/],
    ["/service-worker.js", /text\/javascript/],
    ["/assets/icon-192.png", /image\/png/],
    ["/assets/icon-512.png", /image\/png/],
    ["/assets/icon-maskable-512.png", /image\/png/],
    ["/assets/favicon-16.png", /image\/png/],
    ["/assets/favicon-32.png", /image\/png/],
    ["/assets/apple-touch-icon.png", /image\/png/],
  ]) {
    const response = await fetch(server.url + path, { headers: { origin: server.url } });
    assert.equal(response.status, 200, `${path} is served`);
    assert.match(response.headers.get("content-type") ?? "", type, `${path} is served as the right kind of file`);
  }
  const manifest = await (await fetch(server.url + "/manifest.webmanifest", { headers: { origin: server.url } })).json();
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.icons.length, 3);
  /* Redesign: replaced by the new window (the page registering a worker in a browser was the old window's app.js; the
     design has no installable-app step). What stays: the files are served, and the desktop page never registers one. */
  const desktopPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => desktopPage.close());
  const workerRequests = [];
  desktopPage.on("request", (request) => { if (request.url().endsWith("/service-worker.js")) workerRequests.push(request.url()); });
  await desktopPage.goto(server.url + "/?desktop=1");
  await desktopPage.getByLabel("Session token", { exact: true }).fill(server.token);
  await desktopPage.getByRole("button", { name: "Connect", exact: true }).click();
  await desktopPage.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await desktopPage.waitForTimeout(600);
  const scope = new URL(server.url).origin + "/";
  /* Sharing an origin means the earlier page's worker is visible here too, so what proves the skip
     is that this page never asked for the file, and never offers to install itself. */
  assert.deepEqual(workerRequests, [], "the desktop app never registers a worker of its own");
  assert.equal(await desktopPage.locator("#install-app").count(), 0, "the desktop app never offers to install itself");
  assert.ok(scope.endsWith("/"));
});

test("U6 the offline banner says plainly that nothing new can happen", async (t) => {
  const { page } = await fixture(t);
  await settle(page);
  /* Redesign: the status bar says "Connected" or "Not connected" (prototype has no offline banner). */
  const status = page.locator('#statusbar [data-act="machines"]');
  assert.doesNotMatch(await status.innerText(), /Not connected/, "nothing is said while the computer answers");
  await page.context().setOffline(true);
  await page.evaluate(() => dispatchEvent(new Event("offline")));
  await page.waitForFunction(() => /Not connected/.test(document.querySelector('#statusbar [data-act="machines"]')?.textContent ?? ""), null, { timeout: 10000 });
  assert.doesNotMatch(await status.innerText(), /Connected/, "it no longer says Connected");
  await page.context().setOffline(false);
  await page.evaluate(() => dispatchEvent(new Event("online")));
  await page.waitForFunction(() => /Connected/.test(document.querySelector('#statusbar [data-act="machines"]')?.textContent ?? ""), null, { timeout: 10000 });
});

test("U6 the shell fits a 400 pixel window with the new rows on screen", async (t) => {
  const { page } = await fixture(t, {
    name: "scripted",
    async complete() { return { content: "Short.", toolCalls: [] }; },
  });
  await settle(page);
  await page.setViewportSize({ width: 400, height: 800 });
  await page.locator("#prompt").fill("Hello.");
  await page.locator("#send").click();
  await page.locator("#conversation > .b .txt").waitFor({ timeout: 30000 });
  // Redesign: replaced by the new window (the "Context used" chip under the box; the meter is in the status bar).
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no sideways scrolling at 400 px (overflow ${overflow})`);
});

// Redesign: Coming soon (the Language select, sw:lang in Settings › Appearance), checked at ef021c57.
test.skip("U7 switching the language changes a visible label and English stays the fallback", async (t) => {
  const { page, server, errors } = await fixture(t);
  for (const path of ["/locales/en.json", "/locales/fr.json"]) {
    const response = await fetch(server.url + path, { headers: { origin: server.url } });
    assert.equal(response.status, 200, `${path} is served`);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  }
  const [english, french] = await Promise.all(
    ["/locales/en.json", "/locales/fr.json"].map((p) => fetch(server.url + p, { headers: { origin: server.url } }).then((r) => r.json())),
  );
  const missing = Object.keys(english).filter((key) => !(key in french));
  assert.deepEqual(missing, [], "the second language answers every key English does");
  await settle(page);
  assert.equal(await page.locator('[data-view="memory"]').innerText(), "Memory");
  await openSettingFor(page, "#appearance-language");
  await page.locator("#appearance-language").selectOption("fr");
  await page.waitForFunction(() => document.getElementById("appearance-language").value === "fr" && document.documentElement.lang === "fr");
  assert.equal(await page.locator('[data-view="memory"]').innerText(), "Mémoire");
  assert.equal(await page.locator('.lx-place-link[data-place="library"]').innerText(), "Bibliothèque");
  assert.equal(await page.locator('.lx-settings-link[data-page="data"]').innerText(), "Données et consommation");
  /* A key with no French on file falls back to English rather than showing a blank. */
  const fallback = await page.evaluate(async () => {
    const { t } = await import("/i18n.js");
    return t("nav.chat");
  });
  assert.equal(fallback, "Conversation");
  await page.locator("#appearance-language").selectOption("en");
  await page.waitForFunction(() => document.documentElement.lang === "en");
  assert.equal(await page.locator('[data-view="memory"]').innerText(), "Memory");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (the Language select, sw:lang in Settings › Appearance), checked at ef021c57; /i18n.js is the
// old window's module.
test.skip("U7 dates and numbers follow the chosen language", async (t) => {
  const { page } = await fixture(t);
  const shown = await page.evaluate(async () => {
    const { formatNumber, formatDate, setLanguage } = await import("/i18n.js");
    await setLanguage("fr");
    const french = { number: formatNumber(1234567), date: formatDate("2026-03-04T09:05:00Z", { dateStyle: "long" }) };
    await setLanguage("en");
    return { french, english: { number: formatNumber(1234567), date: formatDate("2026-03-04T09:05:00Z", { dateStyle: "long" }) } };
  });
  assert.notEqual(shown.french.number, shown.english.number, "1234567 is not written the same way in both");
  assert.notEqual(shown.french.date, shown.english.date, "the date is not written the same way in both");
});

/* ==================== Wave 8: the design QA pass ====================
   Q2 a colour is written down in exactly one file; Q6 every section intro and card title has a key,
   and every language file answers it. These read the source, so they need no browser. */

const PUBLIC = join(import.meta.dirname, "..", "public");

// Redesign: replaced by the new window (its colours are the tokens on :root in public/app.css, design doc 2; the other
// public/*.css files are the old window's).
test.skip("Q2 no stylesheet but the token layer writes a colour down", async (t) => {
  const sheets = (await readdir(PUBLIC)).filter((name) => name.endsWith(".css") && name !== "tokens.css");
  assert.ok(sheets.length >= 3, "the stylesheets moved; this test is looking in the wrong place");
  const offenders = [];
  for (const name of sheets) {
    const text = await readFile(join(PUBLIC, name), "utf8");
    text.split("\n").forEach((line, index) => {
      /* A comment may name a colour; a rule may not. */
      const rule = line.replace(/\/\*.*?\*\//g, "").split("/*")[0];
      if (/#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/.test(rule))
        offenders.push(`${name}:${index + 1} ${rule.trim().slice(0, 70)}`);
    });
  }
  assert.deepEqual(offenders, [], "every colour belongs in public/tokens.css");
});

// Redesign: replaced by the new window (the new public/index.html carries no data-t keys; its words are the design's).
test.skip("Q6 the page never shows a key where a word should be", async (t) => {
  const html = await readFile(join(PUBLIC, "index.html"), "utf8");
  const english = JSON.parse(await readFile(join(PUBLIC, "locales", "en.json"), "utf8"));
  const keys = [...new Set([...html.matchAll(/data-t(?:-label|-placeholder|-title)?="([^"]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 60, "the markup carries fewer keys than the sections need");
  assert.deepEqual(keys.filter((key) => !(key in english)), [], "a key in the markup has no English words");

  /* Every other language answers the same keys, so nothing falls through to a raw key. */
  for (const file of (await readdir(join(PUBLIC, "locales"))).filter((n) => n !== "en.json")) {
    const other = JSON.parse(await readFile(join(PUBLIC, "locales", file), "utf8"));
    const missing = Object.keys(english).filter((key) => !(key in other));
    assert.deepEqual(missing, [], `${file} does not answer every key English does`);
  }
});

test("Q6 each of the ten sections has its own words on file", async (t) => {
  const english = JSON.parse(await readFile(join(PUBLIC, "locales", "en.json"), "utf8"));
  for (const view of ["runs", "usage", "memory", "skills", "specialists", "procedures", "schedules", "documents", "settings"]) {
    const mine = Object.keys(english).filter((key) => key.startsWith(`${view}.`));
    assert.ok(mine.length > 0, `${view} has no words of its own behind a key`);
  }
});

/* Wave 8: the coverage test is tightened. It used to ask only that every key in the markup had
   English words; now it asks the other way round — that no button, field label or tick box on the
   page says anything that is not behind a key, so switching the language leaves nothing in English. */
// Redesign: replaced by the new window (the new public/index.html carries no data-t keys; its words are the design's).
test.skip("Q6 every button and field label on the page says its words through a key", async (t) => {
  const html = await readFile(join(PUBLIC, "index.html"), "utf8");
  const nameless = [];
  /* A button or label whose whole content is plain words must carry the key for those words. */
  for (const [whole, attributes, text] of html.matchAll(/<(?:button|label)\b([^>]*)>([^<]{1,200})<\/(?:button|label)>/g))
    if (!/\bdata-t[=\s]/.test(attributes) && text.trim()) nameless.push(text.trim().slice(0, 60));
  /* A tick box carries its words after the input; they belong in a span with a key of their own. */
  for (const [, attributes, , text] of html.matchAll(/<label\b([^>]*)>(<input[^>]*?\/?>)\s*([^<]{2,200})<\/label>/g))
    if (!/\bdata-t[=\s]/.test(attributes) && text?.trim()) nameless.push(text.trim().slice(0, 60));
  assert.deepEqual(nameless, [], "these controls still say their words in English only");

  const english = JSON.parse(await readFile(join(PUBLIC, "locales", "en.json"), "utf8"));
  assert.ok(Object.keys(english).filter((key) => key.startsWith("action.")).length > 80,
    "the buttons on the page are not all behind keys");
  assert.ok(Object.keys(english).filter((key) => key.startsWith("field.")).length > 80,
    "the field labels on the page are not all behind keys");
});

/* Words that are genuinely the same in both languages — proper names, and words French borrowed
   whole. Anything else left in English is a translation that was never written. */
const SHARED_WITH_FRENCH = new Set([
  "Assistant", "Standard", "Conversation", "Conversations", "Documents", "Messages", "Gemini", "Secrets", "Diagnostics",
  // The password managers are called what their makers call them, in either language.
  "1Password", "Bitwarden", "Trunks",
  // What each chat service and theme family is called by its maker, in either language (Settings' channel list, the theme filters).
  "Branch", "KeepOak", "IRC", "Gotify", "iMessage", "Microsoft Teams (bot)", "Webex", "Synology Chat", "Flock", "Pumble",
  "Mastodon", "Bluesky", "Reddit", "Discourse", "Twist", "Nextcloud Talk", "ntfy", "Pushover", "Threema Gateway",
  "Home Assistant", "XMPP (Jabber)", "MQTT", "Keybase", "SimpleX Chat", "Delta Chat", "Nostr", "VK", "Guilded", "Revolt",
  "Mumble", "KOOK",
  // phase2/delight: the near-impossible achievements' rank is written the same way in French.
  "SSS+",
  // bugfix-10 proposal: the same word in French (animals, borrowed or identical words, abbreviations, names, a command).
  "Pangolin", "Quokka", "{count} messages", "Branches", "{n} min", "Document", "Position", "CLI", "Version {n}",
  "version {cur} → {v}", "version {version}", "Hooks", "Trunk", "Local", "Version {value}",
  "{documents} documents · {chunks} passages", "Version", "Agents", "Animation", "Code", "Budgets", "GitLab", "git status",
  "Isolation", "2 min", "3 min", "Guide",
  // The p17d time choices and a length in milliseconds are spelt the same in French; Teams and webhook are borrowed whole.
  "1 minute", "3 minutes", "10 minutes", "{ms} ms", "Microsoft Teams (webhook)",
]);
test("Q6 French is a real translation, not the English file under another name", async (t) => {
  const english = JSON.parse(await readFile(join(PUBLIC, "locales", "en.json"), "utf8"));
  const french = JSON.parse(await readFile(join(PUBLIC, "locales", "fr.json"), "utf8"));
  // A string that is only a place for words said elsewhere ("{message}") has nothing to translate.
  const wordless = (text) => !/\p{L}/u.test(text.replace(/\{[^}]+\}/g, ""));
  const copied = Object.keys(english).filter((key) =>
    french[key] === english[key] && !SHARED_WITH_FRENCH.has(english[key]) && !wordless(english[key]));
  assert.deepEqual(copied, [], "these keys still answer in English when French is chosen");
  assert.ok(Object.keys(french).length >= Object.keys(english).length, "French answers every key");
});
