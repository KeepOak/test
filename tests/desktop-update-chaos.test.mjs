/* The owner's chaos test for updates (versioned app folders: src/desktop/app-folders.ts, shell-switch.ts,
   shell-window.ts). An install laid out as <root>/app-<version>/ with Electron's own stock program (hard links to it
   where the drive allows; never a program made here) runs hidden with the detached gateway on. Three updates switch
   the shell back to back while four kinds of work carry on:
   - a conversation in the window whose answer is streaming the whole time;
   - a task in the middle of using a tool;
   - a background helper task started outside the window;
   - a chat-app turn: a message from a chat service (Mattermost-style webhooks) through the gateway, answered back.
   Then a fourth, broken update never opens its window, and the version before comes back by itself and says why.
   Asserted: no dropped or doubled words or replies, no failed or restarted task or engine, the same gateway process
   throughout, a window back within seconds each time with the owner's draft in it, and no program made.

   Isolated: its own APPDATA, LOCALAPPDATA, USERPROFILE, TEMP and data folder, dynamic ports, hidden windows (the tray,
   never shown), no scheduler (the hand-over runner is started the way the hand-over's own fallback starts it), and every
   process it started is ended by its id or by a program path or command line inside its own temporary folder. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { connected, drawn, exe, files, inPage, inspector, listen, progress, sha256, stockDist, until, versionFolder, wait } from "./fixtures/versioned-install.mjs";
import { pointerFiles, pruneAppFolders, readPointer, writePointer } from "../dist/desktop/app-folders.js";
import { shellUpMarker, failureName } from "../dist/desktop/shell-switch.js";
import { launchHandOver } from "../dist/desktop/hand-over.js";
import { SwitchPlanSchema } from "../dist/desktop/version-switch.js";
import { storeMigrations } from "../dist/never-break/migrations.js";
import { proveOnce, sessionKey } from "../dist/engine-proof.js";

const tags = ["STREAM-A", "TOOL-B", "CHAT-C", "HELPER-D"];

/**
 * A model service that answers by the words it is asked about, so work running side by side is told apart:
 * STREAM-A streams numbered words for as long as it is held, then "END"; TOOL-B asks for a tool, then waits to be
 * let go; HELPER-D and CHAT-C wait to be let go. Anything else is answered at once.
 */
async function chaosModel(t) {
  const asked = [], held = new Set(), streamed = { words: 0 };
  let released = false; const wake = new Set();
  const letGo = () => { released = true; for (const one of wake) one(); wake.clear(); };
  const untilReleased = () => (released ? Promise.resolve() : new Promise((done) => wake.add(done)));
  const frame = (delta, finish) => `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const answer = (response, body, message, reason) => {
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = message.tool_calls ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : { role: "assistant", content: message.content };
      response.end(frame(delta, null) + frame({}, reason) + "data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "r", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: reason, message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  };
  const server = createServer((request, response) => {
    progress(`model: ${request.method} ${request.url} arrived`);
    let raw = ""; request.on("data", (chunk) => { raw += chunk; });
    request.on("end", async () => {
      if (request.url.endsWith("/models")) { response.end(JSON.stringify({ data: [{ id: "m" }] })); return; }
      const body = JSON.parse(raw || "{}"), messages = body.messages ?? [];
      const lastUser = [...messages].reverse().find((one) => one.role === "user");
      const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
      const tag = tags.find((one) => text.includes(one)) ?? "other";
      const afterTool = messages.some((one) => one.role === "tool");
      asked.push({ tag, afterTool });
      progress(`model: ${tag}${afterTool ? " after its tool" : ""} asked`);
      if (tag === "STREAM-A" && body.stream) {
        held.add(tag);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame({ role: "assistant", content: "" }, null));
        while (!released) { streamed.words++; response.write(frame({ content: `w${streamed.words} ` }, null)); await Promise.race([untilReleased(), wait(300)]); }
        response.end(frame({ content: "END" }, null) + frame({}, "stop") + "data: [DONE]\n\n");
        return;
      }
      if (tag === "TOOL-B" && !afterTool) {
        answer(response, body, { role: "assistant", content: null, tool_calls: [{ id: "call-b", type: "function", function: { name: "files.list", arguments: JSON.stringify({ path: "." }) } }] }, "tool_calls");
        return;
      }
      if (tag !== "other") { held.add(tag); await untilReleased(); }
      answer(response, body, { role: "assistant", content: tag === "other" ? "Hello there." : `${tag} done.` }, "stop");
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { letGo(); server.closeAllConnections(); server.close(() => done()); }));
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, asked, held, streamed, letGo };
}

/** A chat service: records every reply the assistant posts back to it. */
async function chatService(t) {
  const replies = [];
  const server = createServer((request, response) => {
    let raw = ""; request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => { try { replies.push(JSON.parse(raw)); } catch { replies.push({ raw }); } response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }));
  return { hook: `http://127.0.0.1:${server.address().port}/hooks/branch`, replies };
}

test("three updates back to back while a streaming answer, a tool task, a background helper and a chat-app turn all carry on; a broken fourth goes back by itself", {
  skip: process.platform !== "win32" ? "versioned app folders are Windows-only" : !stockDist() ? "set BRANCH_TEST_ELECTRON to an existing stock electron.exe" : false,
  timeout: 900_000,
}, async (t) => {
  const dist = stockDist(), stockHash = await sha256(join(dist, "electron.exe"));
  const home = await mkdtemp(join(tmpdir(), "branch-versioned-"));
  const root = join(home, "Programs", "Branch Agent"), userData = join(home, "Roaming", "Branch Agent"), dataDir = join(userData, "state");
  const temp = join(home, "Temp"), scratch = join(temp, "branch-agent-update");
  for (const dir of [root, dataDir, temp, join(home, "Local"), join(home, "User")]) await mkdir(dir, { recursive: true });
  await writeFile(join(dataDir, "gateway.json"), JSON.stringify({ mode: "on" }));
  await writeFile(join(userData, "window-state.json"), JSON.stringify({ maximized: false }));
  const model = await chaosModel(t), chat = await chatService(t);
  const chatSecret = "chaos-chat-token-0123456789";
  const integrations = join(home, "integrations.json");
  await writeFile(integrations, JSON.stringify({ web: { allowPrivateAddresses: true }, channels: [{ id: "mattermost", type: "chat", service: "mattermost",
    webhookUrlSecret: "CHAOS_CHAT_HOOK", secretSecret: "CHAOS_CHAT_SECRET", activation: "always", pairing: false, allowlist: ["user-9"] }] }));
  const started = new Set(), shells = [];
  const env = () => ({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, APPDATA: join(home, "Roaming"), LOCALAPPDATA: join(home, "Local"),
    USERPROFILE: join(home, "User"), TEMP: temp, TMP: temp, BRANCH_DESKTOP_HOME: userData, BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: join(home, "workspace"),
    BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: model.endpoint, BRANCH_MODEL: "m", BRANCH_API_KEY: "test-key",
    BRANCH_INTEGRATIONS: integrations, CHAOS_CHAT_HOOK: chat.hook, CHAOS_CHAT_SECRET: chatSecret });
  // A packaged app takes its inspector only on its command line (NODE_OPTIONS is refused), so the switch script is given it.
  const inspect = (port) => `--inspect=127.0.0.1:${port}`;
  // Inspector ports of this run only: a shell left by another run can never answer for one of these.
  const base = 20000 + Math.floor(Math.random() * 20000);
  t.after(async () => {
    for (const shell of shells) shell.close();
    const note = await readFile(join(dataDir, "running.json"), "utf8").then(JSON.parse, () => null);
    const token = await readFile(join(dataDir, "session-token"), "utf8").then((text) => text.trim(), () => null);
    const boot = note && token ? await proveOnce(note.url, token, 5000).catch(() => null) : null;
    if (boot) await fetch(`${note.url}/api/deployment/quit`, { method: "POST", headers: { authorization: `Bearer ${sessionKey(token, boot)}` }, signal: AbortSignal.timeout(15000) }).catch(() => undefined);
    // Only what this test started (by id), then its switch scripts (their command line names its folder) and anything
    // still running from inside its own temporary folder (by path). Scripts too: none may outlive its folder.
    for (const pid of started) { try { process.kill(pid); } catch { /* gone */ } }
    for (let pass = 0; pass < 6; pass++) await new Promise((done) => spawn(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command",
      "Start-Sleep -Milliseconds 700; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and (($_.CommandLine -and $_.CommandLine.Contains($env:BRANCH_TEST_HOME)) -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:BRANCH_TEST_HOME, [StringComparison]::OrdinalIgnoreCase))) } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }"],
    { env: { ...process.env, BRANCH_TEST_HOME: home }, windowsHide: true, stdio: "ignore" }).once("exit", done));
    progress("cleaned up");
    await wait(1000);
    if (!process.env.BRANCH_TEST_KEEP) await discardTemp(home, { tries: 40, pause: 250 });
  });

  progress(`start ${home}`);
  try { await body(); } catch (error) {
    progress(`FAILED: ${error.stack}`);
    progress(`switch log:\n${await readFile(join(scratch, "apply-update.log"), "utf8").catch(() => "(none)")}`);
    progress(`first shell log:\n${(await readFile(join(home, "shell-first.log"), "utf8").catch(() => "(none)")).split("\n").slice(-40).join("\n")}`);
    for (const port of [base + 1, base + 2, base + 3, base + 4])
      progress(`shell ${port} log:\n${(await readFile(join(home, `shell-${port}.log`), "utf8").catch(() => "(none)")).split("\n").slice(-40).join("\n")}`);
    throw error;
  }

  async function body() {
    const versions = ["0.99.1", "0.99.2", "0.99.3", "0.99.4", "0.99.5"];
    const folders = [await versionFolder(root, versions[0], { dist })];
    for (let at = 1; at < versions.length; at++) folders.push(await versionFolder(root, versions[at], { from: folders[at - 1], dist, broken: at === 4 }));
    await writePointer(root, { folder: `app-${versions[0]}`, version: versions[0], previous: null, at: new Date().toISOString() });

    // The first version, started as the tray start does: hidden, never shown.
    const output = openSync(join(home, "first-shell.log"), "a");
    const first = spawn(join(folders[0], exe), ["--start-minimized", inspect(base), "--enable-logging=file", `--log-file=${join(home, "shell-first.log")}`], { env: env(), detached: true, stdio: ["ignore", output, output], windowsHide: true });
    t.after(() => { try { closeSync(output); } catch { /* closed */ } });
    started.add(first.pid); first.unref();
    let shell = await inspector(base).catch(async (error) => { throw new Error(`${error.message}\n${await readFile(join(home, "first-shell.log"), "utf8").catch(() => "")}`); });
    shells.push(shell);
    progress("first shell inspector");
    assert.equal(await drawn(shell), false, "the window stays hidden: only its page is told it is in use");
    await connected(shell);
    progress("first shell connected");
    progress("turning updating off");
    // This test drives its own switches: the app's own update loop (a minute after start) must not look at GitHub.
    await inPage(shell, `await fetch("/api/comfort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ card: "notify", values: { autoUpdate: "off" } }) }).then((r) => { if (!r.ok) throw new Error("comfort " + r.status); });`);
    await inPage(shell, `for (const [path, body] of [["/api/onboarding", { done: true }], ["/api/conversation-mode/settings", { newConversation: "follow", confirmLoosening: true }]])
      await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); location.reload();`).catch(() => undefined);
    await drawn(shell);
    await connected(shell);
    progress("first shell onboarded");
    const running = JSON.parse(await readFile(join(dataDir, "running.json"), "utf8"));
    const health = async () => (await fetch(`${running.url}/gateway/health`, { signal: AbortSignal.timeout(5000) })).json();
    const { gateway: { pid: gateway }, worker: { pid: worker } } = await health();
    // The engine's own API, as a helper outside the window reaches it: through the gateway, with the proved key.
    const token = (await readFile(join(dataDir, "session-token"), "utf8")).trim();
    const engine = async (path, body, { ms = 15000 } = {}) => {
      const boot = await proveOnce(running.url, token, 5000);
      const response = await fetch(`${running.url}${path}`, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(ms),
        headers: { authorization: `Bearer ${sessionKey(token, boot)}`, origin: running.url, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
      return response.json();
    };
    const runsOf = async () => (await engine("/api/state")).runs;

    // A client of the gateway that keeps asking all the way through: none may fail.
    let asked = 0, failed = 0, asking = true;
    t.after(() => { asking = false; }); // a failure part way must not leave it asking for ever
    const client = (async () => { while (asking) { try { const r = await fetch(`${running.url}/gateway/health`, { signal: AbortSignal.timeout(5000) }); if (r.ok) asked++; else failed++; } catch { failed++; } await wait(200); } })();

    // ---- the four kinds of work, all started before the first update and all still going through the third ----
    const say = (words) => inPage(shell, `const box = document.getElementById("prompt"); box.value = ${JSON.stringify(words)}; box.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("send").click();`);
    // A first message waits for its conversation to be confirmed before a window hands over, so the conversation exists first.
    await say("Hello");
    await until("the first answer", async () => (await runsOf()).some((run) => run.prompt === "Hello" && run.status === "completed"));
    await until("the window to be ready", () => inPage(shell, `return !!document.querySelector("#prompt") && !document.getElementById("send")?.disabled;`));
    await say("STREAM-A: tell me a long story");
    // Each is one request that stays open until its task finishes: it is held across every switch too.
    const tool = engine("/api/run", { prompt: "TOOL-B: list the workspace and summarise it" }, { ms: 900_000 });
    const helper = engine("/api/run", { prompt: "HELPER-D: tidy the notes in the background" }, { ms: 900_000 });
    tool.catch(() => undefined); helper.catch(() => undefined);
    const { addresses } = await engine("/api/channels/addresses");
    const address = addresses.find((one) => one.channel === "mattermost")?.address;
    assert.ok(address, `the chat service's address is there: ${JSON.stringify(addresses)}`);
    // The chat service's post stays open while its turn works (a webhook's answer may go back on it), across every switch.
    const inbound = fetch(new URL(new URL(address, running.url).pathname, running.url), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: chatSecret, post_id: "p-chaos-1", channel_id: "c1", channel_name: "town-square", user_id: "user-9", user_name: "alice", text: "CHAT-C: what is on today?" }) });
    inbound.catch(() => undefined);
    await until("all four at work", async () => tags.every((tag) => model.held.has(tag)), 120_000);
    assert.ok(model.asked.some((one) => one.tag === "TOOL-B" && one.afterTool), "the tool task ran its tool and is working on the result");
    const wordsAtStart = model.streamed.words;
    progress("four kinds of work going");

    const switchTo = async (from, to, port) => {
      const draft = `a draft typed in ${from}`;
      await inPage(shell, `const box = document.getElementById("prompt"); box.value = ${JSON.stringify(draft)}; box.dispatchEvent(new Event("input", { bubbles: true }));`);
      const pid = await shell.evaluate("process.pid");
      // What main does at the switch (shell-window.ts handOverHook): the window is in the tray, so the moment is now.
      const handed = await shell.evaluate(`(async () => {
        const { BrowserWindow, powerMonitor, app } = require("electron");
        const hook = require(require("node:path").join(process.resourcesPath, "app", "dist", "desktop", "shell-window.js")).handOverHook;
        const window = BrowserWindow.getAllWindows().find((one) => one.webContents.getURL().includes("desktop=1"));
        return hook({ window: () => window, userData: app.getPath("userData"), power: powerMonitor })({ version: ${JSON.stringify(to)}, stillWanted: () => true });
      })()`);
      progress(`handed over ${from} -> ${to}`);
      // What the updater writes (updater.ts writeSwitchScript), and the hidden start the hand-over falls back to.
      const pointers = await pointerFiles(root, { folder: `app-${from}`, version: from }, { folder: `app-${to}`, version: to });
      await mkdir(scratch, { recursive: true });
      await writeFile(join(scratch, `${failureName}.draft`), JSON.stringify({ kept: from, tried: to, commit: null, at: new Date().toISOString(), message: `Version ${to} did not open its window, so Branch went back to ${from} by itself.` }));
      // The plan the updater writes (updater.ts writeSwitchScript), run by the hand-over runner (hand-over.ts) linked from
      // the running version's folder, started the way the hand-over starts it when the scheduler refuses: no script host.
      const script = join(scratch, `switch-${to}.json`);
      await writeFile(script, JSON.stringify(SwitchPlanSchema.parse({ root, next: pointers.next, rollback: pointers.rollback, newExe: join(root, `app-${to}`, exe), oldExe: join(root, `app-${from}`, exe),
        pid, marker: shellUpMarker(scratch, to), failureDraft: join(scratch, `${failureName}.draft`), failure: join(scratch, failureName), log: join(scratch, "apply-update.log"),
        minimized: true, upSeconds: 40, args: [inspect(port), "--enable-logging=file", `--log-file=${join(home, `shell-${port}.log`)}`],
        version: to, kept: from, commit: null, dataDir, understood: storeMigrations.at(-1).version })));
      await launchHandOver(script, pid, { platform: "win32", runtime: join(root, `app-${from}`), executableName: exe, env: env(),
        exec: (_file, _args, _options, callback) => callback(new Error("no scheduler in a test")) });
      started.add(pid);
      listeners.set(port, listen(port, `shell ${to}`));
      // Every process running the new version's program, every two seconds for a minute: when it starts, what it is.
      void (async () => {
        const end = Date.now() + 60_000;
        while (Date.now() < end) {
          const found = await new Promise((done) => {
            let out = "";
            const child = spawn(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command",
              "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:BRANCH_WATCH } | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.CreationDate.ToString('HH:mm:ss.fff'), (($_.CommandLine -split ' --')[1]) }"],
              { env: { ...process.env, BRANCH_WATCH: join(root, `app-${to}`, exe) }, windowsHide: true });
            child.stdout.on("data", (chunk) => { out += chunk; }); child.once("exit", () => done(out.trim()));
          });
          progress(`${to} processes: ${found.split(/\s*\n\s*/).join(" | ") || "none"}`);
          await wait(2000);
        }
      })();
      progress(`script started; asking ${from} to quit`);
      const asking = Date.now();
      // Asked while the inspectors are still on it, then they let go (a program whose inspector left first never ends).
      await shell.evaluate(`require("electron").app.quit(), "asked"`).catch(() => undefined);
      shell.close(); listeners.get(port - 1)?.close();
      // Out of sight at the hand-over (in the tray or minimised): the owner sees no gap, however long the switch takes.
      return { draft, asking, outOfSight: handed?.minimized === true };
    };

    // ---- three updates, back to back ----
    const gaps = [], listeners = new Map();
    let pendingChecks = 0;
    const seen = []; // how long the owner could see Branch with no window, per switch
    for (let at = 1; at <= 3; at++) {
      progress(`update ${at}`);
      const { draft, asking: from, outOfSight } = await switchTo(versions[at - 1], versions[at], base + at);
      const up = JSON.parse(await until(`${versions[at]}'s window`, () => readFile(shellUpMarker(scratch, versions[at]), "utf8"), 180_000, 250));
      gaps.push(Date.parse(up.at) - from);
      seen.push(outOfSight ? 0 : gaps.at(-1));
      started.add(up.pid);
      assert.equal(up.restored, true, "the new window put back what the old one had open before saying it was up");
      shell = await inspector(base + at); shells.push(shell);
      await drawn(shell);
      assert.equal(await shell.evaluate("require('electron').app.getVersion()"), versions[at]);
      assert.equal(await shell.evaluate("process.execPath"), join(folders[at], exe), "it runs from its own folder");
      const kept = await until("the draft", () => inPage(shell, `return document.getElementById("prompt")?.value || null;`));
      assert.equal(kept, draft, "the words the owner was typing are there");
      assert.equal((await readPointer(root))?.folder, `app-${versions[at]}`);
      // The new version tidies old folders once its window is up (settleLayout): a version waiting to be switched to is
      // never among them. Asked of the same tidy-up, dry (nothing is moved), so every folder stays for the checks below.
      const wouldGo = [];
      await pruneAppFolders(root, await readPointer(root), { rename: async (from) => { wouldGo.push(from); throw new Error("dry run"); } });
      for (const later of versions.slice(at + 1)) {
        assert.ok(!wouldGo.some((path) => path.endsWith(`app-${later}`)), `version ${later}, still to come, is kept: ${wouldGo.join(", ")}`);
        pendingChecks++;
      }
      const now = await health();
      assert.deepEqual([now.gateway.pid, now.worker.pid], [gateway, worker], "the same gateway and the same engine: nothing restarted");
      assert.equal(model.asked.filter((one) => one.tag !== "other").length, 5, `no work was asked of the model again: ${JSON.stringify(model.asked)}`);
      progress(`update ${at} done in ${gaps.at(-1)} ms`);
    }
    assert.ok(model.streamed.words > wordsAtStart, "the answer kept streaming through the updates");
    assert.deepEqual(seen, [0, 0, 0], "each switch happened out of the owner's sight: they never saw Branch without its window");

    // ---- all four finish, each exactly once ----
    model.letGo();
    const finished = await until("all four to finish", async () => {
      const runs = (await runsOf()).filter((run) => tags.some((tag) => run.prompt.includes(tag)));
      return runs.length === 4 && runs.every((run) => ["completed", "failed", "cancelled", "error"].includes(run.status)) ? runs : null;
    }, 180_000, 500);
    const posted = await inbound;
    assert.equal(posted.status, 200, `the chat service's post, open across all three switches, was answered: ${await posted.text()}`);
    for (const [name, open] of [["tool task", tool], ["helper", helper]])
      assert.equal((await open).status ?? "completed", "completed", `the ${name}'s own request, open across all three switches, got its answer`);
    assert.deepEqual(finished.map((run) => run.status), ["completed", "completed", "completed", "completed"], JSON.stringify(finished.map((run) => [run.prompt, run.status])));
    const tally = (tag) => model.asked.filter((one) => one.tag === tag).length;
    assert.deepEqual({ stream: tally("STREAM-A"), tool: tally("TOOL-B"), chat: tally("CHAT-C"), helper: tally("HELPER-D") }, { stream: 1, tool: 2, chat: 1, helper: 1 },
      "each piece of work asked the model exactly as often as it needed: nothing was dropped or asked twice");
    // The streamed answer arrived whole and in order: w1 … wN END, no word missing or doubled.
    const shown = await until("the streamed answer in the window", () => inPage(shell, `const text = document.getElementById("scroll")?.innerText ?? ""; return text.includes("END") ? text : null;`), 60_000);
    assert.deepEqual(shown.match(/\bw\d+\b/g) ?? [], Array.from({ length: model.streamed.words }, (_, at) => `w${at + 1}`), "every streamed word, once, in order");
    // The chat app got exactly one answer.
    await until("the chat reply", async () => chat.replies.length >= 1, 60_000);
    await wait(2000);
    assert.equal(chat.replies.length, 1, JSON.stringify(chat.replies));
    assert.match(JSON.stringify(chat.replies[0]), /CHAT-C done/);
    progress("all four finished once");

    // ---- a broken fourth update: its window never comes; the version before is back by itself and says why ----
    progress("update 4 (broken)");
    await switchTo(versions[3], versions[4], base + 4);
    await until(`${versions[3]} back`, async () => (await readFile(join(scratch, "apply-update.log"), "utf8")).includes(`${versions[3]} is back; starting it`), 180_000, 500);
    shell = await inspector(base + 4); shells.push(shell);
    await drawn(shell);
    assert.equal(await shell.evaluate("require('electron').app.getVersion()"), versions[3]);
    assert.equal((await readPointer(root))?.folder, `app-${versions[3]}`, "the pointer went back");
    const status = await until("the failure to be said", () => inPage(shell, `const status = await window.branchDesktop.updateStatus(); return status.phase === "error" ? status : null;`));
    assert.match(status.message, /0\.99\.5 did not open its window, so Branch went back to 0\.99\.4/);
    const after = await health();
    assert.deepEqual([after.gateway.pid, after.worker.pid], [gateway, worker], "the gateway and engine ran through the failed one too");
    asking = false; await client;
    assert.ok(asked > 50, `the gateway client kept asking (${asked})`);
    assert.equal(failed, 0, "no request to the gateway failed during any switch");

    // ---- no program was made: every program in the install is Electron's own stock file ----
    const programs = (await files(root)).filter((name) => /\.exe$/i.test(name));
    assert.equal(programs.length, versions.length, programs.join(", "));
    for (const name of programs) assert.equal(await sha256(join(root, name)), stockHash, `${name} is byte for byte Electron's own`);
    const stock = await stat(join(dist, "electron.exe"));
    const linked = (await Promise.all(programs.map((name) => stat(join(root, name))))).every((one) => one.ino === stock.ino);
    const summary = JSON.stringify({ updates: 3, rollback: true, programs: programs.length, sameFileAsStock: linked, gatewayPid: gateway, enginePid: worker,
      gatewayRequests: asked, gatewayFailures: failed, switchMs: gaps, seenNoWindowMs: seen, pendingVersionsKept: pendingChecks, pendingVersionsLost: 0, streamedWords: model.streamed.words });
    progress(`PASSED ${summary}`);
    console.log("chaos proof", summary);
  }
});
