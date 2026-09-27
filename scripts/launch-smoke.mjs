/**
 * The release's launch check: starts one packaged or installed Branch, with a fresh home of its own,
 * and passes only when its window has loaded and says it is connected to its engine.
 *
 *   node scripts/launch-smoke.mjs <path to the program>
 *
 * Nothing of the person running it is used: the window's own folder, the data folder and the workspace
 * are all made new under the temporary folder (tests/fixtures/desktop-options.mjs). Linux build
 * machines have no screen, so there it runs under xvfb-run.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron } from "playwright";
import { connected, desktopOptions } from "../tests/fixtures/desktop-options.mjs";

export async function launchSmoke(executable) {
  process.env.BRANCH_PACKAGED_EXECUTABLE = executable;
  const { home, options } = await desktopOptions();
  const started = Date.now();
  const electron = await _electron.launch(options);
  try {
    const page = await electron.firstWindow({ timeout: options.timeout });
    await connected(page);
    const title = await page.title();
    if (!/^Branch/.test(title)) throw new Error(`The window loaded something else: "${title}".`);
    const sandbox = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox);
    if (sandbox !== true) throw new Error("The window is not sandboxed.");
    console.log(`Launch smoke passed: "${title}" loaded and connected in ${Math.round((Date.now() - started) / 1000)} s (home ${home}).`);
  } finally {
    await electron.close().catch(() => electron.process().kill());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const executable = process.argv[2];
  if (!executable) {
    console.error("Usage: node scripts/launch-smoke.mjs <path to the program>");
    process.exit(2);
  }
  await launchSmoke(resolve(executable)).catch((error) => {
    console.error(`Launch smoke failed: ${error.message}`);
    process.exit(1);
  });
}
