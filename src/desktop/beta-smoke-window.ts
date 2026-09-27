/**
 * The new version's side of the Beta try-out (beta-smoke.ts): started by the running version as
 * `<new program> --branch-smoke=<report>`, it starts its own engine on a fresh folder beside the report (never the
 * owner's data), with the stand-in model, opens its own window hidden, on a session kept in memory only, walks the
 * try-out's steps in it, writes the report and quits. Nothing here reads or writes the owner's folders.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BrowserWindow } from "electron";
import { createBranch } from "../index.js";
import { defaultPreset } from "../providers.js";
import { startServer } from "../server.js";
import { saveOnboarding } from "../onboarding.js";
import { SmokeReportSchema, SmokeStandIn, smokeWindow, type SmokePage, type SmokeReport } from "./beta-smoke.js";

/** A hidden window as a page to drive; an uncaught error, a crash or a failed load is a page error. */
function hiddenPage(): { page: SmokePage; close: () => void } {
  const window = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { partition: `try-out-${randomUUID()}`, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const errors: string[] = [], contents = window.webContents;
  contents.on("console-message", (event) => {
    if (event.level === "error" && /^Uncaught\b/.test(event.message)) errors.push(event.message);
  });
  contents.on("render-process-gone", (_event, details) => errors.push(`the window stopped: ${details.reason}`));
  contents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) errors.push(`the page did not load: ${description}`); // -3: replaced by the next load
  });
  const page: SmokePage = {
    goto: async (url) => { await contents.loadURL(url).catch((error: { code?: string }) => { if (error.code !== "ERR_ABORTED") throw error; }); },
    run: (script) => contents.executeJavaScript(script),
    errors: () => [...errors],
  };
  return { page, close: () => { if (!window.isDestroyed()) window.destroy(); } };
}

/** Walks the try-out and writes its report beside `reportPath`; answers the exit code. */
export async function smokeMode(reportPath: string, version: string): Promise<number> {
  const folder = dirname(reportPath), steps: SmokeReport["steps"] = [];
  let app: Awaited<ReturnType<typeof createBranch>> | null = null, server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    try {
      await mkdir(join(folder, "data"), { recursive: true, mode: 0o700 });
      app = await createBranch({ dataDir: join(folder, "data"), workspace: join(folder, "workspace"), presets: [defaultPreset(new SmokeStandIn())] });
      saveOnboarding(app.store, app.runtime.owner, { done: true });
      server = await startServer(app, { dataDir: join(folder, "data"), port: 0 });
      steps.push({ step: "engine", ok: true, detail: `version ${app.version} answered on its own address` });
    } catch (error) {
      steps.push({ step: "engine", ok: false, detail: (error instanceof Error ? error.message : String(error)).slice(0, 400) });
    }
    if (server) {
      const { page, close } = hiddenPage();
      try { steps.push(...await smokeWindow(page, { url: server.url, token: server.token })); } finally { close(); }
    }
  } finally {
    await server?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
  }
  const report = SmokeReportSchema.parse({ ok: steps.length > 1 && steps.every((one) => one.ok), version, steps });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  return report.ok ? 0 : 1;
}
