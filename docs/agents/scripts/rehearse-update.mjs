// End-to-end rehearsal of the button update on a staged copy of the installed app.
// The app is launched the normal way (detached, not under Playwright) so its hand-over script
// survives the app's exit exactly as it does for a person; the window is driven over CDP.
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const stage = "C:/Users/bishi/AppData/Local/Temp/claude-session-files/branch-update-rehearsal";
const install = join(stage, "install"), home = join(stage, "home"), port = 9391;
await rm(home, { recursive: true, force: true }); await mkdir(home, { recursive: true });
const version = async () => JSON.parse(await readFile(join(install, "resources/app/package.json"), "utf8")).version;
const before = await version(); console.log("before:", before);
const child = spawn(join(install, "Branch Agent.exe"), [`--remote-debugging-port=${port}`], { detached: true, stdio: "ignore", env: { ...process.env, BRANCH_DESKTOP_HOME: home } });
child.unref();
const pid = child.pid;
console.log("launched pid", pid);
let browser;
for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await delay(1000); } }
if (!browser) { console.log("could not connect over CDP"); process.exit(1); }
const page = browser.contexts()[0].pages().find((p) => /127\.0\.0\.1/.test(p.url())) ?? browser.contexts()[0].pages()[0];
page.setDefaultTimeout(30000);
await page.getByText("Connected", { exact: true }).waitFor();
await page.getByRole("button", { name: "Settings", exact: true }).click();
await page.getByRole("button", { name: "Check for updates", exact: true }).click();
await page.locator("#updates-status").filter({ hasText: /is ready to install/ }).waitFor({ timeout: 30000 });
console.log("status:", await page.locator("#updates-status").innerText());
const started = Date.now();
await page.getByRole("button", { name: "Update and restart", exact: true }).click();
await page.locator("#update-screen:not([hidden])").waitFor();
console.log("updating screen shown");
let lastStage = "";
while (Date.now() - started < 10 * 60 * 1000) {
  let stageText = "";
  try { stageText = (await page.locator("#update-stage").innerText({ timeout: 2000 })) + " | " + (await page.locator("#update-detail").innerText({ timeout: 2000 })); } catch { break; }
  if (stageText !== lastStage) { console.log(`[${Math.round((Date.now() - started) / 1000)}s]`, stageText); lastStage = stageText; }
  await delay(1000);
}
console.log("window gone after", Math.round((Date.now() - started) / 1000), "s; waiting for the hand-over");
try { await browser.close(); } catch { /* the app is gone */ }
const consoleWindows = () => { try { return execSync(`powershell -NoProfile -Command "(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -in @('cmd','find','tasklist','robocopy','WindowsTerminal','conhost','OpenConsole') }).Count"`, { encoding: "utf8" }).trim(); } catch { return "?"; } };
let maxConsoles = 0;
const baseConsoles = Number(consoleWindows()) || 0;
const alive = (p) => { try { return execSync(`tasklist /FI "PID eq ${p}" /NH /FO CSV`, { encoding: "utf8" }).includes(`"${p}"`); } catch { return false; } };
for (let i = 0; i < 90 && alive(pid); i++) { maxConsoles = Math.max(maxConsoles, Number(consoleWindows()) || 0); await delay(1000); }
console.log("old process alive:", alive(pid));
for (let i = 0; i < 120; i++) { maxConsoles = Math.max(maxConsoles, Number(consoleWindows()) || 0); if ((await version()) !== before) break; await delay(1000); }
console.log("new visible console windows during the update:", Math.max(0, maxConsoles - baseConsoles), "(baseline", baseConsoles + ")");
console.log("after:", await version(), "at", Math.round((Date.now() - started) / 1000), "s");
await delay(30000);
const staged = install.replace(/\//g, "\\\\");
const mine = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${staged}*' }).Count"`, { encoding: "utf8" }).trim();
console.log("rehearsal app processes running from the staged folder:", mine);
console.log(await readFile(join(process.env.TEMP, "branch-agent-update", "apply-update.log"), "utf8").catch(() => "(no log)"));
execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${staged}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore" });
console.log("rehearsal processes stopped");
process.exit(0);
