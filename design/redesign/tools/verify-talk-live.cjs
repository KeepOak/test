/* Talk live in the new window (chat/talklive.js), proved on a FRESH in-process engine (its own temp folder, a free port)
   with a stand-in live service, in headless Chromium with fake media only:
     node design/redesign/tools/verify-talk-live.cjs
   Chromium runs with --use-fake-device-for-media-stream and --use-fake-ui-for-media-stream, so the "microphone" is
   Chromium's own generated tone and no real microphone is ever opened. The stand-in speaks the OpenAI realtime words
   the engine uses (src/realtime-openai.ts) on 127.0.0.1; nothing reaches the internet.
   Checks: nothing starts without the press (no task, no socket, no microphone, no sound sent); a press on a connection
   that cannot talk live shows the engine's own words and makes nothing; a press opens the task's socket and the states
   go starting → listening, with sound going up; Mute holds the sound back; the answer's sound turns it to speaking and
   back to listening; End stops it through the engine (the task ends "You ended the conversation."), lets go of the
   microphone and shows what was said in the conversation; the service closing ends it; a profile switch ends it; a
   socket that never opens stops the task it made. Page errors must be zero. Test data: a household person "Sam" made
   through the engine to switch to, in the temp folder, removed at the end. */
const { mkdtempSync, rmSync } = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(100); } }

/** A stand-in for OpenAI's realtime service: takes the engine's connection, counts the sound it is sent, answers on cue. */
async function standIn(ws) {
  const state = { clients: [], appends: 0, updates: 0 };
  const server = createServer((_q, r) => r.writeHead(404).end());
  server.on("upgrade", (request, socket) => {
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${ws.acceptKey(String(request.headers["sec-websocket-key"] ?? ""))}`, "", ""].join("\r\n"));
    state.clients.push(socket);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (let d = ws.readFrame(pending); d; d = ws.readFrame(pending)) {
        pending = pending.subarray(d.consumed);
        if (d.opcode === 0x8) { socket.end(Buffer.from([0x88, 0x00])); continue; }
        if (d.opcode !== 0x1) continue;
        const type = JSON.parse(d.payload.toString("utf8")).type;
        if (type === "input_audio_buffer.append") state.appends += 1;
        if (type === "session.update") state.updates += 1;
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const say = (value) => state.clients.at(-1)?.write(ws.frame(JSON.stringify(value)));
  return { state, say, server, endpoint: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  const dist = join(__dirname, "../../../dist/");
  const { createBranch } = await import(pathToFileURL(join(dist, "index.js")).href);
  const { startServer } = await import(pathToFileURL(join(dist, "server.js")).href);
  const ws = await import(pathToFileURL(join(dist, "ws.js")).href);
  const root = mkdtempSync(join(tmpdir(), "verify-talk-live-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const base = server.url.replace(/\/$/, "");
  const call = async (p, body) => {
    const r = await fetch(`${base}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
    return data;
  };
  const service = await standIn(ws);
  const liveTasks = () => app.store.sqlite.prepare("SELECT id FROM tasks WHERE prompt='A live conversation' ORDER BY rowid").all().map((row) => String(row.id));
  const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  /* Counted from before the page's first byte: every microphone asked for, every socket made, every state drawn. */
  await context.addInitScript(() => {
    window.__mic = 0; window.__streams = []; window.__sockets = []; window.__states = [];
    const media = navigator.mediaDevices, ask = media.getUserMedia.bind(media);
    media.getUserMedia = async (c) => { window.__mic += 1; const s = await ask(c); window.__streams.push(s); return s; };
    const Real = window.WebSocket;
    window.WebSocket = class extends Real { constructor(url, p) { super(url, p); window.__sockets.push(url); } };
    new MutationObserver(() => { const v = document.querySelector("#app > .voice")?.dataset.state ?? "none"; if (window.__states.at(-1) !== v) window.__states.push(v); })
      .observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const js = (fn) => page.evaluate(fn);
  const state = () => page.locator("#app > .voice").getAttribute("data-state", { timeout: 500 }).catch(() => "none");
  const toastText = () => page.locator(".toast").innerText({ timeout: 500 }).catch(() => "");
  const press = () => page.locator(".composer [data-act='voice']").click();
  try {
    await call("onboarding", { done: true });
    app.web.policy.configure({ allowPrivateAddresses: true });
    await page.goto(base + "/");
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#prompt").waitFor({ timeout: 60000 });
    await page.waitForTimeout(2500);

    /* 1. Nothing without the press. */
    check("1 on load: no live task, no socket, no microphone, no sound sent", liveTasks().length === 0 && (await js(() => window.__sockets.length)) === 0 && (await js(() => window.__mic)) === 0 && service.state.appends === 0);
    check("1 Talk live is drawn live in the composer", (await page.locator(".composer [data-act='voice']").getAttribute("aria-disabled")) === null);

    /* 2. A connection that cannot talk live: the engine's own words, nothing made. */
    const reason = (await call("voice/plan")).live.reason;
    await press();
    check("2 the engine's words are shown", (await until(async () => (await toastText()) === reason ? true : null, 5000)) === true, reason);
    check("2 no task, no socket, no microphone", liveTasks().length === 0 && (await js(() => window.__sockets.length)) === 0 && (await js(() => window.__mic)) === 0);

    /* 3. A connection that can: the press opens the socket, starting → listening, sound goes up. */
    app.runtime.models.register({ id: "live-openai", name: "live-openai", model: "live-model", catalogId: "openai",
      provider: { name: "openai", complete: async () => ({ content: "", toolCalls: [] }), audio: () => ({ endpoint: service.endpoint, apiKey: "sk-not-used" }) } });
    app.runtime.models.configure("local", { activePreset: "live-openai" });
    await js(() => { window.__states = []; });
    await press();
    await until(async () => (await state()) === "listening", 15000);
    const first = liveTasks()[0];
    const states = await js(() => window.__states);
    check("3 one press made one task and opened its socket", liveTasks().length === 1 && (await js(() => window.__sockets)).length === 1 && (await js(() => window.__sockets[0])).endsWith(`/api/runs/${first}/ws`));
    check("3 states: starting, then listening", states.indexOf("starting") >= 0 && states.indexOf("listening") > states.indexOf("starting"), states.join(" → "));
    check("3 the engine opened the service", service.state.updates === 1);
    check("3 the microphone opened once, after the press", (await js(() => window.__mic)) === 1);
    check("3 sound goes up as it is spoken", (await until(async () => service.state.appends > 3 ? service.state.appends : null, 8000)) > 3, `${service.state.appends} blocks`);
    check("3 the view shows the engine's plan", (await page.locator("#app > .voice .hint").innerText()).startsWith("A live conversation runs on"));

    /* 4. Mute holds the sound back on this computer; Unmute sends it again. */
    await page.locator("[data-act='v-mute']").click();
    await wait(600);
    const held = service.state.appends;
    await wait(1500);
    check("4 muted: no sound sent", service.state.appends === held, `${held} → ${service.state.appends}`);
    check("4 the button says Unmute", (await page.locator("[data-act='v-mute']").innerText()) === "Unmute");
    await page.locator("[data-act='v-mute']").click();
    check("4 unmuted: sound goes up again", (await until(async () => service.state.appends > held ? true : null, 5000)) === true);

    /* 5. The answer's sound: speaking, then listening again once it has played. */
    await js(() => { window.__states = []; });
    service.say({ type: "response.audio.delta", delta: Buffer.alloc(24000 * 2 * 0.6).toString("base64") });
    service.say({ type: "response.audio_transcript.done", transcript: "The stand-in answers." });
    check("5 speaking while the answer plays", (await until(async () => (await state()) === "speaking" ? true : null, 5000)) === true);
    check("5 what is said is shown", (await until(async () => (await page.locator("#v-cap").innerText()) === "The stand-in answers." ? true : null, 5000)) === true);
    check("5 listening again when it has played", (await until(async () => (await state()) === "listening" ? true : null, 8000)) === true, (await js(() => window.__states)).join(" → "));

    /* 6. End: the engine stops it, the microphone is let go, what was said is in the conversation. */
    await page.locator("[data-act='v-end']").click();
    check("6 the view is gone", (await until(async () => (await state()) === "none" ? true : null, 5000)) === true);
    check("6 the task ended as the person ended it", (await until(async () => app.store.run(first).status === "completed" && /You ended the conversation\.$/.test(app.store.run(first).output) ? true : null, 8000)) === true, app.store.run(first).output);
    check("6 the microphone is let go", await js(() => window.__streams.every((s) => s.getTracks().every((tr) => tr.readyState === "ended"))));
    check("6 the prototype's words", (await toastText()) === "Call ended. What was said is in the conversation.");
    check("6 what was said is in the conversation", (await until(async () => (await page.locator("#conversation").innerText()).includes("The stand-in answers.") ? true : null, 8000)) === true);
    check("6 Talk live can be pressed again", (await page.locator(".composer [data-act='voice']").getAttribute("aria-disabled")) === null);

    /* 7. The service closing ends it. */
    await press();
    await until(async () => (await state()) === "listening", 15000);
    const second = liveTasks().at(-1);
    service.state.clients.at(-1).destroy();
    check("7 the service closing ends the view", (await until(async () => (await state()) === "none" ? true : null, 10000)) === true);
    check("7 and its task", (await until(async () => app.store.run(second).status !== "running" ? true : null, 8000)) === true, app.store.run(second).status);

    /* 8. A profile switch ends it (the engine ends the socket; the window starts again as the new person). */
    await press();
    await until(async () => (await state()) === "listening", 15000);
    const third = liveTasks().at(-1);
    const person = await call("profiles", { name: "Sam", pin: "2468" });
    await call("profiles/switch", { profileId: person.id, pin: "2468" });
    check("8 the switch ends the task", (await until(async () => app.store.run(third).status !== "running" ? true : null, 10000)) === true, app.store.run(third).status);
    await page.waitForTimeout(3500);
    check("8 the view is gone and the microphone let go", (await state()) === "none" && (await js(() => window.__streams.every((s) => s.getTracks().every((tr) => tr.readyState === "ended")))));
    await call("profiles/switch", { profileId: null });

    /* 9. A socket that never opens stops the task it made. */
    const page2 = await context.newPage();
    page2.on("pageerror", (e) => errors.push(e.message));
    await page2.addInitScript(() => {
      window.WebSocket = class extends EventTarget { constructor() { super(); this.readyState = 0; setTimeout(() => { this.readyState = 3; this.dispatchEvent(new Event("error")); this.dispatchEvent(new Event("close")); }, 5); } send() { throw new Error("not open"); } close() { this.readyState = 3; } };
    });
    app.live.connectWaitMs = 10 * 60_000; // only the page can end it within this check
    await page2.goto(base + "/");
    await page2.getByLabel("Session token", { exact: true }).fill(server.token);
    await page2.getByRole("button", { name: "Connect", exact: true }).click();
    await page2.locator("#prompt").waitFor({ timeout: 60000 });
    await page2.waitForTimeout(1500);
    const before = liveTasks().length;
    await page2.locator(".composer [data-act='voice']").click();
    const fourth = await until(async () => liveTasks().length > before ? liveTasks().at(-1) : null, 5000);
    check("9 the task it made is stopped", (await until(async () => app.store.run(fourth)?.status === "cancelled" ? true : null, 5000)) === true && app.store.run(fourth).output === "Stopped before the live conversation connected.", app.store.run(fourth)?.output);
    check("9 the person is told why", (await page2.locator(".toast").innerText()) === "The live conversation could not connect, so it was stopped.");
    check("9 the view is gone and no microphone was asked for", (await page2.locator("#app > .voice").count()) === 0 && (await page2.evaluate(() => window.__mic)) === 0);

    check("page errors: zero", errors.length === 0, errors.join(" | "));
  } catch (error) {
    check("verify ran to the end", false, error.stack);
  } finally {
    await browser.close();
    await server.close();
    await app.close();
    for (const socket of service.state.clients) socket.destroy();
    await new Promise((done) => service.server.close(done));
    rmSync(root, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
