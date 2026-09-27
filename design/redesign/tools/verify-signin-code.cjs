/* A coding assistant's sign-in finished by hand, in the real window: Add an account › Claude › Sign in, the maker's page
   shown as a link, the code that page shows pasted and sent (aa-code), and the connection added once the program says
   signed in.

   Like verify-accounts-plans.cjs this starts its OWN engine in this process on a new temp data folder, with PATH cut
   down to a stand-in "claude" (an npm-style claude.cmd launcher on Windows), Node and the system folder, so no real
   coding assistant is found or started and nothing reaches Anthropic. The stand-in's `claude auth status` exits 0 once a
   "signed-in" file is in its folder; its `claude auth login` prints the sign-in page's address as a terminal link, then
   reads one line and, when it is the expected code, writes that file and exits 0.
     npx tsc -p . && node design/redesign/tools/verify-signin-code.cjs        (PORT=<free port> to pick the port;
   SHOTS=<folder> saves a picture of the sign-in step) */
const { chromium } = require("playwright");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { pathToFileURL } = require("node:url");
const os = require("node:os");

const ROOT = join(__dirname, "..", "..", "..");
const PAGE = "https://claude.com/cai/oauth/authorize?code=true&client_id=stand-in&state=stand-in";
const CODE = "stand-in-code#stand-in-state";
const results = [];
const check = (name, ok, detail = "") => { results.push({ ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

function fakeClaude(root) {
  const bin = join(root, "bin"), home = join(root, "home");
  mkdirSync(join(bin, "node_modules", "stand-in-claude"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const script = `const fs=require("node:fs"),{join}=require("node:path");const a=process.argv.slice(2).join(" ");
const home=${JSON.stringify(home)};
if(a==="auth status")process.exit(fs.existsSync(join(home,"signed-in"))?0:1);
if(a==="auth login"){
  process.stdout.write("Opening browser to sign in\\u2026\\n");
  process.stdout.write("If the browser didn't open, visit: \\x1b]8;;"+${JSON.stringify(PAGE)}+"\\x07"+${JSON.stringify(PAGE)}+"\\x1b]8;;\\x07\\n");
  process.stdout.write("Paste code here if prompted > ");
  require("node:readline").createInterface({input:process.stdin}).on("line",(l)=>{fs.writeFileSync(join(home,"got.txt"),l);if(l===${JSON.stringify(CODE)}){fs.writeFileSync(join(home,"signed-in"),"");process.exit(0);}process.exit(3);});
} else process.stdout.write(JSON.stringify({result:"stand-in answer"}));`;
  writeFileSync(join(bin, "node_modules", "stand-in-claude", "claude.js"), script);
  writeFileSync(join(bin, "claude.cmd"), `@ECHO off\r\nnode "%dp0%\\node_modules\\stand-in-claude\\claude.js" %*\r\n`);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec node "${join(bin, "node_modules", "stand-in-claude", "claude.js")}" "$@"\n`, { mode: 0o755 });
  return { bin, home };
}

async function main() {
  const temp = mkdtempSync(join(os.tmpdir(), "verify-signin-code-"));
  const claude = fakeClaude(temp);
  process.env.PATH = [claude.bin, dirname(process.execPath), join(process.env.SystemRoot || "C:\\Windows", "System32"), "/usr/bin", "/bin"].join(process.platform === "win32" ? ";" : ":");
  const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);
  const { createBranch } = await dist("index.js");
  const { startServer } = await dist("server.js");
  const dataDir = join(temp, "data");
  const app = await createBranch({ workspace: join(temp, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: Number(process.env.PORT || 0) });
  const api = async (p) => (await fetch(new URL(`/api/${p}`, server.url), { headers: { authorization: `Bearer ${server.token}` } })).json();
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 950 }, serviceWorkers: "block" });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    // Setup opens by itself on a fresh engine; it is closed to reach Settings.
    if (await page.locator(".ob9").waitFor({ timeout: 8000 }).then(() => true, () => false)) {
      await page.locator("label.ob-agree").click();
      await page.locator('.ob9 [data-act="ob-next"]').first().click();
      await page.locator('.ob9 [data-act="ob-close"]').first().click();
      await page.locator(".ob9").waitFor({ state: "detached", timeout: 8000 });
    }
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setpage"][data-v="accounts"]').click();
    await page.locator('[data-act="addacct"]:not([data-v])').first().click();
    await page.locator('[data-act="aa-grp"][data-v="plan"]').click();
    await page.locator('[data-act="aa-plan"][data-v="claude-code"]').click();
    await page.locator('[data-act="aa-psi"]').click();
    const link = page.locator('.dlg a.btn[href^="https://"]');
    await link.waitFor({ timeout: 20000 });
    check("aa-psi: the maker's sign-in page is shown as a link while the sign-in runs", (await link.getAttribute("href")) === PAGE, await link.getAttribute("href"));
    const box = page.locator("#aa-code");
    await box.fill(CODE);
    if (process.env.SHOTS) await page.locator(".dlg").screenshot({ path: join(process.env.SHOTS, "signin-code.png") });
    await page.waitForTimeout(3500); // one status poll passes: the typed code must still be there
    check("the code box keeps what is typed across the status polls", (await box.inputValue()) === CODE);
    await page.locator('[data-act="aa-code"]').click();
    const until = Date.now() + 30000;
    let offered = null;
    while (Date.now() < until) {
      offered = await api("accounts/sign-ins");
      if (offered.programs?.find((p) => p.id === "claude-code")?.connected) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const got = existsSync(join(claude.home, "got.txt")) ? readFileSync(join(claude.home, "got.txt"), "utf8") : "";
    check("aa-code: the pasted code reached the program's sign-in as one line", got === CODE, got);
    check("signed in: GET /api/accounts/sign-ins says Claude Code is connected", offered?.programs?.find((p) => p.id === "claude-code")?.connected === true);
    check("zero page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
    await server.close();
    await app.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
