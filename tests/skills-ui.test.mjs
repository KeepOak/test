import test from 'node:test';
import { signIn, openPlace } from "./new-window-places.mjs";
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardTemp } from './temp-dir.mjs';
import { chromium } from 'playwright';
import { createBranch } from '../dist/index.js';
import { startServer } from '../dist/server.js';

/* Redesign: skills live in Customize › Tools › Skills (public/app/places/customize.js): the list, a skill's card with
   Remove, and "Add a skill" (public/app/flows/connectors.js), where "From a file" sends a SKILL.md to POST
   /api/skills/install. The prototype has no in-window SKILL.md editor, version picker or disable button; tests of those
   are skipped as replaced, and a later version is made through the engine's own routes. */
const document = (name, body) => `---\nname: ${name}\ndescription: Use this skill for local fixture checks.\nallowed-tools: files.read\n---\n\n${body}\n`;
async function fixture(t, provider = { name: 'skill-fixture', complete: async () => ({ content: 'Done', toolCalls: [] }) }) {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-skills-ui-'));
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider });
  const server = await startServer(app, { dataDir: join(root, 'data'), port: 0 });
  const httpCall = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await httpCall("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await signIn(page, server);
  await openPlace(page, 'customize', 'tools');
  await page.locator('#main .place [data-act="t9-kind"][data-v="skills"]').click();
  const api = async (path, body) => {
    const response = await fetch(new URL('/api/' + path, server.url), { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + server.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.ok, true); return response.json();
  };
  /* "Add a skill", then "From a file": the system picker takes the SKILL.md. */
  const importFile = async (file) => {
    await page.locator('#main .place [data-act="tool-add"][data-v="skills"]').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.dlg [data-act="sk-src"]').click();
    await (await chooser).setFiles(file);
  };
  return { page, api, errors, importFile };
}
async function settled(page) { await page.waitForFunction(() => !document.getElementById('skill-save').disabled); }
async function install(f, text = document('juniper', 'Version one body')) {
  await f.page.locator('#skill-document').fill(text); await f.page.locator('#skill-save').click(); await settled(f.page);
  return (await f.api('state')).skills[0];
}
async function view(f) { const [skill] = (await f.api('state')).skills; return f.api('skills/' + skill.id); }

test('single-file skill import, version editing, retained activation, disabling and removal', async t => {
  const f = await fixture(t), first = document('juniper', 'Version one body');
  await f.importFile({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(first) });
  await f.page.locator('.toast').filter({ hasText: 'Skill added.' }).waitFor();
  assert.equal((await view(f)).activeVersion, 1);
  const item = f.page.locator('#main .place .t9-item').filter({ hasText: 'juniper' });
  await item.waitFor();
  assert.equal(await item.getAttribute('aria-current'), 'true', 'the added skill is the one shown');
  // Redesign: replaced by the new window (prototype.html's skill card has no SKILL.md editor, version picker, "Use this
  // version" or disable button), so editing versions is not driven here.
  await f.page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.page.setViewportSize({ width: 1440, height: 1000 });
  await f.page.locator('#main .place [data-act="tool-rm"][data-k="skills"]').click();
  await f.page.locator('.toast').filter({ hasText: 'removed' }).waitFor();
  assert.equal((await f.api('state')).skills.length, 0);
  assert.deepEqual(f.errors, []);
});

test('invalid skill documents and oversized file imports leave saved skills unchanged', async t => {
  const f = await fixture(t);
  await f.importFile({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(document('juniper', 'Version one body')) });
  await f.page.locator('.toast').filter({ hasText: 'Skill added.' }).waitFor();
  const before = await view(f);
  // Each refusal is the engine's, shown in its words; nothing saved changes.
  const refusals = [Buffer.from('Missing YAML frontmatter'), Buffer.alloc(48 * 1024 + 1, 97), Buffer.from('a'.repeat(16001))];
  for (const buffer of refusals) {
    await f.page.evaluate(() => document.querySelector('.toast')?.remove());
    await f.importFile({ name: 'SKILL.md', mimeType: 'text/markdown', buffer });
    const said = await f.page.locator('.toast').innerText({ timeout: 15000 });
    assert.notEqual(said, 'Skill added.');
    assert.deepEqual(await view(f), before);
    await f.page.keyboard.press('Escape');
  }
  assert.deepEqual(await view(f), before); assert.deepEqual(f.errors, []);
});

test('a task discovers skill metadata and reads the selected active document through skills.read', async t => {
  let id, readDocument;
  const selected = document('juniper-selected', 'SELECTED_BODY_ONLY_AFTER_READ');
  const provider = { name: 'skill-reader-fixture', async complete(request) {
    const reply = request.messages.findLast(message => message.role === 'tool');
    if (reply) {
      const result = JSON.parse(reply.content).result;
      assert.equal(result.id, id); assert.equal(result.version, 2);
      readDocument = result.document;
      return { content: 'Selected skill instructions loaded.', toolCalls: [] };
    }
    const initial = JSON.stringify(request.messages);
    assert.match(initial, /juniper-selected/);
    assert.doesNotMatch(initial, /SELECTED_BODY_ONLY_AFTER_READ/);
    return { content: '', toolCalls: [{ id: 'read-selected', name: 'skills.read', arguments: JSON.stringify({ id, version: 2 }) }] };
  } };
  const f = await fixture(t, provider);
  await f.importFile({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(document('juniper', 'Version one body')) });
  await f.page.locator('.toast').filter({ hasText: 'Skill added.' }).waitFor();
  const skill = (await f.api('state')).skills[0]; id = skill.id;
  // Redesign: a second version is made and switched on through the engine's routes (no version editor in the new window).
  await f.api(`skills/${id}/update`, { expectedRevision: skill.revision, document: selected });
  const current = await f.api(`skills/${id}`);
  await f.api(`skills/${id}/activate`, { version: 2, expectedRevision: current.revision });
  await f.page.locator('#side [data-act="newmenu"]').click();
  await f.page.locator('.pop [data-act="newconv"]').click();
  await f.page.locator('#prompt').fill('Use the installed Juniper skill.');
  await f.page.locator('#send').click();
  await f.page.locator('#conversation').getByText('Selected skill instructions loaded.').waitFor({ timeout: 30000 });
  assert.equal(readDocument, selected);
  assert.match(await f.page.locator('#conversation').innerText(), /Selected skill instructions loaded/);
  assert.deepEqual(f.errors, []);
});
