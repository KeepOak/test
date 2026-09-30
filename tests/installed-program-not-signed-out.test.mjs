/**
 * QA retest 2026-09-28, pass 2: Add an account listed Claude Code as "Not signed in · your plan" while it was installed
 * and signed in on this computer; choosing it connected at once. The list never asks a program about its sign-in (that
 * happens once it is chosen), so an installed program now says it is on this computer, and only one that is not
 * installed says so. Node only: the real dist/ and public/, a stand-in `claude` program on PATH, headless Chromium.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { newWindow } from "./new-window-places.mjs";
import { openSettingsPage } from "./settings-window.mjs";
import { discardTemp } from "./temp-dir.mjs";

test("an installed coding program is listed as on this computer, not as signed out", async (t) => {
  const bin = await mkdtemp(join(tmpdir(), "branch-fake-claude-"));
  const fake = join(bin, process.platform === "win32" ? "claude.cmd" : "claude");
  await writeFile(fake, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
  if (process.platform !== "win32") await chmod(fake, 0o755);
  const path = process.env.PATH;
  process.env.PATH = bin; // only the stand-in: no other coding program is on this PATH
  t.after(async () => { process.env.PATH = path; await discardTemp(bin); });
  const { page, errors } = await newWindow(t);
  await openSettingsPage(page, "models");
  await page.locator(".set-col").getByRole("button", { name: "Add an account" }).click();
  const dialog = page.locator(".dlg").last();
  const card = (name) => dialog.locator("button, .way, [data-act]").filter({ has: page.getByText(name, { exact: true }) }).first();
  await card("Claude Code").waitFor();
  assert.match(await card("Claude Code").innerText(), /On this computer · your plan/);
  assert.doesNotMatch(await card("Claude Code").innerText(), /Not signed in/);
  assert.match(await card("Codex").innerText(), /Not on this computer/, "a program that is not installed says so");
  assert.deepEqual(errors, []);
});
