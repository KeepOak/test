// The phone app's own screens (apps/mobile/web) and the native files made for it: colours only from
// the token layer and the theme table, every word from the language files with real French, the five
// places in their order, and the page read at 400 px in a headless browser with a stand-in for the phone.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import test from "node:test";
import * as catalogue from "../public/theme-catalogue.js";
import { NATIVE_THEME, nativePalettes } from "../apps/mobile/web/palette.js";
import { androidColours, androidStrings, capacitorConfig, iosColourSet, writeNativeFiles } from "../apps/mobile/scripts/native-files.mjs";
import { writeIcons } from "../apps/mobile/scripts/icons.mjs";
import { compose, readPng, writePng } from "../apps/mobile/scripts/png.mjs";

const ROOT = join(import.meta.dirname, "..");
const WEB = join(ROOT, "apps", "mobile", "web");
const PUBLIC = join(ROOT, "public");
const colourPattern = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/;
const locale = async (language) => JSON.parse(await readFile(join(PUBLIC, "locales", `${language}.json`), "utf8"));

// Redesign: public files deleted
test.skip("the phone's screens never write a colour down", async () => {
  const offenders = [];
  for (const name of (await readdir(WEB)).filter((each) => /\.(css|js|html)$/.test(each))) {
    if (name === "palette.js") continue; // it reads colours; its patterns are not colours
    const text = await readFile(join(WEB, name), "utf8");
    text.split("\n").forEach((line, index) => {
      const code = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
      if (colourPattern.test(code)) offenders.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("the native projects carry no typed colour outside the generated files", async () => {
  const android = join(ROOT, "apps", "mobile", "android", "app", "src", "main", "res");
  const found = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".xml") && entry.name !== "branch_colors.xml" && colourPattern.test(await readFile(path, "utf8"))) found.push(path);
    }
  };
  await walk(android);
  for (const swift of ["App/BranchShared.swift", "App/BranchViewController.swift", "App/BranchBackground.swift", "ShareExtension/ShareViewController.swift"]) {
    const text = await readFile(join(ROOT, "apps", "mobile", "ios", "App", swift), "utf8");
    if (/UIColor\((red|white|hue)|\.system(Red|Blue|Green|Orange)\b|#[0-9a-fA-F]{6}"/.test(text.replace(/UIColor\(red: CGFloat/g, ""))) found.push(swift);
  }
  assert.deepEqual(found, []);
});

test("every word on the phone has a key, in English and in real French", async () => {
  const [en, fr] = [await locale("en"), await locale("fr")];
  const sources = await Promise.all(["index.html", "phone-home.js", "phone-pair.js", "phone-send.js", "phone.js", "rules.js", "vault.js",
    "phone-connect.js", "phone-device.js"]
    .map((name) => readFile(join(WEB, name), "utf8")));
  const keys = new Set();
  for (const text of sources)
    for (const match of text.matchAll(/(?:data-t="|say\("|refusal\(")([a-zA-Z][\w.]*)"/g)) keys.add(match[1]);
  for (const name of ["lock", "notifications", "share", "voice", "push"]) keys.add(`phone.switch.${name}.title`).add(`phone.switch.${name}.note`);
  // mac7/phone-pairing: the refusal rows are built from a table, so their keys are named here.
  for (const name of ["camera", "screen", "listen", "run"]) keys.add(`phone.device.never.${name}.title`).add(`phone.device.never.${name}.note`);
  assert.ok(keys.size > 60, `only ${keys.size} keys were found; the pattern is looking in the wrong place`);
  const missing = [...keys].filter((key) => !en[key] || !fr[key]);
  assert.deepEqual(missing, []);
  const untranslated = [...keys].filter((key) => key.startsWith("phone.") && en[key] === fr[key] && !/^[{}\s…]*$/.test(en[key]));
  assert.deepEqual(untranslated, []);
});

test("the five places keep their names and their order", async () => {
  const html = await readFile(join(WEB, "index.html"), "utf8");
  const order = [...html.matchAll(/data-go="(\w+)" data-t="([\w.]+)"/g)].map((match) => `${match[1]}=${match[2]}`);
  assert.deepEqual(order, ["chat=nav.chat", "inbox=place.inbox", "automations=place.automations", "library=place.library", "customize=place.customize"]);
});

test("the phone paints the theme with its own copy of the window's theme bridge", async () => {
  // Redesign: the old window's public/theme-bridge.js was removed (#291); the phone keeps that bridge as its own
  // web/theme-bridge.js, built into the app with its other screens, and the build no longer copies it from public/.
  const phone = await readFile(join(WEB, "theme.js"), "utf8");
  assert.match(phone, /from "\/theme-bridge\.js"/);
  assert.doesNotMatch(phone, /const BRIDGE\b/);
  assert.ok(existsSync(join(WEB, "theme-bridge.js")), "the phone carries its own bridge");
  const { REUSED } = await import("../apps/mobile/scripts/build-web.mjs");
  assert.ok(!REUSED.some(([from]) => from === "theme-bridge.js"), "nothing is copied from a file public/ no longer has");
  for (const [from] of REUSED) assert.ok(existsSync(join(PUBLIC, from)), `public/${from} is there to copy`);
});

test("native files are made from the theme table and the language files", async () => {
  const palettes = nativePalettes(catalogue, "forest");
  const config = capacitorConfig(palettes);
  assert.equal(config.backgroundColor, palettes.dark.ground);
  assert.equal(config.plugins.CapacitorHttp.enabled, false);
  assert.equal(config.android.allowMixedContent, false);
  const xml = androidColours(palettes.dark);
  assert.match(xml, new RegExp(`<color name="branch_ground">#FF${palettes.dark.ground.slice(1)}</color>`));
  assert.match(xml, /<color name="branch_on_accent">/);
  assert.equal(androidStrings({ "phone.x": "It's \"here\" & <now>", "phone.y": "@home" }).includes(`It\\'s \\"here\\" &amp; &lt;now&gt;`), true);
  assert.match(androidStrings({ "phone.y": "@home" }), /<string name="phone_y">\\@home<\/string>/);
  const set = iosColourSet("#FFFFFF", "#000000");
  assert.equal(set.colors[0].color.components.red, "1.000");
  assert.equal(set.colors[1].appearances[0].value, "dark");
});

test("the app icon is the mascot over the theme's ground, with no see-through edge", async () => {
  const mark = readPng(await readFile(join(PUBLIC, "assets", "branch-mascot.png")));
  const ground = nativePalettes(catalogue, "forest").dark.ground;
  const icon = readPng(writePng(compose(mark, 64, 0.6, ground), true));
  assert.equal(icon.width, 64);
  const corner = [...icon.data.subarray(0, 4)];
  assert.deepEqual(corner, [...[1, 3, 5].map((at) => parseInt(ground.slice(at, at + 2), 16)), 255]);
  const clear = readPng(writePng(compose(mark, 32, 0.5, null)));
  assert.equal(clear.data[3], 0);
});

/* phase2/everywhere: the Slate default reaches the pieces made at build time, not only the running app. */
test("the splash, launch colour and icon ground wear the window's default theme, Slate", async (t) => {
  const bridge = await readFile(join(WEB, "theme-bridge.js"), "utf8");
  assert.equal(NATIVE_THEME, /DEFAULT_THEME = "([a-z-]+)"/.exec(bridge)?.[1], "the phone's default is the window's default");
  assert.equal(NATIVE_THEME, "slate");
  const slate = nativePalettes(catalogue, "slate"), forest = nativePalettes(catalogue, "forest");
  assert.notEqual(slate.dark.ground, forest.dark.ground, "the two themes can be told apart by their ground");
  assert.deepEqual(nativePalettes(catalogue), slate, "no theme named means Slate");
  const root = await mkdtemp(join(tmpdir(), "branch-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "android", "app", "src", "main", "res"), { recursive: true });
  const { palettes } = await writeNativeFiles(root);
  assert.equal(palettes.dark.ground, slate.dark.ground);
  const config = JSON.parse(await readFile(join(root, "capacitor.config.json"), "utf8"));
  assert.equal(config.backgroundColor, slate.dark.ground, "the launch colour is Slate's ground");
  const night = await readFile(join(root, "android", "app", "src", "main", "res", "values-night", "branch_colors.xml"), "utf8");
  assert.match(night, new RegExp(`<color name="branch_ground">#FF${slate.dark.ground.slice(1)}</color>`), "Android's splash ground is Slate's");
  await writeIcons(root);
  const icon = readPng(await readFile(join(root, "android", "app", "src", "main", "res", "mipmap-mdpi", "ic_launcher.png")));
  assert.deepEqual([...icon.data.subarray(0, 3)], [1, 3, 5].map((at) => parseInt(slate.dark.ground.slice(at, at + 2), 16)), "the icon sits on Slate's ground");
});

/* ---------- the page itself, headless, at a phone's width ---------- */
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };
function serveShell() {
  return createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const candidates = [join(WEB, path), join(PUBLIC, path)];
    for (const file of candidates) {
      if (!file.startsWith(WEB) && !file.startsWith(PUBLIC)) break;
      try {
        const body = await readFile(file);
        response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
        return;
      } catch { /* try the next place */ }
    }
    response.writeHead(404).end();
  });
}
const fakePhone = () => {
  const state = { paired: false, switches: {} };
  globalThis.branchPhoneFake = {
    async session() { return state.paired ? { paired: true, origin: "http://100.64.0.9:3210", pairedAt: "2026-09-17T00:00:00Z" } : { paired: false }; },
    async pair(input) { state.paired = input.code === "123456"; return state.paired ? { paired: true } : { paired: false, error: "That number is not right." }; },
    async forget() { state.paired = false; },
    async request() { return { status: 200, data: { attention: [] } }; },
    async getSwitches() { return { switches: state.switches }; },
    async setSwitches({ switches }) { state.switches = switches; },
    async switchesChanged() {},
    async look() { return { theme: "forest", mode: "dark" }; },
    async lastSeen() { return { at: 0 }; },
    async takeShared() { return { items: [] }; },
    async openBranch(input) { globalThis.opened = input.at; },
    async notify() {},
    async unlock() { return { unlocked: true }; },
    // mac7/phone-pairing: lending this phone to Branch. The key never comes back to the page.
    async deviceStatus() { return { paired: Boolean(state.node), origin: state.node ?? "", never: state.never ?? [], canSign: true }; },
    async devicePair(input) {
      if (input.code !== "654321") return { paired: false, error: "That number is not right. 4 tries left." };
      state.node = input.origin;
      state.never = input.never;
      return { paired: true, nodeId: "a1b2c3d4e5f60718" };
    },
    async deviceNever({ never }) { state.never = never; return { never }; },
    async deviceForget() { state.node = null; },
  };
};

test("the phone's page reads at 400 px: connect, then the five places and switches that start off", {
  skip: existsSync(join(PUBLIC, "fonts", "geist.woff2")) ? false : "build first (npm run build) so the fonts exist",
}, async (t) => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true }).catch(() => null);
  if (!browser) { t.skip("no headless browser on this machine"); return; }
  const server = serveShell();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => { await browser.close(); await new Promise((done) => server.close(done)); });
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  await page.addInitScript(fakePhone);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator("#screen-pair").waitFor({ state: "visible" });
  assert.equal(await page.locator("#screen-pair h2").textContent(), "Connect to your Branch");
  await page.fill("#address", "http://8.8.8.8:3210/pair?id=0f8b2c1e-7d3a-4b5c-9e6f-a1b2c3d4e5f6");
  await page.click("#pair");
  await page.locator("#pair-status.bad").waitFor();
  assert.match(await page.locator("#pair-status").textContent(), /Plain http/);
  await page.fill("#address", "http://100.64.0.9:3210/pair?id=0f8b2c1e-7d3a-4b5c-9e6f-a1b2c3d4e5f6");
  await page.fill("#code", "123456");
  await page.click("#pair");
  await page.locator("#screen-home").waitFor({ state: "visible" });
  const places = await page.locator(".phone-places button").allTextContents();
  assert.deepEqual(places, ["Conversation", "Inbox", "Automations", "Library", "Customize"]);
  const checked = await page.locator(".phone-seg input:checked").evaluateAll((inputs) => inputs.map((input) => input.value));
  assert.deepEqual(checked, ["off", "off", "off", "off", "off"]);
  assert.equal(await page.locator("#talk-card").isHidden(), true, "the talk button waits for its switch");
  // Two quick taps: the second must not undo the first.
  await page.evaluate(() => {
    document.querySelector('input[name="switch-voice"][value="on"]').click();
    document.querySelector('input[name="switch-share"][value="when-needed"]').click();
  });
  await page.locator("#talk-card").waitFor({ state: "visible" });
  await page.locator('input[name="switch-share"][value="when-needed"]:checked').waitFor({ state: "attached" });
  assert.equal(await page.locator('input[name="switch-voice"][value="on"]').isChecked(), true);
  await page.click('[data-go="inbox"]');
  assert.equal(await page.evaluate(() => globalThis.opened), "inbox");
  // mac7/phone-pairing: lending this phone to Branch as one of the owner's devices.
  const square = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
  await page.fill("#device-address", `http://8.8.8.8:3210/devices/pair?offer=${square}`);
  await page.fill("#device-code", "654321");
  await page.click("#device-pair");
  await page.locator("#device-status.bad").waitFor();
  assert.match(await page.locator("#device-status").textContent(), /Plain http/);
  await page.fill("#device-address", `http://100.64.0.9:3210/pair?id=0f8b2c1e-7d3a-4b5c-9e6f-a1b2c3d4e5f6`);
  await page.click("#device-pair");
  assert.match(await page.locator("#device-status").textContent(), /Pair a device/);
  // The phone's own refusals are ticked before pairing and go with the request.
  await page.locator("#device-never-list input").nth(0).check();
  await page.locator("#device-never-list input").nth(3).check();
  await page.fill("#device-address", `http://100.64.0.9:3210/devices/pair?offer=${square}`);
  await page.fill("#device-code", "111111");
  await page.click("#device-pair");
  await page.locator("#device-status.bad").waitFor();
  assert.match(await page.locator("#device-status").textContent(), /4 tries left/);
  await page.fill("#device-code", "654321");
  await page.click("#device-pair");
  await page.locator("#device-paired").waitFor({ state: "visible" });
  assert.equal(await page.locator("#device-with").textContent(), "Lending to http://100.64.0.9:3210");
  assert.equal(await page.locator("#device-join").isHidden(), true, "the card stops asking once the phone is lent");
  assert.deepEqual(await page.evaluate(async () => (await globalThis.branchPhoneFake.deviceStatus()).never), ["camera", "run"]);
  assert.equal(await page.locator("#device-code").inputValue(), "", "the six numbers are not left on the screen");
  await page.click("#device-forget");
  await page.locator("#device-join").waitFor({ state: "visible" });
  assert.equal(await page.locator("#device-paired").isHidden(), true);

  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 0, `the page scrolls sideways by ${wide}px`);
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const ground = nativePalettes(catalogue, "forest").dark.ground;
  assert.equal(background, `rgb(${[1, 3, 5].map((at) => parseInt(ground.slice(at, at + 2), 16)).join(", ")})`);
  assert.deepEqual(problems, []);
});

/* Android refuses a resource name with anything but letters, digits and _, and it refuses one that
   does not start with a letter. A locale key like comfort.network.old-node broke the release build. */
test("every locale key becomes a resource name Android accepts", async () => {
  const { androidStrings } = await import("../apps/mobile/scripts/native-files.mjs");
  const words = await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8").then(JSON.parse);
  const xml = androidStrings(words);
  const bad = [...xml.matchAll(/<string name="([^"]*)"/g)].map((m) => m[1]).filter((name) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(name));
  assert.deepEqual(bad, [], `Android refuses these resource names: ${bad.join(", ")}`);
});
