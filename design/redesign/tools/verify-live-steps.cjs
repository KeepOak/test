/* Live steps: while a task works, the reply area shows its steps as they happen (thoughts the model streams, each tool
   call with a spinner and then its result and time, one emoji per kind of step), and when the answer arrives the steps
   fold to one "Worked for … · N steps" line that opens. Starts its own engine in this process on PORT (default 3800)
   with a stand-in model that streams its thinking and calls two tools slowly, then drives the window and saves a frame
   sequence of the list growing, the folded line and the opened fold.
   Run: npm run build, then PORT=3800 OUT=<folder> node design/redesign/tools/verify-live-steps.cjs */
const { chromium } = require("playwright");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const PORT = Number(process.env.PORT || 3800);
const OUT = process.env.OUT || join(tmpdir(), "verify-live-steps");
mkdirSync(OUT, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

/* Thinks aloud, looks through the folder, reads the note, thinks again and answers: each step a little apart. */
const model = { name: "scripted", async complete(request) {
  const n = request.messages.filter((m) => m.role === "tool").length;
  const think = async (words) => { for (const part of words.split(/(?<= )/)) { request.onReasoningDelta?.(part); await pause(60); } };
  if (n === 0) { await think("The owner wants a summary of their notes, so I'll look at what is in the folder first."); await pause(700);
    return { content: "", toolCalls: [{ id: "c1", name: "files.list", arguments: JSON.stringify({ path: "." }) }] }; }
  if (n === 1) { await think("notes.md looks like the one to read."); await pause(700);
    return { content: "", toolCalls: [{ id: "c2", name: "files.read", arguments: JSON.stringify({ path: "notes.md" }) }] }; }
  await think("It has three items; I'll sum them up in one line."); await pause(1500);
  return { content: "Your notes list three things: the tide tables, the boat booking and the picnic.", toolCalls: [] };
} };

(async () => {
  const root = mkdtempSync(join(tmpdir(), "branch-verify-live-"));
  const dist = join(__dirname, "../../../dist");
  const { createBranch } = await import("file:///" + join(dist, "index.js").replace(/\\/g, "/"));
  const { startServer } = await import("file:///" + join(dist, "server.js").replace(/\\/g, "/"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "notes.md"), "- tide tables\n- boat booking\n- picnic\n");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: model });
  const server = await startServer(app, { dataDir: join(root, "data"), port: PORT });
  const api = async (path, body) => (await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await api("onboarding", { done: true });
    await page.goto(server.url + "/");
    await page.getByLabel("Session token").fill(server.token);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("#prompt").waitFor();
    await page.fill("#prompt", "sum up my notes");
    await page.locator("#send").click();
    // The frame sequence: the list as it grows, every 350 ms, until the answer is in.
    const counts = [];
    let frame = 0, sawSpinner = false, sawThought = false, emoji = new Set();
    for (let i = 0; i < 60; i++) {
      const lines = await page.locator("#live-steps li").count();
      if (lines) {
        counts.push(lines);
        sawSpinner ||= (await page.locator("#live-steps .ls-spin").count()) > 0;
        sawThought ||= (await page.locator("#live-steps .ls-think").count()) > 0;
        for (const e of await page.locator("#live-steps .ls-ic").allTextContents()) emoji.add(e);
        await page.screenshot({ path: join(OUT, `frame-${String(++frame).padStart(2, "0")}.png`) });
      }
      const answered = await page.locator("#conversation").getByText("Your notes list three things").count();
      if (answered && !(await page.locator("#live-steps").count())) break;
      await pause(350);
    }
    check("steps show while it works, before the answer", counts.length > 0 && Math.max(...counts) >= 3, `lines per frame: ${counts.join(",")}`);
    check("the list grows as steps happen", counts.length > 1 && counts.at(-1) > counts[0], counts.join(","));
    check("a thought the model streamed is a line", sawThought);
    check("a running step has a spinner", sawSpinner);
    check("each kind of step has its emoji", emoji.has("💭") && emoji.has("🗂️") && emoji.has("📖"), [...emoji].join(" "));
    await page.locator("#conversation").getByText("Your notes list three things").waitFor({ timeout: 15000 });
    check("the live list goes when the answer arrives", (await page.locator("#live-steps").count()) === 0);
    const fold = page.locator("details.steps summary").last();
    const words = (await fold.textContent().catch(() => "")) ?? "";
    check("the steps fold to one line: Worked for … · N steps", /Worked for .+ · 2 steps/.test(words), words.trim());
    await page.screenshot({ path: join(OUT, "folded.png") });
    await fold.click();
    const opened = await page.locator("details.steps[open] li .ls-ic").allTextContents();
    check("the fold opens to each step, with the same emoji", opened.includes("🗂️") && opened.includes("📖"), opened.join(" "));
    await page.screenshot({ path: join(OUT, "folded-open.png") });
    check("no page errors", errors.length === 0, errors.join("; "));
  } finally {
    await browser.close();
    await server.close();
    await app.close();
  }
  console.log(`frames in ${OUT}`);
  console.log(failed ? `${failed} failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
