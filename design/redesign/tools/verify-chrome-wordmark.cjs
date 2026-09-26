// Verifies the title-bar pass against a throwaway engine, with a real mouse: the row carries no brand and no conversation
// name, the list's computer switcher sits where the brand was (clear of a Mac's window buttons), the view runs to the top,
// and every button of a conversation's header does something visible in a new conversation, an existing one and a
// Trunk's, at 1440 and at 390. Also the Lockdown row's icon sits on its words' centre line. Exits non-zero on any failure
// or page error.
// Run: PORT=<port> TOKEN=<session token> node design/redesign/tools/verify-chrome-wordmark.cjs
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN, BASE = `http://127.0.0.1:${PORT}`;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const results = [];
const check = (name, ok, detail = "") => { results.push([ok, name, detail]); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const res = await fetch(`${BASE}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function open(browser, width, errors, mac = false) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  if (mac) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .machine", { state: "attached", timeout: 15000 });
  if (await page.isVisible(".ob9")) await page.click('.ob9 [data-act="ob-close"]');
  await wait(900);
  return { ctx, page };
}

const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
const inRow = (page, act) => page.locator(`.titlebar [data-act="${act}"]:visible`).first();

async function goTo(page, id) {
  if (!id) { await page.evaluate(() => document.querySelector('#side [data-act="newmenu"]').click()); await page.click('.pop [data-act="newconv"]'); await wait(600); return; }
  await page.evaluate((sid) => document.querySelector(`#side .row[data-id="${sid}"]`)?.click(), id);
  await wait(800);
}

async function rowChecks(page, label, width) {
  const r = await page.evaluate(() => {
    const bar = document.querySelector(".titlebar"), side = document.querySelector("#side");
    const shown = (n) => !!n && n.getClientRects().length > 0 && n.getBoundingClientRect().width > 1 && getComputedStyle(n).visibility !== "hidden";
    return {
      brand: [...bar.querySelectorAll(".av, .mark, .wordmark")].filter(shown).length,
      name: [...bar.querySelectorAll(".who b")].filter(shown).length,
      heading: bar.querySelector('.who[role="heading"] b')?.textContent.trim() ?? "",
      barLeft: Math.round(bar.getBoundingClientRect().left), sideW: Math.round(side.getBoundingClientRect().width),
      machineTop: Math.round(side.querySelector(".machine").getBoundingClientRect().top),
      machineLeft: Math.round(side.querySelector(".machine").getBoundingClientRect().left),
      mainTop: Math.round(document.querySelector("#main").getBoundingClientRect().top),
      dragBand: getComputedStyle(side.querySelector(".drag17")).webkitAppRegion, machineRegion: getComputedStyle(side.querySelector(".machine")).webkitAppRegion,
      barRegion: getComputedStyle(bar).webkitAppRegion,
    };
  });
  check(`${label}: no brand or face in the title-bar row`, r.brand === 0, `${r.brand}`);
  check(`${label}: no visible conversation name in the row`, r.name === 0, `${r.name}`);
  if (!label.endsWith("place")) check(`${label}: the name stays as the header's accessible heading`, r.heading.length > 0, r.heading);
  check(`${label}: the row stays draggable`, r.barRegion === "drag", r.barRegion);
  if (width > 760) {
    check(`${label}: the row starts at the list's edge`, Math.abs(r.barLeft - r.sideW) <= 1, `${r.barLeft} vs ${r.sideW}`);
    check(`${label}: the computer switcher sits in the top band`, r.machineTop < 20, `top ${r.machineTop}`);
    check(`${label}: the view runs to the top`, r.mainTop === 0, `top ${r.mainTop}`);
    check(`${label}: the list's top band drags, the switcher does not`, r.dragBand === "drag" && r.machineRegion === "no-drag", `${r.dragBand}/${r.machineRegion}`);
  }
  return r;
}

async function headControls(page, label, width) {
  if (width > 480) await sidePanel(page, label);
  // More for this conversation.
  await inRow(page, "chatmenu").click();
  await wait(400);
  const items = await page.locator("#app > .pop .mi").count();
  check(`${label}: More opens its menu`, items > 0, `${items} items`);
  await page.keyboard.press("Escape");
  await wait(200);
  if (width > 480) {
    await inRow(page, "roster10h").click();
    await wait(900);
    check(`${label}: who it knows opens`, await visible(page, "#app > .pop"));
    await page.keyboard.press("Escape");
    await wait(200);
    await inRow(page, "find-open").click();
    await wait(400);
    check(`${label}: find opens`, await visible(page, "#find9-q"));
    await page.locator('[data-act="find-close"]').first().click();
    await wait(300);
  } else {
    // A phone keeps only More beside the list's menu (the side panel, find and who it knows are wide-window buttons).
    await inRow(page, "side").click();
    await wait(500);
    check(`${label}: the list's menu button slides the list in`, await page.evaluate(() => document.getElementById("app").classList.contains("side-open")));
    await page.evaluate(() => document.getElementById("app").classList.remove("side-open"));
    await wait(300);
  }
}

async function sidePanel(page, label) {
  // The side panel: opens in every conversation, and closes again from its close button.
  await inRow(page, "pane").click();
  await wait(400);
  check(`${label}: side panel opens`, await visible(page, "#pane .ptabs"));
  // Every tab draws something (its own words when it has nothing yet); Browser opens the full-size browser view.
  for (const p of await page.$$eval("#pane .ptab", (els) => els.map((e) => e.dataset.p))) {
    if (p === "browser" && label.endsWith("new")) {
      // Before the first message there is no conversation whose browser to show: greyed, with the reason as its tip.
      const tip = await page.getAttribute('#pane .ptab[data-p="browser"]', "data-tip");
      check(`${label}: side panel Browser greyed with its reason`, tip === "After the first message" && (await page.getAttribute('#pane .ptab[data-p="browser"]', "aria-disabled")) === "true", tip ?? "");
      continue;
    }
    await page.locator(`#pane .ptab[data-p="${p}"]`).click();
    await wait(350);
    if (p === "browser") {
      check(`${label}: side panel Browser opens the browser view`, await visible(page, ".stage7"));
      await page.locator('[data-act="stage-close"]').first().click();
      await wait(300);
      if (!(await visible(page, "#pane .ptabs"))) await inRow(page, "pane").click();
      await wait(300);
      continue;
    }
    const drawn = await page.evaluate(() => { const b = document.querySelector("#pane .pane-b") ?? document.querySelector("#pane"); return b.innerText.replace(/\s+/g, " ").trim().length; });
    check(`${label}: side panel ${p} tab draws`, drawn > 0 && await visible(page, `#pane .ptab[data-p="${p}"][aria-selected="true"]`), `${drawn} chars`);
  }
  await page.locator('#pane [data-act="pane"][data-p="close"]').click();
  await wait(300);
  check(`${label}: side panel closes`, !(await visible(page, "#pane .ptabs")));
}

(async () => {
  const errors = [];
  await api("onboarding", { done: true });
  const trunks = (await api("trunks")).trunks ?? [];
  const trunk = trunks.find((t) => t.name === "Researcher") ?? (await api("trunks", { name: "Researcher", title: "Research", description: "Finds sources" })).trunk;
  const ownChats = new Set([...trunks, trunk].map((t) => t.chatSessionId).filter(Boolean));
  const plainOne = async () => ((await api("sessions?limit=50")).sessions ?? []).find((s) => !ownChats.has(s.sessionId ?? s.id));
  // A conversation of the owner's own: with no model the engine still keeps it (its task ends "No model yet").
  let plain = await plainOne();
  if (!plain) { await api("run", { prompt: "Summarise what is in my Downloads folder" }); plain = await plainOne(); }
  const browser = await chromium.launch();
  for (const width of [1440, 390]) {
    const { ctx, page } = await open(browser, width, errors);
    for (const [kind, id] of [["new", null], ["existing", plain && (plain.sessionId ?? plain.id)], ["trunk", trunk.chatSessionId]]) {
      if (kind !== "new" && !id) { check(`${width} ${kind}: a conversation to open`, false); continue; }
      await goTo(page, id);
      await rowChecks(page, `${width} ${kind}`, width);
      await headControls(page, `${width} ${kind}`, width);
    }
    if (width === 1440) {
      await goTo(page, null);
      await inRow(page, "chatmenu").click();
      await wait(300);
      const greyed = await page.$$eval("#app > .pop .mi.soon[aria-disabled=true]", (els) => els.map((e) => e.dataset.tip));
      check("1440 new: conversation-only items greyed with their reason", greyed.filter((tip) => tip === "After the first message").length === 2, JSON.stringify(greyed));
      await page.keyboard.press("Escape");
      // Settings from a place's own header.
      await page.click('#side [data-act="view"][data-v="library"]');
      await wait(600);
      await rowChecks(page, "1440 place", width);
      await inRow(page, "view").click();
      await wait(600);
      check("1440 place: its gear opens Settings", await visible(page, '[data-act="setpage"]'));
      // The Lockdown row: the lock's centre on the words' centre line.
      await goTo(page, null);
      await page.click('[data-act="modemenu2"]');
      await wait(400);
      const gap = await page.evaluate(() => {
        const span = [...document.querySelectorAll("#app > .pop .row-in > span")].find((s) => s.querySelector("svg.i") && s.closest(".row-in").querySelector("#pm-lock2"));
        const svg = span.querySelector("svg").getBoundingClientRect(), range = document.createRange();
        range.selectNodeContents(span.lastChild);
        const text = range.getBoundingClientRect();
        return Math.abs((svg.top + svg.height / 2) - (text.top + text.height / 2));
      });
      check("Lockdown row: lock icon centred on its words", gap <= 1, `${gap.toFixed(2)}px off`);
      await page.keyboard.press("Escape");
    }
    await ctx.close();
  }
  const { ctx, page } = await open(browser, 1440, errors, true);
  const mac = await page.evaluate(() => ({ left: Math.round(document.querySelector("#side .machine").getBoundingClientRect().left) }));
  check("Mac: the switcher keeps clear of the window buttons (ending at x=70)", mac.left >= 76, `left ${mac.left}`);
  await ctx.close();
  await browser.close();
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  const failed = results.filter(([ok]) => !ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
