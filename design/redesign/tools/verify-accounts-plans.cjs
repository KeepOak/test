/* accounts-wizard-plans: Add an account's "Your plan" and "Coding assistants" choices, and the service marks, on a
   fresh engine with several accounts per connection switched off (as it ships).

   This script starts its OWN engine in this process (dist/, a new temp data folder) rather than taking PORT/TOKEN for a
   running one, because the stand-ins have to be handed to the engine and the engine has no switch that points its
   ChatGPT sign-in somewhere else (and must not get one):
   - a stand-in of OpenAI's device-code sign-in on 127.0.0.1, given to the engine's ChatGPTAuth as its issuer, and to the
     accounts service's fetch for extra ChatGPT accounts. It approves only when this script says the person did.
   - a stand-in "claude" program on PATH (an npm-style claude.cmd launcher on Windows), whose `claude auth status` exits
     0 when "signed in" and 1 when not, for its usual sign-in and for an account folder (CLAUDE_CONFIG_DIR).
   PATH is cut down to that folder, Node and the system folder, so no real coding assistant on this computer is found or
   started. No real account is signed in to and nothing reaches OpenAI or Anthropic.
     npx tsc -p . && node design/redesign/tools/verify-accounts-plans.cjs        (PORT=<free port> to pick the port)
   Covered: aa-grp (Your plan, Coding assistants), aa-plan, aa-dev, aa-chk, aa-cli, aa-fin, aa-done on a ChatGPT and a
   program list (the extra account's own sign-in), Gemini's key step without a Google client id (no aa-goo), and the
   services' own marks (all loading), the neutral glyphs for Email, Microsoft and Apple, in Add an account, Customize › Channels and Setup's
   "Reach it anywhere". Last it starts the engine again on the same data folder and checks that ChatGPT and Claude
   Code are still connected. SHOTS=<folder> saves a light and a dark picture of each step. */
const { chromium } = require("playwright");
const http = require("node:http");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { randomInt } = require("node:crypto");
const { join, dirname } = require("node:path");
const { pathToFileURL } = require("node:url");
const os = require("node:os");

const ROOT = join(__dirname, "..", "..", "..");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };
const CODE = `STND-${randomInt(1000, 9999)}`;
let approved = false;

/* The stand-in device-code service: the three addresses src/chatgpt-auth.ts calls. */
function standIn() {
  const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; }).on("end", () => {
      const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      if (req.url === "/api/accounts/deviceauth/usercode") return send(200, { user_code: CODE, device_auth_id: "stand-in-device", interval: 1, expires_in: 600 });
      if (req.url === "/api/accounts/deviceauth/token") return approved ? send(200, { authorization_code: "stand-in-code", code_verifier: "stand-in-verifier" }) : send(403, {});
      if (req.url === "/oauth/token") return send(200, { access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "stand-in" } }), refresh_token: "stand-in-refresh", id_token: jwt({ email: "stand-in@localhost" }), expires_in: 3600 });
      send(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/* The stand-in claude: signed in when a "signed-in" file sits in its folder (its usual one, or CLAUDE_CONFIG_DIR). */
function fakeClaude(root) {
  const bin = join(root, "bin"), usual = join(root, "usual-home");
  mkdirSync(join(bin, "node_modules", "stand-in-claude"), { recursive: true });
  mkdirSync(usual, { recursive: true });
  const script = `const {existsSync}=require("node:fs");const {join}=require("node:path");const a=process.argv.slice(2).join(" ");
const home=process.env.CLAUDE_CONFIG_DIR||${JSON.stringify(usual)};
if(a==="auth status")process.exit(existsSync(join(home,"signed-in"))?0:1);
process.stdout.write(JSON.stringify({result:"stand-in answer"}));`;
  writeFileSync(join(bin, "node_modules", "stand-in-claude", "claude.js"), script);
  writeFileSync(join(bin, "claude.cmd"), `@ECHO off\r\nnode "%dp0%\\node_modules\\stand-in-claude\\claude.js" %*\r\n`);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec node "${join(bin, "node_modules", "stand-in-claude", "claude.js")}" "$@"\n`, { mode: 0o755 });
  return { bin, usual };
}

async function openWizard(page, pool = "") {
  if (!(await page.locator(".set-col h1").filter({ hasText: /Accounts/ }).count())) {
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setpage"][data-v="accounts"]').click();
  }
  await page.locator(`[data-act="addacct"]${pool ? `[data-v="${pool}"]` : ":not([data-v])"}`).first().click();
  await page.locator(".dlg").waitFor();
}
const dlgText = (page) => page.locator(".dlg").innerText();
/* SHOTS=<folder>: a light and a dark picture at each step, to look at the marks and the sign-in steps by eye. */
async function shot(page, name) {
  if (!process.env.SHOTS) return;
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(process.env.SHOTS, `accounts-plans-${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/* Setup's "Reach it anywhere" step draws the chat apps with the same marks. */
async function setupReach(page) {
  const banner = page.locator('.welcome10 [data-act="onboard"]');
  if (await banner.count()) await banner.first().click();
  else { // no banner on this window: the same action the message box's "Set up" button sends
    await page.evaluate(() => { const b = document.createElement("button"); b.type = "button"; b.dataset.act = "onboard"; b.id = "verify-onboard"; document.body.append(b); });
    await page.locator("#verify-onboard").dispatchEvent("click");
  }
  await page.locator(".ob9").waitFor();
  await page.locator(".ob-agree").click();
  await page.locator('.ob9 [data-act="ob-go"][data-v="5"]').click();
  await page.locator('.ob-ch12 .ch12[data-v="telegram"]').waitFor({ timeout: 15000 });
  await shot(page, "setup-reach");
  const tg = await page.locator('.ob-ch12 .ch12[data-v="telegram"] img[src="/art/channels/telegram.svg"]').count();
  await page.waitForFunction(() => [...document.querySelectorAll('.ob-ch12 img')].every((i) => i.complete));
  const mail = await page.locator('.ob-ch12 .ch12[data-v="email"] svg.i').count();
  check("Setup › Reach it anywhere: Telegram's own logo and Email's mail glyph", tg === 1 && mail === 1, `telegram ${tg}, email ${mail}`);
}

/* The engine started again on the same data folder: the connections the wizard made are all back. */
async function afterRestart(createBranch, temp, dataDir, chatgpt) {
  const again = await createBranch({ workspace: join(temp, "workspace"), dataDir, chatgpt });
  try {
    const ids = [...again.runtime.models.presets.keys()];
    check("after a restart on the same data folder: ChatGPT and Claude Code are both still connected",
      ids.some((id) => id.startsWith("chatgpt")) && ids.includes("cli-claude-code"), ids.filter((id) => id.startsWith("chatgpt") || id.startsWith("cli-")).slice(0, 3).join(", "));
  } finally { await again.close(); }
}

async function main() {
  const temp = mkdtempSync(join(os.tmpdir(), "verify-accounts-plans-"));
  const stub = await standIn();
  const STUB = `http://127.0.0.1:${stub.address().port}`;
  const claude = fakeClaude(temp);
  process.env.PATH = [claude.bin, dirname(process.execPath), join(process.env.SystemRoot || "C:\\Windows", "System32"), "/usr/bin", "/bin"].join(process.platform === "win32" ? ";" : ":");
  const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);
  const { createBranch, ChatGPTAuth, FileTokenVault } = await dist("index.js");
  const { startServer } = await dist("server.js");
  const { accountsServiceFor } = await dist("accounts/service.js");
  const dataDir = join(temp, "data");
  const chatgpt = new ChatGPTAuth(new FileTokenVault(join(temp, "chatgpt-auth.json")), { issuer: STUB, verificationUrl: `${STUB}/codex/device`, sleep: () => new Promise((r) => setTimeout(r, 300)) });
  const app = await createBranch({ workspace: join(temp, "workspace"), dataDir, chatgpt });
  accountsServiceFor(app.runtime.models).deps.fetchImpl = (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("https://auth.openai.com", STUB), init);
  const server = await startServer(app, { dataDir, port: Number(process.env.PORT || 0) });
  const api = async (p, body) => {
    const r = await fetch(new URL(`/api/${p}`, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
    return data;
  };
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const before = await api("accounts");
    check("fresh engine: several accounts per connection is off and no connection has a list", before.mode === "off" && before.pools.length === 0, `mode ${before.mode}, ${before.pools.length} lists`);
    const offered = await api("accounts/sign-ins");
    check("GET /api/accounts/sign-ins names ChatGPT and every coding assistant with the switch off", offered.chatgpt.available && offered.programs.length >= 4,
      offered.programs.map((p) => `${p.id}:${p.installed ? "installed" : "absent"}`).join(" "));

    const page = await browser.newPage({ viewport: { width: 1360, height: 950 }, serviceWorkers: "block" });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await chatgptFirst(page, api);
    await programFirst(page, api, claude);
    await geminiPaths(page);
    await extraChatGPT(page, api);
    await extraProgram(page, api);
    await marks(page, server);
    await setupReach(page);
    check("zero page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
    await server.close();
    await app.close();
  }
  try {
    await afterRestart(createBranch, temp, dataDir, new ChatGPTAuth(new FileTokenVault(join(temp, "chatgpt-auth.json")), { issuer: STUB }));
  } finally {
    stub.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

async function chatgptFirst(page, api) {
  await openWizard(page);
  await page.locator('[data-act="aa-grp"][data-v="plan"]').click();
  await shot(page, "plan-tab");
  const plans = await page.locator(".aa-list12 .prov b").allInnerTexts();
  check("Your plan shows ChatGPT, Claude and Gemini", ["ChatGPT", "Claude", "Gemini"].every((n) => plans.includes(n)), plans.join(", "));
  await page.locator('[data-act="aa-grp"][data-v="code"]').click();
  const code = await page.locator(".aa-list12 .prov b").allInnerTexts();
  check("Coding assistants shows every program the engine knows", code.length >= 4 && ["Claude Code", "Codex", "Gemini CLI", "GitHub Copilot CLI"].every((n) => code.includes(n)), code.join(", "));
  await page.locator('[data-act="aa-grp"][data-v="plan"]').click();
  await page.locator('[data-act="aa-plan"][data-v="chatgpt"]').click();
  check("ChatGPT's step shows the engine's terms line (unofficial)", /Unofficial/.test(await dlgText(page)));
  await page.locator('[data-act="aa-dev"]').click();
  await page.locator(".devcode14").waitFor();
  await shot(page, "device-code");
  const shown = await page.locator(".devcode14").innerText();
  const href = await page.locator(".aa-page a.btn").getAttribute("href");
  check("aa-dev: the engine's one-time code and its sign-in page are shown", shown === CODE && /^http:\/\/127\.0\.0\.1:\d+\/codex\/device$/.test(href ?? ""), `${shown} ${href}`);
  check("no password field anywhere in the sign-in", (await page.locator('.dlg input[type="password"]').count()) === 0);
  const offered = await api("accounts/sign-ins");
  check("GET /api/accounts/sign-ins says a sign-in is waiting but never carries its code", offered.chatgpt.pending === true && !JSON.stringify(offered).includes(CODE));
  approved = true; // the person approves on the sign-in page
  await page.locator(".dlg .pill.ok").waitFor({ timeout: 20000 });
  await shot(page, "chatgpt-connected");
  const status = await api("chatgpt/status"), lists = await api("accounts");
  check("ChatGPT connected: GET /api/chatgpt/status signed in and GET /api/accounts lists it", status.signedIn && lists.pools.some((p) => p.pool === "chatgpt"), `signedIn ${status.signedIn}`);
  check("a first sign-in leaves several accounts per connection off", lists.mode === "off", lists.mode);
  await page.locator('[data-act="aa-fin"]').click();
  await page.locator(".dlg").waitFor({ state: "detached" });
}

async function programFirst(page, api, claude) {
  await openWizard(page);
  await page.locator('[data-act="aa-grp"][data-v="code"]').click();
  await page.locator('.aa-list12 [data-act="aa-plan"][data-v="claude-code"]').click();
  await page.locator('.dlg [role="status"]').waitFor();
  const said = await page.locator('.dlg [role="status"]').innerText();
  await shot(page, "program-step");
  check("aa-plan on Claude Code: its status command says it is not signed in, in the engine's words", /is not signed in/.test(said) && (await page.locator('[data-act="aa-cli"]').count()) === 0, said);
  writeFileSync(join(claude.usual, "signed-in"), ""); // the person signs Claude Code in themselves
  await page.locator('[data-act="aa-chk"]').click();
  await page.locator('.dlg [role="status"]', { hasText: "is signed in" }).waitFor();
  check("aa-chk: checking again finds it signed in", true);
  await page.locator('[data-act="aa-cli"]').click();
  await page.locator(".dlg .pill.ok").waitFor({ timeout: 15000 });
  const lists = await api("accounts"), offered = await api("accounts/sign-ins");
  const pool = lists.pools.find((p) => p.pool === "cli-claude-code");
  check("aa-cli: Claude Code is a connection and GET /api/accounts lists it", !!pool && offered.programs.find((p) => p.id === "claude-code")?.connected, pool ? `${pool.accounts[0]?.label}` : "no list");
  check("still off after a program's first sign-in", lists.mode === "off", lists.mode);
  await page.locator('[data-act="aa-fin"]').click();
  await page.locator(".dlg").waitFor({ state: "detached" });
}

async function geminiPaths(page) {
  await openWizard(page);
  await page.locator('[data-act="aa-grp"][data-v="code"]').click();
  await page.locator('.aa-list12 [data-act="aa-plan"][data-v="gemini-cli"]').click();
  await page.locator('.dlg [role="status"]').waitFor();
  const said = await page.locator('.dlg [role="status"]').innerText();
  check("Gemini CLI absent: the engine's words say so and nothing is added", /is not on this computer/.test(said) && (await page.locator('[data-act="aa-cli"]').count()) === 0, said);
  await page.locator('[data-act="aa-back"]').click();
  await page.locator('[data-act="aa-grp"][data-v="key"]').click();
  await page.locator('[data-act="signin"][data-v="gemini"]').click();
  await page.locator("#aa-key").waitFor();
  check("Gemini with no Google client id: the key step, and no Google sign-in", (await page.locator('[data-act="aa-goo"]').count()) === 0);
  await page.locator('[data-act="aa-back"]').click();
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
}

async function extraChatGPT(page, api) {
  approved = true;
  await openWizard(page, "chatgpt");
  await page.locator('[data-act="aa-done"]').click();
  await page.locator(".devcode14").waitFor({ timeout: 15000 });
  check("aa-done on ChatGPT: the extra account signs in by its own code", (await page.locator(".devcode14").innerText()) === CODE);
  await page.locator(".dlg").waitFor({ state: "detached", timeout: 30000 });
  const pool = (await api("accounts")).pools.find((p) => p.pool === "chatgpt");
  const extra = pool.accounts.find((a) => a.id !== "primary");
  check("the extra ChatGPT account is signed in (GET /api/accounts)", !!extra && pool.signedIn?.[extra.id] === true, extra ? extra.label : "none");
}

async function extraProgram(page, api) {
  await openWizard(page, "cli-claude-code");
  await page.locator('[data-act="aa-done"]').click();
  await page.locator(".sigline14").waitFor({ timeout: 15000 });
  const line = await page.locator(".sigline14").innerText();
  const pool = (await api("accounts")).pools.find((p) => p.pool === "cli-claude-code");
  const extra = pool.accounts.find((a) => a.id !== "primary");
  check("aa-done on Claude Code: the engine's sign-in line for the account's own folder is shown", !!extra && line === extra.signInLine && /CLAUDE_CONFIG_DIR/.test(line), line);
  writeFileSync(join(extra.home, "signed-in"), ""); // the person runs that line and signs in
  await page.locator('[data-act="aa-chk"]').click();
  await page.locator(".dlg").waitFor({ state: "detached", timeout: 15000 });
  const said = await api("accounts/sign-ins/check", { id: "claude-code", account: extra.id });
  check("aa-chk: the extra Claude Code account is signed in (POST /api/accounts/sign-ins/check)", said.signedIn === true, said.message);
}

/* Every mark on screen loaded (a file the engine serves by exact name), and none is a broken image. */
const marksLoaded = (page, scope) => page.$$eval(`${scope} img[src^="/art/"]`, (imgs) => imgs.map((i) => [i.getAttribute("src"), i.complete && i.naturalWidth > 0]));

async function marks(page, server) {
  await openWizard(page);
  const src = (sel) => page.locator(`${sel} .logo img`).first().getAttribute("src").catch(() => "");
  const openai = await src('.aa-list12 [data-act="signin"][data-v="openai"]');
  const claude = await page.locator('.aa-list12 [data-v="cli-claude-code"]', { hasText: "Claude Code" }).locator(".logo img").first().getAttribute("src").catch(() => "");
  const github = await src('.aa-list12 [data-v="github-copilot"]');
  const azure = await page.locator('.aa-list12 [data-v="azure-openai"] .logo svg.i').count();
  const azureMark = await page.locator('.aa-list12 [data-v="azure-openai"] img').count();
  check("Add an account: OpenAI's, Claude Code's and GitHub's own marks; Azure OpenAI a neutral glyph (Microsoft allows no logo use)",
    openai === "/art/providers/openai.svg" && claude === "/art/providers/claudecode.svg" && github === "/art/providers/github.svg" && azure === 1 && azureMark === 0, `${openai} ${claude} ${github} azure-glyph ${azure}`);
  const loaded = await marksLoaded(page, ".aa-list12");
  check("every mark in Add an account loads", loaded.length > 20 && loaded.every(([, ok]) => ok), `${loaded.length} marks, broken: ${loaded.filter(([, ok]) => !ok).map(([s]) => s).join(" ")}`);
  const served = await page.request.get(new URL("/art/providers/openai.svg", server.url).href);
  check("a mark is served by exact file as an SVG", served.ok() && /svg/.test(served.headers()["content-type"] ?? ""));
  await page.locator('.dlg [data-act="dlg-close"]').first().click();
  await page.locator('#side [data-act="view"][data-v="customize"]').click();
  await page.locator('[data-act="ptab"][data-place="customize"][data-v="channels"]').first().click();
  await page.locator('.ch12[data-v="telegram"]').waitFor({ timeout: 15000 });
  await shot(page, "customize-channels");
  const at = (id) => page.locator(`.ch12[data-v="${id}"] .logo img`).first().getAttribute("src").catch(() => "");
  const [tg, discord, slack] = [await at("telegram"), await at("discord"), await at("slack")];
  const mail = await page.locator('.ch12[data-v="email"] svg.i').count();
  const imessage = await page.locator('.ch12[data-v="imessage"] svg.i').count();
  check("Customize › Channels: Telegram's, Discord's and Slack's own marks; Email and iMessage (Apple allows no icon use) a neutral glyph",
    tg === "/art/channels/telegram.svg" && discord === "/art/channels/discord.svg" && slack === "/art/channels/slack.svg" && mail === 1 && imessage === 1, `${tg} ${discord} ${slack} email ${mail} imessage ${imessage}`);
  const channelMarks = await marksLoaded(page, ".ch12");
  check("every chat-app mark loads", channelMarks.length > 20 && channelMarks.every(([, ok]) => ok), `${channelMarks.length} marks`);
}

main().catch((error) => { console.error(error); process.exit(1); });
