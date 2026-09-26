/* Q261: the household window still draws now that every read fails closed for a household person. Against a fresh
   throwaway engine: the owner starts a conversation, adds Sam and switches the window to him; Sam starts his own
   conversation. Through the engine: the listed reads answer Sam, a set of the owner's reads (MCP servers, comfort,
   artifacts, documents, pricing, privacy, sandbox, workspace history, local models, the gateway, health) answer him
   the one sentence, a HEAD is refused, and switching the model of the owner's conversation reads like a missing one.
   In the window, headless: it opens on Sam without the household sentence as it starts, opens his conversation from
   the list, walks every place with its tabs and every Settings page (Technical level, so all are there), and records
   zero page errors. Every read the window made is printed with Sam's status; any read answered to Sam that is not in
   the reviewed list fails. It switches back to the owner at the end.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-q261-household-reads.cjs */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
if (PORT === "3210") { console.error("Never the owner's app."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const REFUSAL = "This belongs to the owner. Switch back to the owner's profile to use it.";
/* The reviewed list (src/household-routes.ts householdReads), ":id" for any id. */
const LISTED = ["/api/state", "/api/profiles", "/api/lock", "/api/look", "/api/events/stream", "/api/activity", "/api/commands",
  "/api/policy", "/api/conversation-mode", "/api/conversation-mode/settings", "/api/usage/glance", "/api/delight",
  "/api/deployment/suggestion", "/api/accounts", "/api/adapt", "/api/read-marks", "/api/voice/wake", "/api/voice/dictation",
  "/api/voice/dictation/listen", "/api/sessions", "/api/sessions/:id", "/api/sessions/:id/context", "/api/sessions/:id/export",
  "/api/sessions/:id/followups", "/api/sessions/:id/goal", "/api/sessions/:id/model", "/api/sessions/:id/paths",
  "/api/sessions/:id/pins", "/api/sessions/:id/rewind", "/api/runs/:id", "/api/runs/:id/inspect", "/api/runs/:id/steps",
  "/api/runs/:id/plan", "/api/runs/:id/receipts", "/api/runs/:id/recording", "/api/audit", "/api/audit/export.csv",
  "/api/usage", "/api/prompts", "/api/approvals/categories", "/api/trunks", "/api/trunks/rooms/:id",
  "/api/trunks/conversations/:id", "/api/collab/events", "/api/teams/:id/handoffs", "/api/memory/tidy", "/api/memory/archive", "/api/memory/checkpoints",
  "/api/memory/export", "/api/memory/learned", "/api/memory/proposals", "/api/memory/versions", "/api/labels",
  "/api/connections/catalog", "/api/mcp/catalogue", "/api/release-notes"];
const listedPattern = LISTED.map((path) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(":id", "[a-f0-9-]{36}")}$`));
const isListed = (path) => listedPattern.some((pattern) => pattern.test(path));
const OWNERS = ["mcp/servers", "mcp/connections", "comfort", "artifacts", "documents", "pricing", "privacy", "sandboxes", "os-sandbox",
  "history/files", "history/snapshots", "local-models", "never-break", "health", "knobs", "plugins", "clis", "monitors", "knowledge"];

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function call(p, body, method) {
  const r = await fetch(`${BASE}/api/${p}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function toSam() {
  const ownerRun = await call("run", { prompt: "the owner's conversation" });
  check("the owner has a conversation", ownerRun.body.sessionId, `${ownerRun.status} ${JSON.stringify(ownerRun.body).slice(0, 100)}`);
  const known = (await call("profiles")).body.profiles?.find((profile) => profile.name === "Sam");
  const sam = known ? { status: 200, body: known } : await call("profiles", { name: "Sam", pin: "2468" });
  check("Sam is on this computer", sam.status === 200 && sam.body.id, String(sam.status));
  const switched = await call("profiles/switch", { profileId: sam.body.id, pin: "2468" });
  check("the window is switched to Sam", switched.status === 200 && switched.body.active?.id === sam.body.id, String(switched.status));
  const samRun = await call("run", { prompt: "Sam's own conversation" });
  check("Sam has a conversation of his own", samRun.body.sessionId, `${samRun.status} ${JSON.stringify(samRun.body).slice(0, 100)}`);
  return { ownerSid: ownerRun.body.sessionId, samSid: samRun.body.sessionId };
}

async function samsReads({ ownerSid, samSid }) {
  for (const path of ["state", "profiles", "sessions", "lock", "look", "policy", "accounts", "connections/catalog", "mcp/catalogue", `sessions/${samSid}`])
    check(`GET /api/${path.replace(samSid, ":sam")} answers Sam`, (await call(path)).status === 200);
  for (const path of OWNERS) {
    const answer = await call(path);
    check(`GET /api/${path} is refused to Sam`, answer.status === 400 && answer.body.error === REFUSAL, `${answer.status} ${answer.body.error ?? ""}`.slice(0, 90));
  }
  const head = await fetch(`${BASE}/api/profiles`, { method: "HEAD", headers: { authorization: `Bearer ${TOKEN}` } });
  check("HEAD /api/profiles is refused to Sam", head.status === 400, String(head.status));
  const owners = await call("models/switch", { sessionId: ownerSid, model: "default" });
  const missing = await call("models/switch", { sessionId: "00000000-0000-4000-8000-000000000000", model: "default" });
  check("switching the model of the owner's conversation reads like a missing one", owners.status === 404
    && JSON.stringify([owners.status, owners.body.error]) === JSON.stringify([missing.status, missing.body.error]), `${owners.status} ${owners.body.error}`);
  check("the owner's conversation is not Sam's to open", (await call(`sessions/${ownerSid}`)).status !== 200);
}

async function windowWorks({ samSid }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  let where = "start";
  const errors = [], reads = new Map(), toasts = [];
  page.on("pageerror", (e) => errors.push(`${where}: ${e.message}`));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/") || response.request().method() !== "GET") return;
    const key = `${response.status()} ${url.pathname}`;
    if (!reads.has(key)) reads.set(key, new Set());
    reads.get(key).add(where);
  });
  await page.exposeFunction("q261Toast", (text) => toasts.push({ where, text }));
  await page.addInitScript(() => {
    new MutationObserver((changes) => { for (const change of changes) for (const node of change.addedNodes)
      if (node.nodeType === 1 && node.classList.contains("toast")) window.q261Toast(node.textContent || ""); })
      .observe(document, { childList: true, subtree: true });
  });
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForTimeout(3000);
  if (await page.locator('.ob9 [data-act="ob-close"]').count()) { await page.locator('.ob9 [data-act="ob-close"]').first().click(); await page.waitForTimeout(500); }
  check("the window opens on Sam", (await page.locator(".owner .who14 b").first().innerText().catch(() => "")) === "Sam");
  check("no household sentence as the window starts", !toasts.some((one) => one.text.includes(REFUSAL)), toasts.map((one) => one.text).join(" | ").slice(0, 200));
  where = "conversation";
  const row = page.locator(`[data-act="chat"][data-id="${samSid}"]`).first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(1500); }
  check("Sam's own conversation opens from the list", (await row.count()) > 0 && (await page.locator("#main").innerText().catch(() => "")).includes("Sam's own conversation"));
  for (const place of ["overview", "inbox", "automations", "library", "team", "customize"]) {
    where = place;
    const button = page.locator(`[data-act="view"][data-v="${place}"]`).first();
    if (!(await button.count())) { check(`${place}: its button is drawn`, false); continue; }
    await button.click();
    await page.waitForTimeout(1200);
    const tabs = page.locator('#main [role="tab"]');
    for (let i = 0, n = await tabs.count(); i < n; i += 1) { where = `${place}/tab${i}`; await tabs.nth(i).click().catch(() => undefined); await page.waitForTimeout(700); }
    const drawn = await page.locator("#main").innerText().catch(() => "");
    check(`${place} draws for Sam`, drawn.trim().length > 0, `${drawn.trim().length} characters`);
  }
  where = "settings";
  await page.locator('[data-act="view"][data-v="settings"]').first().click();
  await page.waitForTimeout(600);
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.waitForTimeout(400);
  const pages = await page.locator('[data-act="setpage"]').evaluateAll((els) => els.map((el) => el.dataset.v));
  for (const id of pages) {
    where = `settings/${id}`;
    await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
    await page.waitForTimeout(1200);
    const drawn = await page.locator(".set-col").innerText().catch(() => "");
    check(`Settings › ${id} draws for Sam`, drawn.trim().length > 0, `${drawn.trim().length} characters`);
  }
  where = "idle";
  await page.waitForTimeout(4000);
  check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 400));
  const sorted = [...reads.entries()].map(([key, places]) => `${key}  <- ${[...places].slice(0, 5).join(", ")}${places.size > 5 ? ", …" : ""}`).sort();
  console.log(`\n--- every read the window made as Sam (status path <- where) ---\n${sorted.join("\n")}`);
  const answered = [...reads.keys()].filter((key) => key.startsWith("200 ")).map((key) => key.slice(4));
  check("every read answered to Sam is in the reviewed list", answered.every(isListed), answered.filter((path) => !isListed(path)).join(", "));
  /* A listed read may still be refused by its own route: who answers in a conversation is only a room member's to
     read (src/trunks/api.ts), and his own conversation is not a room. The 401 is the window asking before sign-in. */
  const ownRefusal = (path) => /^\/api\/trunks\/conversations\//.test(path);
  const refused = [...reads.keys()].filter((key) => !key.startsWith("200 ") && !key.startsWith("401 "))
    .filter((key) => isListed(key.split(" ")[1]) && !ownRefusal(key.split(" ")[1]));
  check("no listed read was refused to Sam by the household rule", refused.length === 0, refused.join(", ").slice(0, 300));
  /* Where the household window already showed the owner's refusal before Q261 (the same walk against origin/redesign/window
     at fe000dbd): autonomy, flows and boards, the safety extras, chat apps, projects, settings-kit, calendar, reach and
     others. Anywhere else, a refusal toast is new, and the page should draw without the owner's read instead. */
  const before = new Set(["automations", "automations/tab0", "customize/tab1", "customize/tab3", "inbox", "inbox/tab2", "settings",
    "settings/achievements", "settings/advanced", "settings/computer", "settings/developer", "settings/gateway", "settings/general",
    "settings/instructions", "settings/notifications", "settings/permissions", "settings/secrets", "settings/self", "settings/usage"]);
  const fresh = [...new Set(toasts.filter((one) => /belongs to the owner/.test(one.text) && !before.has(one.where)).map((one) => one.where))];
  check("no new place shows the owner's refusal to Sam", fresh.length === 0, fresh.join(", "));
  const told = [...new Set(toasts.map((one) => `${one.where}: ${one.text}`))];
  console.log(`--- toasts shown to Sam (where: words) ---\n${told.join("\n") || "(none)"}`);
  await browser.close();
}

(async () => {
  let ids = null;
  try {
    ids = await toSam();
    await samsReads(ids);
    await windowWorks(ids);
  } finally {
    const back = await call("profiles/switch", { profileId: null });
    check("switched back to the owner", back.status === 200 && back.body.active === null, String(back.status));
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
