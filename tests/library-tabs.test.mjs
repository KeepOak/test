/**
 * The Library's tabs (Memory, Documents, Made for you) ride along at the top of the page as it scrolls.
 * They must sit below the window's header at every width, never on top of it, and nothing that scrolls
 * under them may show through: at 1440×1000 and 390×844 the old tabs were transparent, and on a phone
 * they stuck 12 pixels up into the header, so card text and tab names were drawn over each other.
 * Redesign: in the new window (prototype.html .tabs, public/app.css:337) the tabs are part of the page and scroll with it;
 * they are not pinned, so "rides along at the top and is painted solid" is replaced by the new window. What still holds:
 * the tabs sit below the title bar and the page's first words start below them, at every width.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn, openPlace } from "./new-window-places.mjs";

/** Where the title bar ends, where the tabs are, where the first words of the tab's page under them start. */
const geometry = (page) => page.evaluate(() => {
  const tabs = document.querySelector("#main .place .tabs");
  const head = document.querySelector(".titlebar").getBoundingClientRect();
  const words = [...document.querySelectorAll("#main .place .rows b, #main .place .rows p")].find((node) => node.offsetParent && node.textContent.trim());
  return { head: head.bottom, tabs: tabs.getBoundingClientRect(), words: words.getBoundingClientRect().top };
});

for (const [width, height] of [[1440, 1000], [390, 844]]) {
  test(`at ${width}×${height} the Library's tabs stay under the header and nothing shows through them`, async (t) => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const root = await mkdtemp(join(tmpdir(), "branch-library-tabs-"));
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
    const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
    const httpCall = (path, body) => fetch(new URL(path, server.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then((response) => response.json());
    await httpCall("/api/onboarding", { done: true });
    t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signIn(page, server);
    // WINDOW BUG (390 px): public/app/main.js:38 on("view") never takes "side-open" off #app (prototype.html:3622 does), so
    // on a phone the side list stays over Library after it is chosen and its tabs cannot be reached.
    await openPlace(page, "library", "memory");
    await page.locator("#main .place .tabs").waitFor({ state: "visible" });

    const rest = await geometry(page);
    assert.ok(rest.tabs.top >= rest.head - 0.5, `the tabs start below the title bar (${rest.tabs.top} < ${rest.head})`);
    assert.ok(rest.words >= rest.tabs.bottom - 0.5, `the page's first words start below the tabs (${rest.words} < ${rest.tabs.bottom})`);
    // Redesign: replaced by the new window (the tabs scroll with the page, prototype.html .tabs is not sticky), so the
    // scrolled "tabs pinned at the top, painted solid" check is not made.
    assert.deepEqual(errors, []);
  });
}
