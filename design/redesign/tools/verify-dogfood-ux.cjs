/* dogfood-ux: the dogfood and QA findings of lane dogfood-ux (HANDOFF-LEAD-NEXT-2 "Unrouted findings" 4-10, Q070, Q072,
   Q073, the usage popover's account line and ChatGPT's plain name), each driven with the real mouse and keyboard in the
   real window and read back through the engine's own GET routes.
   It starts its OWN throwaway engine (a fresh data folder) answered by a scripted stand-in model it serves itself on
   MODEL_PORT, default PORT+1 (OpenAI-shaped: it answers from a small script and keeps what each request carried), then stops both:
     npm run build && PORT=<free port> node design/redesign/tools/verify-dogfood-ux.cjs
   Q070 and Q072 also need Ollama on this computer with a qwen2.5 model already pulled; without it they are SKIP.
   Screenshots go to SHOTS. Page errors must be zero. */
const { chromium } = require("playwright");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.PORT || 3417), MODEL_PORT = Number(process.env.MODEL_PORT || PORT + 1);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH || (existsSync("C:/Users/bishi/AppData/Local/Temp/claude-session-files/lead") ? "C:/Users/bishi/AppData/Local/Temp/claude-session-files/lead/dogfood-ux" : os.tmpdir());
const SHOTS = process.env.SHOTS || join(SCRATCH, "shots");
mkdirSync(SHOTS, { recursive: true });
const ROOT = resolve(__dirname, "../../..");

/* ---------- the stand-in model ---------- */
const seen = []; // every request: { script, system, messages }
const lastUser = (msgs) => [...msgs].reverse().find((m) => m.role === "user" && /SCRIPT:|^[^[]/.test(String(m.content ?? "")));
const byDescription = (tools, re) => tools.find((t) => re.test(t.function.description));
function decide(body) {
  const msgs = body.messages, tools = body.tools ?? [];
  const asked = [...msgs].reverse().find((m) => m.role === "user" && String(m.content ?? "").includes("SCRIPT:"));
  // "Yes, go ahead." after a question carries the same script on.
  const script = /SCRIPT:([a-z-]+)/.exec(String(asked?.content ?? ""))?.[1] ?? "";
  const after = asked ? msgs.slice(msgs.lastIndexOf(asked)) : [];
  const toolTurns = after.filter((m) => m.role === "tool").length;
  const search = byDescription(tools, /^Find a tool by saying/);
  if (script === "fail") return { status: 500 };
  if (script === "markdown") return { text: "# Agent apps comparison\n\n**Hermes** vs *OpenClaw*: the word zebrafish lives only in this reply.\n\n| App | Kind |\n| --- | --- |\n| Hermes | agent |" };
  if (script === "slowtool") {
    if (toolTurns === 0 && search) return { tool: search.function.name, args: { query: "list files" }, wait: 7000 };
    return { text: "Changed course, as you said." };
  }
  if (script === "dotted") {
    if (toolTurns === 0 && search) return { tool: search.function.name, args: { query: "save a document to the Library" } };
    // The name the search's answer gave ("Call documents.add now"), not the wire name the tool was offered under.
    // Called again after the owner's yes when the first call was held for it, as a model does.
    const saved = after.some((m) => m.role === "tool" && /"ok":true/.test(String(m.content)) && /Muse disambiguation/.test(String(m.content)));
    if (!saved) return { tool: "documents.add", args: { name: "Muse disambiguation.md", text: "# Muse\n\n**Meta Muse** is not *Muse AI*.\n\n- one\n- two\n\nquillwort" } };
    return { text: "Saved it to your Library." };
  }
  return { text: `OK: ${String(lastUser(msgs)?.content ?? "").slice(0, 60)}` };
}
function standIn() {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      if (!req.url.includes("chat/completions")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "standin" }] })); return; }
      const body = JSON.parse(raw || "{}"), d = decide(body);
      seen.push({ system: String(body.messages?.[0]?.content ?? ""), messages: body.messages, decided: d });
      if (d.wait) await new Promise((r) => setTimeout(r, d.wait));
      if (d.status) { res.writeHead(d.status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "the stand-in failed on purpose" } })); return; }
      const call = d.tool ? { id: `c${seen.length}`, type: "function", function: { name: d.tool, arguments: JSON.stringify(d.args) } } : null;
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = call ? { role: "assistant", tool_calls: [{ index: 0, ...call }] } : { role: "assistant", content: d.text };
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: body.model, usage,
        choices: [{ index: 0, message: call ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: d.text }, finish_reason: call ? "tool_calls" : "stop" }] }));
    });
  }).listen(MODEL_PORT, "127.0.0.1");
}

/* ---------- the engine ---------- */
let TOKEN = "";
function startEngine(dir) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["dist/cli.js", "start"], { cwd: ROOT, env: { ...process.env, BRANCH_DATA_DIR: join(dir, "data"), BRANCH_WORKSPACE: join(dir, "ws"), BRANCH_PORT: String(PORT),
      BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: `http://127.0.0.1:${MODEL_PORT}/v1`, BRANCH_MODEL: "standin", BRANCH_API_KEY: "sk-standin" } });
    let out = "";
    const timer = setTimeout(() => fail(new Error(`the engine did not start: ${out.slice(-400)}`)), 60000);
    const read = (chunk) => { out += chunk; const m = /paste into browser\): ([0-9a-f]{64})/.exec(out); if (m && !TOKEN) { TOKEN = m[1]; clearTimeout(timer); done(child); } };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
  });
}
async function api(path, body, method) {
  const res = await fetch(`${BASE}/api/${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ""}`);
  return data;
}

/* ---------- helpers ---------- */
const results = [];
const check = (name, ok, how = "") => { results.push([name, ok ? "PASS" : "FAIL", how]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${how ? `  (${how})` : ""}`); };
const skip = (name, why) => { results.push([name, "SKIP", why]); console.log(`SKIP  ${name}  (${why})`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return v; await wait(250); } }
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const greyed = async (loc) => (await loc.getAttribute("aria-disabled")) === "true" || (await loc.isDisabled());
async function click(page, sel) {
  const el = page.locator(sel).first();
  await el.waitFor({ state: "visible", timeout: 15000 });
  if (await greyed(el)) throw new Error(`${sel} is greyed`);
  await el.click();
}
/* Nothing of this engine's is working: a message typed now starts its own task. */
const idle = () => until(async () => !(await api("state")).runs.some((r) => ["running", "queued"].includes(r.status)), 30000);
async function say(page, words) {
  await idle();
  await page.waitForTimeout(400);
  await page.locator("#prompt").click();
  await page.keyboard.type(words);
  await page.keyboard.press("Enter");
}
const text = (page) => page.locator("#app").innerText();
async function openChat(page, id) { await click(page, `#side [data-act="chat"][data-id="${id}"]`); await page.waitForTimeout(600); }
const sessionOfNewest = async () => (await api("state")).runs.find((r) => !r.prompt.startsWith("Trunk:") && !r.prompt.startsWith("Room"))?.sessionId;

async function main() {
  const dir = mkdtempSync(join(SCRATCH, "verify-"));
  const model = standIn();
  const engine = await startEngine(dir);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block", acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true });
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForSelector("#side .machine");
    await page.waitForTimeout(1200);
    // ONLY=local runs the last part alone (it needs Ollama and takes longest).
    if (process.env.ONLY !== "local") {
      await projects(page);
      await searchAndPreviews(page);
      const trunk = await librarian(page);
      await steer(page, trunk);
      await library(page);
      await automations(page, trunk);
      await exportAndWhatsNew(page);
      await usageLines(page);
    }
    await localConnections(page);
  } catch (error) {
    check("run to the end", false, error.stack?.split("\n").slice(0, 3).join(" | "));
    await shot(page, "zz-failed").catch(() => undefined);
  } finally {
    check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
    await browser.close();
    engine.kill();
    model.close();
    await wait(800);
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (error) { console.log(`left ${dir}: ${error.code}`); }
  }
  const failed = results.filter((r) => r[1] === "FAIL").length;
  console.log(`\n${results.filter((r) => r[1] === "PASS").length} passed, ${failed} failed, ${results.filter((r) => r[1] === "SKIP").length} skipped`);
  process.exit(failed ? 1 : 0);
}

/* 4. A project never sticks out of sight, and its instructions stay in its own conversations. */
async function projects(page) {
  await api("projects/new", { id: "dogfood", name: "Branch dogfood", instructions: 'Start each answer with "Dogfood:".' });
  await page.reload();
  await page.waitForSelector("#side .machine");
  await click(page, '#side [data-act="projtoggle"]');
  await click(page, '#side [data-act="project"][data-v="dogfood"]');
  await click(page, '#main [data-act="proj-newconv"][data-v="dogfood"]');
  const chip = await until(async () => ((await page.locator(".proj-chip18").count()) ? page.locator(".proj-chip18").innerText() : null));
  check("4 a new conversation in a project says so", chip?.includes("Branch dogfood"), `header chip "${chip}"`);
  await say(page, "SCRIPT:ping in the project");
  const inProject = await until(async () => { const s = await sessionOfNewest(); const got = s && await api(`sessions/${s}`); return got?.project === "dogfood" && got.messages.some((m) => m.role === "assistant") ? s : null; });
  check("4 filed under the project", !!inProject, "GET /api/sessions/<id> project = dogfood");
  check("4 its instructions reach its own conversation", seen.at(-1)?.system.includes("Dogfood:"), "the model was given the project's instructions");
  await shot(page, "04a-project-chip");
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(400);
  check("4 Ctrl N shows no project", (await page.locator(".proj-chip18").count()) === 0, "no chip on a plain new conversation");
  await say(page, "SCRIPT:ping plain");
  const plain = await until(async () => { const s = await sessionOfNewest(); const got = s && s !== inProject && await api(`sessions/${s}`); return got?.messages?.some((m) => m.role === "assistant") ? [s, got] : null; });
  check("4 Ctrl N files under Default", plain?.[1].project === "default", `project ${plain?.[1].project}`);
  check("4 no project instructions leak", !seen.at(-1)?.system.includes("Dogfood:"), "the model was not given the project's instructions");
  check("4 Default is active again", (await api("projects")).active?.id === "default", "GET /api/projects active");
  // The project's conversation, carried on after another project was opened, stays in its own project.
  await openChat(page, inProject);
  const chipBack = await until(async () => ((await page.locator(".proj-chip18").count()) ? page.locator(".proj-chip18").innerText() : null));
  await say(page, "SCRIPT:ping again");
  await until(async () => (await api(`sessions/${inProject}`)).messages.filter((m) => m.role === "assistant").length >= 2);
  check("4 an older project conversation keeps its project", chipBack?.includes("Branch dogfood") && (await api(`sessions/${inProject}`)).project === "dogfood" && seen.at(-1)?.system.includes("Dogfood:"), "chip, GET project, and its instructions");
}

/* 5 and 6 (previews). Ctrl K finds words that are only in a reply; list previews are plain words. */
async function searchAndPreviews(page) {
  await page.keyboard.press("Control+n");
  await say(page, "SCRIPT:markdown compare them");
  const sid = await until(async () => { const s = await sessionOfNewest(); const got = s && await api(`sessions/${s}`); return got?.messages?.some((m) => m.role === "assistant" && m.content.includes("zebrafish")) ? s : null; });
  await page.waitForTimeout(800);
  const preview = await page.locator(`#side .row[data-id="${sid}"] p`).first().innerText().catch(() => "");
  check("6 sidebar preview is plain words", preview && !/[#*|]/.test(preview), `"${preview}"`);
  await page.keyboard.press("Control+n");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("zebrafish");
  const hit = page.locator('.palette [data-act="pal"]', { hasText: "zebrafish" }).first();
  await hit.waitFor({ timeout: 10000 });
  await shot(page, "05-palette-message");
  await hit.click();
  const opened = await until(async () => (await page.locator(".b .txt", { hasText: "zebrafish" }).count()) > 0);
  check("5 Ctrl K finds a word only in a reply, and opens it", opened, "the palette's Messages row opened the conversation");
}

/* 8. The Librarian Trunk saves to the Library, even when the model names the tool as the search said it. */
async function librarian(page) {
  const { trunk } = await api("trunks", { name: "Agent Product Librarian", title: "Librarian", description: "Keeps comparisons of agent products in the owner's Library." });
  await until(async () => (await api(`sessions/${trunk.chatSessionId}`)).messages.some((m) => m.role === "assistant"));
  await page.reload();
  await page.waitForSelector("#side .machine");
  await openChat(page, trunk.chatSessionId);
  await say(page, "SCRIPT:dotted save a short Library document named Muse disambiguation");
  const allow = page.locator('[data-act="ask"][data-v="allow"]').first();
  await allow.waitFor({ timeout: 20000 });
  await shot(page, "08a-librarian-asks");
  await allow.click();
  const saved = await until(async () => (await api("documents")).documents.find((d) => d.name === "Muse disambiguation.md"));
  check("8 the Librarian saved the document", !!saved, "GET /api/documents lists it");
  const reply = await until(async () => (await text(page)).includes("Saved it to your Library"));
  check("8 and says so", reply && !(await text(page)).includes("unknown tool"), "its reply, no refusal");
  return trunk;
}

/* 7 and Q073. Steering in a Trunk's chat: the chip names the Trunk, and the thread shows only the owner's words. */
async function steer(page, trunk) {
  await say(page, "SCRIPT:slowtool list what is there");
  const chip = page.locator('[data-act="steerb17"]');
  await chip.waitFor({ timeout: 15000 });
  const words = await chip.innerText();
  check("Q073 the steer chip names the Trunk", words.includes(trunk.name) && !words.includes("Branch Agent"), `"${words}"`);
  await chip.click();
  await page.locator("#steer-in-b17").click();
  await page.keyboard.type("Change of plan: only five, Python only.");
  await click(page, '[data-act="steergob17"]');
  const done = await until(async () => (await text(page)).includes("Changed course"), 30000);
  await page.waitForTimeout(800);
  const all = await text(page);
  check("7 the steer is shown as the owner's words", done && all.includes("only five, Python only") && !all.includes("OUT-OF-BAND"), "no wrapper anywhere in the window");
  check("7 one steered line, one full stop", (all.match(/only five, Python only/g) ?? []).length === 1 && !all.includes("only.”."), "not drawn twice, no doubled full stop");
  const kept = (await api(`sessions/${trunk.chatSessionId}`)).messages.some((m) => m.role === "user" && m.content.includes("OUT-OF-BAND") && m.content.includes("only five"));
  check("7 the engine still gives the model its marker", kept, "GET /api/sessions keeps the wrapped note for the model");
  await shot(page, "07-steered");
}

/* 6. A Library document opens to read, drawn as Markdown. Ctrl K finds it by its words. */
async function library(page) {
  await click(page, '#side [data-act="view"][data-v="library"]');
  await click(page, '#main [data-act="ptab"][data-v="documents"]');
  const open = page.locator('#main [data-act="doc-open"]').first();
  await open.waitFor({ timeout: 15000 });
  check("6 Open is live", !(await greyed(open)), "not greyed");
  await open.click();
  const dlg = page.locator(".docread18");
  await dlg.waitFor({ timeout: 10000 });
  const html = await dlg.innerHTML();
  check("6 the document reads as Markdown", /<h1>Muse<\/h1>/.test(html) && /<strong>Meta Muse<\/strong>/.test(html) && !(await dlg.innerText()).includes("**"), "a heading and bold, no raw marks");
  await shot(page, "06-document");
  await click(page, '[data-act="dlg-close"]');
  await page.keyboard.press("Control+k");
  await page.keyboard.type("quillwort");
  const hit = page.locator('.palette [data-act="pal"]', { hasText: "Muse disambiguation" }).first();
  await hit.waitFor({ timeout: 10000 });
  await hit.click();
  check("5 Ctrl K finds a Library document by its words, and opens it", await until(async () => (await page.locator(".docread18").count()) > 0), "the Documents row opened the reader");
  await click(page, '[data-act="dlg-close"]');
}

/* 9. Automations: the assistant can do one; a Trunk's routine is listed by its own name and Trunk; one run is "1 run". */
async function automations(page, trunk) {
  await click(page, '#side [data-act="view"][data-v="automations"]');
  const box = page.locator("#nl-in");
  await box.waitFor({ timeout: 15000 });
  await box.click();
  await page.keyboard.type("Every weekday at 8am read the merged pull requests");
  await click(page, '[data-act="nl-add"]');
  const self = page.locator('.prop17d [data-act="ppset17d"][data-k="trunk"][data-v=""]');
  await self.waitFor({ timeout: 15000 });
  const me = (await api("state")).identity?.name;
  check("9 Who does it offers the assistant", (await self.innerText()) === me && (await self.getAttribute("aria-pressed")) === "true", `"${await self.innerText()}" pressed first`);
  await click(page, `.prop17d [data-act="ppset17d"][data-k="trunk"][data-v="${trunk.id}"]`);
  await shot(page, "09a-who-does-it");
  await click(page, '[data-act="ppok17d"]');
  const listed = await until(async () => (await api("state")).schedules.find((s) => s.routine?.trunkId === trunk.id));
  check("9 a Trunk's routine is linked to its Trunk", !!listed, "GET /api/state schedules[].routine");
  const row = page.locator("#main .prow", { hasText: listed?.routine?.name ?? "—" }).first();
  await row.waitFor({ timeout: 10000 });
  const rowText = await row.innerText();
  check("9 listed by its own name and its Trunk", !rowText.includes("[Trunk") && rowText.includes(trunk.name), `"${rowText.replace(/\s+/g, " ").slice(0, 120)}"`);
  await row.locator('[data-act="sched-run"]').click();
  const ran = await until(async () => { const s = (await api("state")).schedules.find((x) => x.id === listed.id); return (s?.data?.history ?? []).some((h) => h.finishedAt) ? s : null; }, 30000);
  await page.waitForTimeout(1500);
  const health = await row.locator(".health15").innerText().catch(() => "");
  check("9 one run reads as 1 run", !!ran && /\b1 run\b/.test(health) && !/1 runs/.test(health), `"${health}"`);
  // The assistant itself: pressed back to it, the schedule is the owner's own, done by the assistant.
  await box.click();
  await page.keyboard.type("Every day at 9am tidy the downloads folder SCRIPT:fail");
  await click(page, '[data-act="nl-add"]');
  await self.waitFor({ timeout: 15000 });
  await click(page, '[data-act="ppok17d"]');
  const own = await until(async () => (await api("state")).schedules.find((s) => !s.routine && String(s.data?.prompt ?? "").includes("downloads")));
  const ownRow = await page.locator("#main .prow", { hasText: "downloads" }).first().innerText().catch(() => "");
  check("9 the assistant does its own schedule", !!own && ownRow.includes(me), `"${ownRow.replace(/\s+/g, " ").slice(0, 100)}"`);
  // A run that fails hit a snag; it never reads as "needed you" while Inbox › Needs you has nothing.
  await page.locator("#main .prow", { hasText: "downloads" }).first().locator('[data-act="sched-run"]').click();
  await until(async () => ((await api("state")).schedules.find((x) => x.id === own.id)?.data?.history ?? []).some((h) => h.finishedAt), 60000);
  await page.waitForTimeout(1500);
  const failedHealth = await page.locator("#main .prow", { hasText: "downloads" }).first().locator(".health15").innerText().catch(() => "");
  const waiting = (await api("policy")).waiting?.length ?? 0;
  check("9 a failed run says it hit a snag, not that it needed you", /Hit a snag/.test(failedHealth) && !/needed you/.test(failedHealth) && waiting === 0, `"${failedHealth}", ${waiting} waiting`);
  await shot(page, "09b-automations");
}

/* 10. Export conversation saves it (Library › Documents, and a file in a browser); What's new has what this build has. */
async function exportAndWhatsNew(page) {
  const sid = (await api("sessions")).sessions?.find((s) => s.opening?.includes("SCRIPT:markdown"))?.sessionId;
  await openChat(page, sid);
  const before = (await api("documents")).documents.length;
  await click(page, '[data-act="chatmenu"]');
  await click(page, '[data-act="export-conv"]');
  const toastWords = await until(async () => (await page.locator(".toast").allInnerTexts()).join(" ") || null, 8000);
  const docs = await until(async () => { const d = (await api("documents")).documents; return d.length > before ? d : null; });
  const exported = docs?.find((d) => /^conversation-/.test(d.name));
  check("10 Export conversation saves to Library › Documents", !!exported, "GET /api/documents has the conversation");
  check("10 and says where", /Library/.test(toastWords ?? ""), `"${toastWords}"`);
  // Where it went, it now opens to read: the conversation as Markdown, its reply's words in it.
  await click(page, '#side [data-act="view"][data-v="library"]');
  await click(page, '#main [data-act="ptab"][data-v="documents"]');
  await click(page, `#main [data-act="doc-open"][data-id="${exported?.id}"]`);
  const read = await until(async () => ((await page.locator(".docread18").count()) ? page.locator(".docread18").innerText() : null), 10000);
  check("10 the export opens to read", /zebrafish/.test(read ?? "") && !/\*\*/.test(read ?? ""), "Library › Documents › Open");
  await click(page, '[data-act="dlg-close"]');
  await click(page, '[data-act="guide"]');
  await click(page, '[data-act="whatsnew13"]');
  const rows = page.locator(".new13 .new-row13");
  await until(async () => (await rows.count()) > 0, 8000);
  const notes = await api("release-notes");
  check("10 What's new lists this build's notes", (await rows.count()) === notes.items.length && notes.items.length > 0, `${await rows.count()} rows, the engine's notes for ${notes.version}`);
  await shot(page, "10-whats-new");
  await click(page, '.dlg [data-act="dlg-close"], [data-act="dlg-close"]');
  check("10 What's new closes from its own button", (await page.locator(".new13").count()) === 0, "Close");
}

/* The usage popover's lines: who the account is and when it was updated, never how it was read. */
async function usageLines(page) {
  const view = await api("usage/glance");
  const said = JSON.stringify(view);
  check("usage never names headers or plumbing", !/x-codex|headers on answers|as Codex reads/.test(said), "GET /api/usage/glance");
  const presets = (await api("state")).models.presets.map((p) => p.name).join(" | ");
  check("no connection is named unofficial", !/unofficial/i.test(presets), presets);
}

/* Q070 and Q072: a model on this computer is listed under Connections and says hello once. */
async function localConnections(page) {
  const tags = await fetch("http://127.0.0.1:11434/api/tags").then((r) => r.json()).catch(() => null);
  const name = ["qwen2.5:3b", "qwen2.5:7b"].find((n) => tags?.models?.some((m) => m.name === n || m.name === `${n}-branch8k`));
  if (!name) { skip("Q070 local connection listed", "no Ollama qwen2.5 model on this computer"); skip("Q072 one hello", "no Ollama"); return; }
  await api("local-models/switch", { mode: "when-needed" });
  const job = await api("local-models/setup", { runtime: "ollama", name, found: true });
  const done = await until(async () => (await api("local-models")).oneClick.setups.find((s) => s.id === job.id && s.finishedAt), 60000);
  if (!done?.connectionId) { check("Q070 local connection set up", false, done?.message ?? "no connection"); return; }
  await page.reload();
  await page.waitForSelector("#side .machine");
  await page.keyboard.press("Control+,");
  await click(page, '[data-act="setpage"][data-v="models"]');
  await click(page, '[data-act="mtab"][data-v="connections"]');
  const hello = page.locator('[data-act="m-hello"]').first();
  await hello.waitFor({ timeout: 10000 });
  await shot(page, "q070-connections");
  const listed = await page.locator(".acct-gs").innerText();
  check("Q070 Connections lists the model on this computer", listed.includes(name), `"${listed.replace(/\s+/g, " ").slice(0, 160)}"`);
  await hello.click();
  const said = await until(async () => (await page.locator(".toast").allInnerTexts()).join(" ").match(/It answered in [\d.]+ s|did not answer/)?.[0], 90000);
  check("Q070 and says hello through it", /It answered in/.test(said ?? ""), `"${said}"`);
  await click(page, '[data-act="setpage"][data-v="accounts"]');
  const dot = page.locator("#main .status .sdot").first();
  await dot.waitFor({ timeout: 10000 });
  check("Q070 Accounts does not warn while a local model answers", !((await dot.getAttribute("class")) ?? "").includes("bad"), "the status dot");
  await shot(page, "q070-accounts");
  // Q072: setup's models step, after the picker set the model up, shows one hello.
  await page.keyboard.press("Escape");
  await click(page, '[data-act="guide"]');
  await click(page, '[data-act="onboard"]');
  await page.locator("label.ob-agree").click({ timeout: 10000 });
  await click(page, '[data-act="ob-go"][data-v="2"]');
  const use = page.locator('[data-act="lp-use"]').first();
  await page.waitForTimeout(1500);
  await shot(page, "q072-setup");
  if (!(await use.count())) { skip("Q072 one hello", "setup did not show the local picker's Use this"); return; }
  await use.click();
  await until(async () => (await page.locator(".lp").innerText()).match(/It answered in/), 90000);
  await click(page, '[data-act="ob-test"]');
  await page.waitForTimeout(500);
  const settled = await until(async () => { const t = await page.locator(".lp").innerText(); return /It answered in/.test(t) ? t : null; }, 90000);
  const count = ((await page.locator("#app").innerText()).match(/It answered in/g) ?? []).length;
  check("Q072 setup says hello once", !!settled && count === 1, `${count} hello line(s)`);
  await shot(page, "q072-hello");
  await api("models", { activePreset: "default" });
}

main().catch((error) => { console.error(error); process.exit(1); });
