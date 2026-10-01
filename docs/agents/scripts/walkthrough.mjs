// Self-check of a packaged build: launch a staged copy with its own home, open every place, tab and settings page,
// screenshot each one, and collect browser console errors. Usage: node walkthrough.tmp.mjs <installDir> <outDir>
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [install, outDir] = process.argv.slice(2);
const home = join(outDir, "home"), port = 9411;
await rm(home, { recursive: true, force: true }); await mkdir(home, { recursive: true });
const child = spawn(join(install, "Branch Agent.exe"), [`--remote-debugging-port=${port}`], { detached: true, stdio: "ignore", env: { ...process.env, BRANCH_DESKTOP_HOME: home } });
child.unref();
let browser;
for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await delay(1000); } }
if (!browser) { console.log("could not connect"); process.exit(1); }
const page = browser.contexts()[0].pages().find((p) => /127\.0\.0\.1/.test(p.url())) ?? browser.contexts()[0].pages()[0];
page.setDefaultTimeout(20000);
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.getByText("Connected", { exact: true }).waitFor();
await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
const report = [];
const shot = async (name) => { const file = join(outDir, `${name}.png`); await page.screenshot({ path: file, fullPage: false }); report.push({ name, file, errorsSoFar: errors.length }); };
await shot("01-home");
// Every place and tab in the sidebar, then every Settings page (the wave 9 layout, public/layout.js).
const views = [];
for (const place of await page.$$eval(".lx-place-link", (els) => els.map((e) => e.dataset.place))) {
  await page.locator(`.lx-place-link[data-place="${place}"]`).click(); await delay(400);
  for (const tab of await page.$$eval(`.lx-tab[data-place="${place}"]`, (els) => els.map((e) => e.dataset.tab))) {
    await page.locator(`.lx-tab[data-place="${place}"][data-tab="${tab}"]`).click(); await delay(700);
    views.push(`${place}:${tab}`);
    await shot(`10-${place}-${tab}`);
  }
}
await page.locator(".lx-gear").click();
for (const name of await page.$$eval(".lx-settings-link", (els) => els.map((e) => e.dataset.page))) {
  await page.locator(`.lx-settings-link[data-page="${name}"]`).click(); await delay(700);
  views.push(`settings:${name}`);
  await shot(`20-settings-${name}`);
}
await page.locator(".lx-settings-close").click();
// Settings sub-areas that shipped recently: sharing, voice, provider dropdown
for (const id of ["mcp-card", "voice-settings-form", "voice-live-vad", "provider-preset", "documents", "usage"]) {
  const el = page.locator(`#${id}`).first();
  const present = await el.count();
  report.push({ check: id, present: present > 0, visible: present ? await el.isVisible().catch(() => false) : false });
}
await writeFile(join(outDir, "report.json"), JSON.stringify({ views, errors, report }, null, 2));
console.log("views:", views.join(", "));
console.log("console errors:", errors.length, errors.slice(0, 10));
console.log("checks:", JSON.stringify(report.filter((r) => r.check)));
try { await browser.close(); } catch {}
// The path is written with single backslashes: doubling them made the -like match nothing, so
// every walked copy stayed running and a later test borrowed its debugging port by mistake.
const staged = install.replace(/\//g, "\\");
const left = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${staged}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 800; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${staged}*' }).Count"`).toString().trim();
console.log("walked copies left running:", left);
process.exit(0);
