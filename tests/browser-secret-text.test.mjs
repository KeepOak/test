import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { scrubText, secretValues } from "../dist/integrations/browser-page.js";
import { leaksIn } from "../dist/integrations/browser-trace.js";
import { ToolRegistry, Budget, RunArtifacts } from "../dist/index.js";

/**
 * Page text handed to the assistant (browser.snapshot, browser.extract, browser.shape, browser.annotate) never carries
 * a value a box holds that the assistant must not read: a password, a one-time code, a code a saved sign-in typed (and
 * the rest of a split code the page spread it into), or, in the owner's own window, anything the task did not type.
 * The box's role and label stay. Pictures of the same boxes are covered, and a recording never starts past a box that
 * cannot be asked.
 */

const code = "424242";
/** A code sent to the next page in its address. */
const formCode = "135246";
/** Secret values that each take a different way through the accessibility tree's quoting. */
const secrets = ["987654", 'he said "hi" \\ back', "colon: inside", "-dash-first", " spaced out ", "tab\there"];
/** A secret long enough that a page library's message cuts it short. */
const long = "correct-horse-battery-staple-and-a-good-deal-more";
const attr = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const pages = {
  "/secrets": () => `<!doctype html><title>Secrets</title><body>
<label>User <input value="plain-user"></label>
<label>Password <input type="password" placeholder="your password" value="correct-horse-battery-staple"></label>
<label>Code <input type="text" autocomplete="one-time-code" value="${code}"></label>
${secrets.map((value, index) => `<label>Pin${index} <input type="password" value="${attr(value)}"></label>`).join("\n")}
<table><tr><td>Echo correct-horse-battery-staple</td><td>${code}</td></tr></table>
<iframe srcdoc="<input type=password value=frame-horse-staple>"></iframe></body>`,
  "/plain": () => `<!doctype html><title>Plain</title><style>input:focus{outline:none}</style><body bgcolor="#1f9d55">
<label for="c">Code</label> <input id="c" type="text" size="12">
<button id="next">Next</button>
<script>document.getElementById("next").onclick = () => history.pushState({}, "", "/plain/step-two");</script></body>`,
  "/split": () => `<!doctype html><title>Split</title><style>input:focus{outline:none}</style><body bgcolor="#1f9d55">
<div id="group"><label for="d0">Code</label> <input id="d0" type="text" inputmode="numeric" size="2">
<input id="d1" maxlength="1" size="2"><input id="d2" maxlength="1" size="2"><input id="d3" maxlength="1" size="2">
<input id="d4" maxlength="1" size="2"><input id="d5" maxlength="1" size="2"></div>
<script>document.getElementById("d0").addEventListener("input", (event) => {
  const digits = event.target.value.replace(/\\D/g, "").split("");
  for (let index = 0; index < 6; index++) document.getElementById("d" + index).value = digits[index] ?? "";
});</script></body>`,
  "/many": () => `<!doctype html><title>Many</title><body>
${Array.from({ length: 10 }, (_, index) => `<label>Box${index} <input type="text"></label>`).join("\n")}</body>`,
  "/owner": () => `<!doctype html><title>Owner</title><body>
<label>Mine <input id="mine"></label> <label>Theirs <input id="theirs"></label> <input type="submit" value="Send it">
<div id="note" contenteditable="true"></div>
<script>for (const box of document.querySelectorAll("input")) box.addEventListener("input", () => box.setAttribute("value", box.value));</script></body>`,
  "/errors": () => `<!doctype html><title>Errors</title><body>
<label>Code <input type="password" value="${long}"></label>
<label>Code <input autocomplete="one-time-code" value="${code}"></label>
<button aria-label="Go">Go ${long}</button> <button aria-label="Go">Go ${long}</button> <button>Send ${code}</button></body>`,
  "/away": () => `<!doctype html><title>Away</title><body><p>Elsewhere</p></body>`,
  // A page that copies what its code box holds into its own address and title.
  "/address": () => `<!doctype html><title>Address</title><body>
<label>Code <input id="c" autocomplete="one-time-code" value="${code}"></label> <label>Pass <input type="password" value="p@ss word!"></label>
<script>history.replaceState({}, "", "/address?otp=${code}&pw=" + encodeURIComponent("p@ss word!") + "&next=keep");
document.title = "Code ${code}";</script></body>`,
  // A form sent the way that puts its boxes into the next page's address; the code arrives in its box after the page opened.
  "/form": () => `<!doctype html><title>Form</title><body><form action="/away" method="get">
<label>Code <input id="otp" name="otp" autocomplete="one-time-code"></label> <label>Look for <input name="q" value="shoes"></label>
<button>Send</button></form><script>setTimeout(() => { document.getElementById("otp").value = "${formCode}"; }, 150);</script></body>`,
  // A message box and a download that each carry what the code box holds.
  "/boxes": () => `<!doctype html><title>Boxes</title><body>
<label>Code <input id="c" autocomplete="one-time-code" value="${code}"></label> <button id="say">Say</button>
<a href="/file?otp=${code}" download>Get</a>
<script>document.getElementById("say").addEventListener("click", () => alert("Your code is " + document.getElementById("c").value));</script></body>`,
  "/file": () => "a file",
  // A code box that is no password box, read while a recording is kept.
  "/record": () => `<!doctype html><title>Record</title><body>
<label>Code <input autocomplete="one-time-code" value="${code}"></label> <label>Look for <input value="plain-shoes"></label></body>`,
};

async function site(t) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname, page = pages[path.startsWith("/plain") ? "/plain" : path.startsWith("/record") ? "/record" : path];
    response.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8", ...(path === "/file" ? { "content-disposition": "attachment; filename=file.txt" } : {}),
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'" });
    response.end(page ? page() : "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function harness(t, origin, runId) {
  const root = await mkdtemp(join(tmpdir(), "branch-secret-text-"));
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.artifacts = new RunArtifacts(join(root, "artifacts"));
  t.after(async () => { await browser.close(); await discardTemp(root); });
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  const context = { owner: "local", workspace: ".", runId, signal: AbortSignal.timeout(60000),
    budget: new Budget(), permissions: new Set(["browser.read", "browser.interact"]), depth: 0 };
  const run = (name, input = {}) => registry.execute(name, input, context);
  const entry = () => browser.sessions.get(JSON.stringify(["local", runId]));
  return { browser, run, context, entry };
}

/** How many pixels of a PNG are near white, and how many are the page's green. */
async function tally(png) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(async (src) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let white = 0, green = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) white++;
        if (d[i + 1] > 120 && d[i] < 90) green++;
      }
      return { white, green };
    }, `data:image/png;base64,${png.toString("base64")}`);
  } finally { await browser.close(); }
}

test("the snapshot, extract, shape and marks never carry a password or a code; labels and plain values stay", async (t) => {
  const origin = await site(t);
  const { run } = await harness(t, origin, "secret-text-top");
  await run("browser.navigate", { url: `${origin}/secrets` });
  const { accessibility } = await run("browser.snapshot");
  for (const value of ["correct-horse-battery-staple", code, "987654", 'he said', "colon: inside", "-dash-first", "spaced out", "tab here", "back"])
    assert.ok(!accessibility.includes(value), `the snapshot does not carry ${JSON.stringify(value)}:\n${accessibility}`);
  assert.match(accessibility, /textbox "User": plain-user/, "a plain box still shows what it holds");
  assert.match(accessibility, /textbox "Password":\n\s+- \/placeholder: your password\n\s+- text: \(hidden\)/, "the password box keeps its label");
  assert.match(accessibility, /textbox "Code": \(hidden\)/, "the code box keeps its label");
  for (let index = 0; index < secrets.length; index++)
    assert.match(accessibility, new RegExp(`textbox "Pin${index}": \\(hidden\\)`), `Pin${index} keeps its label`);
  const { rows } = await run("browser.extract", { selector: "tr" });
  assert.deepEqual(rows, [{ column1: "Echo (hidden)", column2: "(hidden)" }], "a secret the page repeats in its own text is taken out too");
  const shaped = await run("browser.shape", { fields: {
    password: { selector: "input[type=password]", attribute: "value" },
    code: { selector: "input[autocomplete]", attribute: "value", type: "number" },
    user: { selector: "input", attribute: "value" } } });
  assert.deepEqual(shaped.rows, [{ password: "(hidden)", code: null, user: "plain-user" }], "a value attribute read back is taken out, before it is read as a number");
  const marks = await run("browser.annotate", {});
  assert.ok(!JSON.stringify(marks).includes("correct-horse"), "no mark is named after a secret");
  await run("browser.unmark");
});

test("the values that are taken out are read from every frame, nested ones too", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const inner = "<input type=password value=deep-frame-horse><input autocomplete=one-time-code value=135790>";
    await page.setContent(`<input type=password value=top-horse><iframe srcdoc="<input autocomplete='x one-time-code' value=246801><iframe srcdoc='${inner}'></iframe>"></iframe>`);
    await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.querySelector("iframe")?.contentDocument?.querySelector("input"));
    const found = await secretValues(page, [], null);
    for (const value of ["top-horse", "246801", "deep-frame-horse", "135790"]) assert.ok(found.includes(value), `${value} is found: ${found}`);
  } finally { await browser.close(); }
});

test("no part of a longer secret is left beside a shorter one inside it", () => {
  assert.equal(scrubText("then correct horse staple here", ["correct", "correct horse staple"]), "then (hidden) here");
});

test("a code a saved sign-in typed into a plain box stays out of page text, across a move within the page, and is forgotten on leaving", async (t) => {
  const origin = await site(t);
  const { browser, run, context, entry } = await harness(t, origin, "secret-text-plain");
  await run("browser.navigate", { url: `${origin}/plain` });
  await browser.signInPage().type(context, "code", "Code", code);
  const snapshot = async () => (await run("browser.snapshot")).accessibility;
  assert.ok(!(await snapshot()).includes(code), "the code is not in the snapshot");
  assert.match(await snapshot(), /textbox "Code": \(hidden\)/);
  await run("browser.click", { role: "button", name: "Next" });
  await new Promise((done) => setTimeout(done, 300));
  assert.match((await run("browser.extract", { selector: "body" })).rows[0].text, /Code/);
  assert.ok(!(await snapshot()).includes(code), "a move within the same page keeps the box covered");
  await run("browser.navigate", { url: `${origin}/away` });
  let left = null;
  for (let tries = 0; tries < 20 && left !== 0; tries++) {
    left = [...entry().filled.values()].reduce((sum, kept) => sum + kept.boxes.length, 0);
    if (left) await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(left, 0, "the boxes are forgotten once the page shows another document");
});

test("a code spread into a split code's boxes is covered in pictures and taken out of the snapshot, box by box", async (t) => {
  const origin = await site(t);
  const { browser, run, context } = await harness(t, origin, "secret-text-split");
  await run("browser.navigate", { url: `${origin}/split` });
  assert.ok((await tally(await readFile((await run("browser.screenshot")).path))).white > 0, "the boxes are white while empty");
  await browser.signInPage().type(context, "code", "Code", "123456");
  const { accessibility } = await run("browser.snapshot");
  assert.ok(!/textbox[^\n]*: "?\d/.test(accessibility), `no code box shows a digit:\n${accessibility}`);
  assert.equal((accessibility.match(/: \(hidden\)/g) ?? []).length, 6, "all six boxes keep their place");
  const { white, green } = await tally(await readFile((await run("browser.screenshot")).path));
  assert.ok(green > 10000, `the page is there: ${green} green pixels`);
  assert.equal(white, 0, "no box of the split code is left uncovered");
});

test("every box a saved sign-in typed into stays covered, however many there are", async (t) => {
  const origin = await site(t);
  const { browser, run, context } = await harness(t, origin, "secret-text-many");
  await run("browser.navigate", { url: `${origin}/many` });
  for (let index = 0; index < 10; index++) await browser.signInPage().type(context, "code", `Box${index}`, `55${index}0${index}7`);
  const { accessibility } = await run("browser.snapshot");
  for (let index = 0; index < 10; index++) assert.match(accessibility, new RegExp(`textbox "Box${index}": \\(hidden\\)`), `Box${index} is still taken out`);
});

test("a recording does not start when a box a saved sign-in typed into cannot be asked what it holds", async (t) => {
  const origin = await site(t);
  const { browser, run, context, entry } = await harness(t, origin, "secret-text-record");
  await run("browser.navigate", { url: `${origin}/away` });
  entry().filled.set({}, { document: 0, boxes: [{ evaluateAll: () => Promise.reject(new Error("the frame went away")) }] });
  await assert.rejects(browser.startRecording(context), /cannot start yet/);
});

test("in the owner's own window, only what the task typed itself is shown back; what the owner typed is taken out", async (t) => {
  const origin = await site(t);
  const { browser, run } = await harness(t, origin, "secret-text-borrow");
  const port = 9437;
  const owned = await chromium.launchPersistentContext("", { headless: true, args: [`--remote-debugging-port=${port}`] });
  t.after(() => owned.close());
  browser.store = { get: () => ({ data: { enabled: true, port, runId: "secret-text-borrow", grantedAt: new Date().toISOString() } }), save: () => undefined };
  await run("browser.borrow", { action: "borrow" });
  await run("browser.navigate", { url: `${origin}/owner` });
  await run("browser.fill", { label: "Mine", value: "task words" });
  const tab = owned.pages().find((page) => page.url() === `${origin}/owner`);
  assert.ok(tab, "the owner can see Branch's tab");
  await tab.locator("#theirs").pressSequentially("owner private words");
  const { accessibility } = await run("browser.snapshot");
  assert.match(accessibility, /textbox "Mine": task words/, "what the task typed is shown back");
  assert.match(accessibility, /textbox "Theirs": \(hidden\)/, "what the owner typed is not");
  assert.ok(!accessibility.includes("owner private"));
  assert.match(accessibility, /button "Send it"/, "a button keeps its words");
  const shaped = await run("browser.shape", { fields: { theirs: { selector: "#theirs", attribute: "value" } } });
  assert.deepEqual(shaped.rows, [{ theirs: "(hidden)" }], "nor is it read back from the value the page copies it into");
  await tab.locator("#note").pressSequentially("owner diary words");
  assert.ok(!(await run("browser.snapshot")).accessibility.includes("owner diary"), "nor what the owner typed into a rich-text block");
  assert.ok(!JSON.stringify(await run("browser.extract", { selector: "body" })).includes("owner diary"), "nor is it read out of the page's text");
  assert.match((await run("browser.snapshot")).accessibility, /textbox "Mine": task words/, "what the task typed is still shown back");
});

test("a message a failed step brings back, and the numbered marks' map, never carry a secret a box holds", async (t) => {
  const origin = await site(t);
  const { run } = await harness(t, origin, "secret-text-errors");
  await run("browser.navigate", { url: `${origin}/errors` });
  const failed = async (name, input) => {
    try { await run(name, input); } catch (error) { return error.message; }
    assert.fail(`${name} was expected to fail`);
  };
  const many = await failed("browser.fill", { label: "Code", value: "x" });
  assert.match(many, /2 elements/, "the message still says what went wrong");
  const pressed = await failed("browser.click", { role: "button", name: "Go" });
  for (const message of [many, pressed]) {
    assert.ok(!message.includes(code), `the code is not quoted:
${message}`);
    assert.ok(!message.includes("correct-horse-battery"), `no part of the password is quoted:
${message}`);
  }
  const marks = await run("browser.annotate", {});
  assert.ok(!marks.map.includes(code) && !marks.map.includes("correct-horse"), `the map carries no secret:
${marks.map}`);
  assert.match(marks.map, /button "Send \(hidden\)"/, "the button keeps its place in the map");
  await run("browser.unmark");
});

test("an address or a page title never carries a code a box holds, also after a form sends it on to the next page", async (t) => {
  const origin = await site(t);
  const { run } = await harness(t, origin, "secret-text-address");
  const opened = await run("browser.navigate", { url: `${origin}/address` });
  assert.ok(!opened.url.includes(code) && !opened.title.includes(code), `the address and title carry no code: ${opened.url} ${opened.title}`);
  assert.ok(!opened.url.includes("p%40ss") && !opened.url.includes("p@ss"), `nor the password as an address carries it: ${opened.url}`);
  assert.match(opened.url, /next=keep/, "the rest of the address stays");
  assert.equal(opened.title, "Code (hidden)", "the title keeps its words");
  const looked = await run("browser.snapshot");
  assert.ok(!looked.url.includes(code), `the snapshot's address carries no code: ${looked.url}`);
  const { tabs } = await run("browser.tab", { action: "list" });
  assert.ok(tabs.every((tab) => !tab.url.includes(code)), `no tab's address carries it: ${JSON.stringify(tabs)}`);

  await run("browser.navigate", { url: `${origin}/form` });
  await new Promise((done) => setTimeout(done, 400)); // the page puts the code in its box
  const sent = await run("browser.click", { role: "button", name: "Send" });
  assert.match(sent.url, /\/away\?/, "the step landed on the next page");
  assert.ok(!sent.url.includes(formCode), `the step's answer carries no code: ${sent.url}`);
  assert.match(sent.url, /q=shoes/, "a plain value in the address stays");
  const after = await run("browser.snapshot");
  assert.ok(!after.url.includes(formCode), `nor a later look at that page: ${after.url}`);
});

test("a message box's words and a download's source never carry a code a box holds", async (t) => {
  const origin = await site(t);
  const { run } = await harness(t, origin, "secret-text-boxes");
  await run("browser.navigate", { url: `${origin}/boxes` });
  const said = await run("browser.click", { role: "button", name: "Say" });
  assert.equal(said.messageBoxes?.length, 1, JSON.stringify(said));
  assert.equal(said.messageBoxes[0].message, "Your code is (hidden)", "the message keeps its words, not the code");
  let got = await run("browser.click", { role: "link", name: "Get" });
  for (let tries = 0; tries < 20 && !got.downloads; tries++) got = await run("browser.wait", { networkIdle: true });
  assert.equal(got.downloads?.length, 1, JSON.stringify(got));
  assert.ok(!got.downloads[0].from.includes(code), `the download's source carries no code: ${got.downloads[0].from}`);
  assert.match(got.downloads[0].from, /\/file\?otp=\(hidden\)|\/file\?otp=%28hidden%29/, "the rest of its address stays");
});

test("while a recording is kept, a code box is read as page text is: neither the recording nor the answers carry it", async (t) => {
  const origin = await site(t);
  const { browser, run, context } = await harness(t, origin, "secret-text-recorded");
  await run("browser.navigate", { url: `${origin}/away` });
  await browser.startRecording(context);
  // The address below is the task's own words, which the recording keeps; the code the page puts in its box is not.
  const opened = await run("browser.navigate", { url: `${origin}/record/${formCode}/next?otp=${formCode}` });
  assert.equal(opened.url, origin, `an address that cannot be scrubbed keeps only the site, no path: ${opened.url}`);
  const { accessibility } = await run("browser.snapshot");
  assert.ok(!accessibility.includes(code), `the snapshot does not carry the code:
${accessibility}`);
  assert.match(accessibility, /textbox "Look for": plain-shoes/, "a plain box still shows what it holds");
  const { rows } = await run("browser.extract", { selector: "body", fields: { code: "input[autocomplete]" } });
  assert.ok(!JSON.stringify(rows).includes(code), `nor what extract reads: ${JSON.stringify(rows)}`);
  const kept = await browser.keepRecording(context);
  const bytes = await readFile(kept.path);
  assert.deepEqual(leaksIn(bytes, [code]), [], "the recording does not carry the code");
});
