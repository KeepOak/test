/** The phone page in a headless browser: all Telegram and desktop calls are stand-ins. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const id = '00000000-0000-4000-8000-000000000001', key = 'x'.repeat(43), inputFrame = 'f'.repeat(32);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
async function page(t, answers = {}) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://stand-in').pathname;
    if (!['/chat-screen', '/chat-screen.js', '/chat-screen.css'].includes(path)) { response.writeHead(404).end(); return; }
    const name = path === '/chat-screen' ? 'chat-screen.html' : path.slice(1);
    response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(await readFile(new URL(`../public/${name}`, import.meta.url)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true }); const tab = await browser.newPage();
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const calls = []; let owner = false;
  await tab.addInitScript(() => { window.Telegram = { WebApp: { initData: 'signed-proof', initDataUnsafe: { user: { language_code: 'en' } }, ready() {}, expand() {} } }; });
  await tab.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
  await tab.route('**/api/chat-screen/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1), body = route.request().postDataJSON(); calls.push({ name, body });
    if (name === 'control') owner = body.owner;
    const result = await (answers[name]?.(body) ?? {
      targets: { targets: [{ id: 'a'.repeat(32), label: 'Notes' }] }, start: { key, expires: Date.now() + 300000 },
      frame: { frame: png, type: 'image/png', width: 1, height: 1, control: owner ? 'owner' : 'agent', inputFrame },
      control: { ok: true }, action: { ok: true }, stop: { stopped: true },
    }[name]);
    await route.fulfill({ status: result?.status ?? 200, contentType: 'application/json', body: JSON.stringify(result?.body ?? result) });
  });
  await tab.goto(`http://127.0.0.1:${server.address().port}/chat-screen?request=${id}`);
  return { tab, calls };
}
test('owner can confirm, select opaque window, watch, take over, act using one displayed frame and stop', async t => {
  const { tab, calls } = await page(t);
  await tab.locator('#pin').fill('1234'); await tab.locator('#find').click();
  await tab.locator('#choose:not([hidden])').waitFor();
  await tab.locator('#start').click(); await tab.locator('#view:not([hidden])').waitFor();
  await tab.locator('#take').click(); await tab.locator('#input:not(:disabled)').waitFor();
  await tab.waitForFunction(() => !document.getElementById('input').disabled);
  await tab.locator('#text').fill('hello'); await tab.locator('#type').click();
  await tab.waitForFunction(() => document.getElementById('text').value === '');
  await tab.locator('#stop').click(); await tab.waitForFunction(() => document.getElementById('stop').disabled);
  assert.deepEqual(calls.find(c => c.name === 'targets').body, { request: id, initData: 'signed-proof', pin: '1234' });
  assert.deepEqual(calls.find(c => c.name === 'start').body, { request: id, initData: 'signed-proof', target: 'a'.repeat(32) });
  assert.deepEqual(calls.find(c => c.name === 'action').body, { key, inputFrame, action: { action: 'type', text: 'hello', window: 'Notes' } });
  assert.equal(calls.find(c => c.name === 'stop').body.key, key);
  assert.equal(await tab.evaluate(() => sessionStorage.length + localStorage.length), 0);
  assert.doesNotMatch(tab.url(), /signed-proof|xxxxxxxx/);
});
test('Stop before a key sends only signed pending identity and discards late target enumeration', async t => {
  let release; const hold = new Promise(resolve => release = resolve);
  const { tab, calls } = await page(t, { targets: async () => { await hold; return { targets: [{ id: 'a'.repeat(32), label: 'Late' }] }; } });
  await tab.locator('#find').click({ noWaitAfter: true });
  await tab.waitForFunction(() => document.getElementById('find').disabled);
  await tab.locator('#stop').click(); release();
  await tab.waitForFunction(() => document.getElementById('stop').disabled);
  assert.deepEqual(calls.find(c => c.name === 'stop').body, { request: id, initData: 'signed-proof' });
  assert.equal(await tab.locator('#choose').isVisible(), false);
});
test('hidden phone page stops session and clears controls before the network replies', async t => {
  const { tab, calls } = await page(t);
  await tab.locator('#find').click(); await tab.locator('#start').click(); await tab.locator('#view:not([hidden])').waitFor();
  await tab.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await tab.locator('#stop').isDisabled(), true); assert.equal(await tab.locator('#take').isDisabled(), true);
  assert.equal(await tab.locator('#input').evaluate(node => node.disabled), true);
  assert.equal(calls.find(c => c.name === 'stop').body.key, key);
});
