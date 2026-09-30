/**
 * A ```mermaid block in a reply is drawn by Mermaid (vendored, pinned) inside a sealed frame the engine serves
 * (src/diagram-frame.ts), never in the window: the window's own policy is unchanged, the frame is sandboxed with scripts
 * only, runs only its two nonce'd scripts, and nothing written in a diagram can run. Everything runs on this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { diagramFramePolicy, mermaidVersion } from "../dist/diagram-frame.js";
import { signIn } from "./new-window-places.mjs";

const BENIGN = "flowchart LR\n  A([Something breaks]) --> B{Repair under 150?}\n  B -- yes --> C[You pay]\n  B -- no --> D[Landlord pays]";
/* Each tries to tell the window it ran. None may. */
const ATTACKS = [
  'flowchart LR\n  A["<img src=x onerror=parent.postMessage(\'ran:img\',\'*\')>"] --> B',
  '%%{init: {"securityLevel": "loose", "flowchart": {"htmlLabels": true}}}%%\nflowchart LR\n  A["<img src=x onerror=parent.postMessage(\'ran:init\',\'*\')>"] --> B',
  "flowchart LR\n  A --> B\n  click A call parent.postMessage(\"ran:call\",\"*\")",
  "flowchart LR\n  A --> B\n  click B \"javascript:parent.postMessage('ran:href','*')\"",
  'flowchart LR\n  A["<script>parent.postMessage(\'ran:script\',\'*\')</script>"] --> B',
  'flowchart LR\n  A --> B\n  click A href "https://example.com/?leak=1" "Go"',
  "sequenceDiagram\n  Alice->>Bob: <img src=x onerror=\"parent.postMessage('ran:seq','*')\">",
];
const fence = (body) => "```mermaid\n" + body + "\n```";

async function engine(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mermaid-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: { name: "scripted", async complete(request) {
    const asked = String(request.messages.at(-1).content);
    if (/attack/.test(asked)) return { content: `Here they are.\n\n${ATTACKS.map(fence).join("\n\n")}`, toolCalls: [] };
    if (/too long/.test(asked)) return { content: `Here.\n\n${fence("flowchart TD\n" + "  A --> B\n".repeat(6000))}`, toolCalls: [] };
    if (/wide/.test(asked)) return { content: `Here.\n\n${fence("flowchart LR\n  " + Array.from({ length: 24 }, (_, i) => `N${i}[Step number ${i}]`).join(" --> "))}`, toolCalls: [] };
    if (/tall/.test(asked)) return { content: `Here.\n\n${fence("flowchart TD\n  " + Array.from({ length: 110 }, (_, i) => `N${i}[Step number ${i}]`).join(" --> "))}`, toolCalls: [] };
    return { content: `Here is who pays.\n\n${fence(BENIGN)}`, toolCalls: [] };
  } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  return { app, server };
}

test("the frame: its own strict policy with a fresh nonce, only its two scripts, no key needed; the window's policy is unchanged", async (t) => {
  const { server } = await engine(t);
  const one = await fetch(new URL("/diagram-frame", server.url)), two = await fetch(new URL("/diagram-frame", server.url));
  assert.equal(one.status, 200);
  const html = await one.text(), policy = one.headers.get("content-security-policy");
  const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(policy)?.[1];
  assert.ok(nonce && nonce.length >= 20, "a nonce of its own");
  assert.equal(policy, diagramFramePolicy(nonce), "exactly the frame's policy");
  assert.notEqual(nonce, /'nonce-([A-Za-z0-9_-]+)'/.exec(two.headers.get("content-security-policy"))?.[1], "a new nonce each time");
  for (const part of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'", "sandbox allow-scripts"])
    assert.ok(policy.includes(part), `the policy has ${part}`);
  assert.ok(!/unsafe-eval|unsafe-inline'[^;]*script|script-src[^;]*unsafe/.test(policy), "no inline script and no eval");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.deepEqual(scripts.map((m) => /src="([^"]+)"/.exec(m[1])?.[1]), [`/diagram-frame/mermaid-${mermaidVersion}.min.js`, "/diagram-frame/frame.js"]);
  assert.ok(scripts.every((m) => m[1].includes(`nonce="${nonce}"`) && m[2] === ""), "both carry the nonce and nothing inline");
  const vendored = await fetch(new URL(`/diagram-frame/mermaid-${mermaidVersion}.min.js`, server.url));
  assert.equal(vendored.status, 200, "served with no key (a sealed frame sends none)");
  assert.match(vendored.headers.get("cache-control"), /immutable/, "its address names its version, so it is kept");
  const bytes = Buffer.from(await vendored.arrayBuffer());
  const pinned = createHash("sha256").update(await readFile(new URL(`../public/vendor/mermaid-${mermaidVersion}/mermaid.min.js`, import.meta.url))).digest("hex");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pinned);
  assert.equal(pinned, "581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8", "Mermaid 11.17.2's own dist/mermaid.min.js, byte for byte");
  for (const other of ["/diagram-frame/other.js", "/diagram-frame/mermaid.min.js", "/vendor/mermaid-11.17.2/mermaid.min.js"])
    assert.notEqual((await fetch(new URL(other, server.url))).status, 200, `${other} is not served: only the frame's own names are`);
  const window = await fetch(new URL("/", server.url));
  assert.equal(window.headers.get("content-security-policy"),
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "the window's own policy is exactly as it was");
});

/** A browser signed in to the window, listening for any message a frame manages to send it. */
async function windowAt(t, server) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], refused = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (/Content Security Policy|Refused to/.test(message.text())) refused.push(message.text()); });
  await page.addInitScript(() => { window.__said = []; addEventListener("message", (e) => { if (typeof e.data === "string") window.__said.push(e.data); }); });
  await signIn(page, server);
  return { page, errors, refused };
}
async function openConversation(page, sessionId) {
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator(`#side .list [data-act="chat"][data-id="${sessionId}"]`).click();
}
const frames = (page) => page.frames().filter((f) => f.url().endsWith("/diagram-frame"));

test("a diagram in a reply is drawn in the sealed frame, with its text folded under it", async (t) => {
  const { app, server } = await engine(t);
  const run = await app.runtime.run({ prompt: "draw who pays" });
  const { page, errors, refused } = await windowAt(t, server);
  await openConversation(page, run.sessionId);
  const card = page.locator("#conversation .dia17c").first();
  await card.waitFor({ timeout: 15000 });
  const iframe = card.locator("iframe.dmm-frame");
  assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts", "scripts only: no same origin, no forms, no pop-ups, no top navigation");
  await page.waitForFunction(() => [...document.querySelectorAll("iframe.dmm-frame")].some((f) => parseInt(f.style.height, 10) > 40), null, { timeout: 20000 });
  const [frame] = frames(page);
  assert.ok(frame, "the frame is there");
  const drawn = await frame.evaluate(() => ({ svg: !!document.querySelector("svg"), text: document.body.textContent }));
  assert.ok(drawn.svg, "Mermaid drew a picture");
  for (const words of ["Something breaks", "You pay", "Landlord pays"]) assert.ok(drawn.text.includes(words), `the drawing says ${words}`);
  assert.equal(await card.locator("details pre").textContent(), BENIGN, "the text that drew it, under it");
  assert.deepEqual(refused, [], "Mermaid ran inside the frame's policy without a single refusal");
  assert.deepEqual(errors, []);
});

test("nothing written in a diagram can run: not a handler, a click, a link, an init line or a script", async (t) => {
  const { app, server } = await engine(t);
  const run = await app.runtime.run({ prompt: "attack" });
  const { page, errors } = await windowAt(t, server);
  await openConversation(page, run.sessionId);
  await page.locator("#conversation .dia17c").nth(ATTACKS.length - 1).waitFor({ timeout: 15000 });
  await page.waitForFunction((n) => document.querySelectorAll("iframe.dmm-frame").length === n
    && [...document.querySelectorAll("iframe.dmm-frame")].every((f) => parseInt(f.style.height, 10) > 0 || f.closest("[hidden]")), ATTACKS.length, { timeout: 30000 });
  for (const frame of frames(page)) {
    // Press everything a diagram drew, the way a person would.
    for (const node of await frame.locator("a, .node, [onclick], .clickable").all()) await node.click({ timeout: 2000, force: true }).catch(() => null);
    const risky = await frame.evaluate(() => ({
      inline: document.querySelectorAll("script:not([src])").length,
      handlers: [...document.querySelectorAll("*")].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length,
      links: document.querySelectorAll("a").length,
      away: location.pathname,
      level: globalThis.mermaid?.mermaidAPI?.getConfig?.().securityLevel,
    }));
    assert.equal(risky.inline, 0, "no inline script in a drawing");
    assert.equal(risky.handlers, 0, "no event handler attribute in a drawing");
    assert.equal(risky.links, 0, "no link in a drawing: nothing takes the frame, or the diagram's words, anywhere");
    assert.equal(risky.away, "/diagram-frame", "the frame is still the sealed frame after everything was pressed");
    assert.equal(risky.level, "strict", "an init line cannot lower the security level");
  }
  // Each frame then says one harmless word itself: once every one has arrived, anything a diagram sent earlier has too.
  const all = frames(page);
  for (const frame of all) await frame.evaluate(() => parent.postMessage("checked", "*"));
  await page.waitForFunction((n) => window.__said.filter((w) => w === "checked").length === n, all.length, { timeout: 10000 });
  assert.deepEqual(await page.evaluate(() => window.__said.filter((w) => w !== "checked")), [], "no diagram managed to say anything to the window");
  assert.deepEqual(errors, []);
});

test("the window turning dark or light draws each diagram again in its colours; a very long one shows its text; a wide one scrolls", async (t) => {
  const { app, server } = await engine(t);
  const run = await app.runtime.run({ prompt: "draw who pays" });
  const { page, errors } = await windowAt(t, server);
  await openConversation(page, run.sessionId);
  await page.waitForFunction(() => [...document.querySelectorAll("iframe.dmm-frame")].some((f) => parseInt(f.style.height, 10) > 40), null, { timeout: 20000 });
  const [first] = frames(page);
  assert.equal(await first.evaluate(() => document.querySelector("svg")?.id ?? ""), "diagram-1");
  await first.evaluate(() => { window.__got = []; addEventListener("message", (event) => window.__got.push(event.data)); });
  await page.evaluate(() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "light" ? "dark" : "light"; });
  await first.waitForFunction(() => document.querySelector("svg")?.id === "diagram-2", null, { timeout: 10000 });
  assert.equal(await first.evaluate(() => document.querySelector("svg")?.id), "diagram-2", "drawn again when the window's colours changed");
  const got = await first.evaluate(() => window.__got);
  assert.ok(got.length >= 1 && got.every((m) => m && !("source" in m) && typeof m.dark === "boolean"),
    `a change of colours sends only the colour, never the diagram's text again: ${JSON.stringify(got)}`);

  const long = await app.runtime.run({ prompt: "too long" });
  await openConversation(page, long.sessionId);
  await page.locator("#conversation .dia17c details[open]").waitFor({ timeout: 20000 });
  assert.equal(await page.locator("#conversation .dia17c .dwrap17c[hidden]").count(), 1, "a diagram too long to draw shows its text instead of a blank frame");

  const wide = await app.runtime.run({ prompt: "wide" });
  await openConversation(page, wide.sessionId); // the card is at most 600 px wide, far narrower than this drawing
  await page.waitForFunction(() => [...document.querySelectorAll("iframe.dmm-frame")].some((f) => parseInt(f.style.height, 10) > 40), null, { timeout: 20000 });
  const frame = frames(page).at(-1);
  await frame.waitForFunction(() => document.scrollingElement.scrollWidth > innerWidth, null, { timeout: 10000 }).catch(() => null);
  const widths = await frame.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, view: innerWidth }));
  assert.ok(widths.scroll > widths.view, `a wide drawing keeps its size and scrolls sideways: ${JSON.stringify(widths)}`);
  const tall = await app.runtime.run({ prompt: "tall" });
  await openConversation(page, tall.sessionId);
  await page.waitForFunction(() => [...document.querySelectorAll("iframe.dmm-frame")].some((f) => parseInt(f.style.height, 10) === 8000), null, { timeout: 20000 });
  const tallFrame = frames(page).at(-1);
  const height = await tallFrame.evaluate(() => ({ scroll: document.scrollingElement.scrollHeight, view: innerHeight }));
  assert.ok(height.scroll > height.view, "a capped tall diagram has a vertical scrollbar");
  const bottom = await tallFrame.evaluate(() => {
    const end = [...document.querySelectorAll(".node")].find((node) => node.textContent.includes("Step number 109"));
    end.scrollIntoView({ block: "end" });
    const box = end.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, view: innerHeight };
  });
  assert.ok(bottom.top >= 0 && bottom.bottom <= bottom.view + 1, `the last step is reachable: ${JSON.stringify(bottom)}`);
  assert.deepEqual(errors, []);
});
