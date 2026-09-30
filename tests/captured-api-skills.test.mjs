import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createBranch, NetworkPolicy, ToolRegistry } from '../dist/index.js';
import { SkillPackages } from '../dist/skill-packages.js';
import { CapturedApiSkills } from '../dist/captured-api-skills.js';
import { BrowserNetworkCapture, requestShape } from '../dist/browser-network-capture.js';
import { CapturedApiSkillsApi } from '../dist/captured-api-skills-api.js';
import { BrowserControls } from '../dist/browser-control.js';
import { requireBrowserOwner } from '../dist/browser-control-api.js';
import { addPolicyRule } from '../dist/policy.js';
import { discardTemp } from './temp-dir.mjs';

async function harness(t) {
  const base = process.env.TEMP ?? tmpdir(); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'branch-api-learning-'));
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'data'), web: { allowPrivateAddresses: true },
    provider: { name: 'fixture', complete: async () => ({ content: 'done', toolCalls: [] }) } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
async function fixture(t) {
  const hits = [];
  const server = createServer((request, response) => {
    hits.push({ method: request.method, url: request.url });
    if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<button onclick="fetch(\'/api/weather?town=private-observed-value\')">Weather</button>'); return; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ result: 'sunny', private: 'not-selected' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
}
function learning(app) {
  const registry = new ToolRegistry(), policy = new NetworkPolicy({ allowPrivateAddresses: true });
  const host = { store: app.store, policy, fetchImpl: policy.guard(globalThis.fetch) };
  const packages = new SkillPackages(app.store, app.runtime.owner, registry, host);
  return { registry, packages, host, skills: new CapturedApiSkills(app.store, app.runtime.owner, host, packages) };
}
const options = { name: 'learned-weather', description: 'Read weather from the selected API.', pick: ['result'] };
const context = app => app.runtime.context({ permissions: ['skills.http'] });
const shape = origin => ({ id: 'observed', origin, path: '/api/weather', method: 'GET', query: ['town'], body: [], needsCredentials: false, unsupported: null });

test('selected real browser request becomes a tested installed HTTP skill that runs after the browser closes', async t => {
  const app = await harness(t), server = await fixture(t), { skills, packages, registry } = learning(app);
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(server.origin);
  const capture = new BrowserNetworkCapture(page, { origin: server.origin, path: '/api/weather', method: 'GET', seconds: 30 }, () => {});
  const response = page.waitForResponse(response => response.url().includes('/api/weather'));
  await page.getByRole('button', { name: 'Weather' }).click(); await response;
  capture.stop(); const captured = capture.view().requests;
  assert.equal(captured.length, 1); assert.doesNotMatch(JSON.stringify(captured), /private-observed-value|not-selected/);
  const draft = skills.create(captured[0], options);
  assert.throws(() => skills.install(draft.id, draft.revision), /Test this exact/);
  const tested = await skills.test(draft.id, { arguments: { q_town: 'London' }, expected: { result: 'sunny' }, confirm: true }, context(app), () => {});
  assert.equal(tested.passed, true);
  const installed = skills.install(draft.id, draft.revision); assert.equal(installed.installed, true);
  assert.equal(installed.skill.activeVersion, null); assert.equal(packages.list()[0].enabled, false);
  await assert.rejects(registry.execute('skill.learned-weather.call', { q_town: 'Paris' }, context(app)), /switched off/);
  app.store.skills.activate(app.runtime.owner, installed.skill.id, { expectedRevision: installed.skill.revision, version: 1 });
  await browser.close();
  const answer = await registry.execute('skill.learned-weather.call', { q_town: 'Paris' }, context(app));
  assert.deepEqual(answer, { status: 200, data: { result: 'sunny' } });
  assert.equal(server.hits.at(-1).url, '/api/weather?town=Paris');
});

test('edits, unsuccessful tests, policy refusal and revoked authority cannot produce installable proof', async t => {
  const app = await harness(t), server = await fixture(t), { skills } = learning(app);
  const draft = skills.create(shape(server.origin), options), testInput = { arguments: { q_town: 'London' }, expected: { result: 'sunny' }, confirm: true };
  await skills.test(draft.id, testInput, context(app), () => {});
  skills.edit(draft.id, { ...options, description: 'Updated wording' });
  assert.throws(() => skills.install(draft.id, draft.revision), /Test this exact/);
  const failed = await skills.test(draft.id, { ...testInput, expected: { result: 'rain' } }, context(app), () => {});
  assert.equal(failed.passed, false); assert.equal(skills.view(draft.id).proof, null);
  await assert.rejects(skills.test(draft.id, testInput, context(app), () => { throw new Error('revoked'); }), /revoked/);
  addPolicyRule(app.store, app.runtime.owner, { tool: '*', match: '*', decision: 'deny', resource: { kind: 'host', pattern: '127.0.0.1' } });
  const before = server.hits.length;
  await assert.rejects(skills.test(draft.id, testInput, context(app), () => {}), /policy/);
  assert.equal(server.hits.length, before);
});

test('POST requires exact side-effect authorization and never treats browser authentication as reusable', async t => {
  const app = await harness(t), server = await fixture(t), { skills } = learning(app);
  assert.throws(() => skills.create({ ...shape(server.origin), needsCredentials: true }, options), /saved API credential/);
  const draft = skills.create({ ...shape(server.origin), method: 'POST', query: [], body: ['town'] }, options);
  const input = { arguments: { b_town: 'London' }, expected: { result: 'sunny' }, confirm: true };
  await assert.rejects(skills.test(draft.id, input, context(app), () => {}), /exact POST/);
  await assert.rejects(skills.test(draft.id, { ...input, arguments: { b_town: 'Paris' }, confirmMutation: skills.mutationPhrase(draft.id, input.arguments) }, context(app), () => {}), /exact POST/);
  assert.equal(server.hits.length, 0);
  const result = await skills.test(draft.id, { ...input, confirmMutation: skills.mutationPhrase(draft.id, input.arguments) }, context(app), () => {});
  assert.equal(result.passed, true); assert.equal(server.hits[0].method, 'POST');
});

test('a second concurrent test cannot duplicate a pending API side effect', async t => {
  const app = await harness(t), server = await fixture(t), { skills, host } = learning(app);
  const draft = skills.create(shape(server.origin), options);
  const input = { arguments: { q_town: 'London' }, expected: { result: 'sunny' }, confirm: true };
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const fetcher = host.fetchImpl;
  host.fetchImpl = async (...args) => { entered(); await held; return fetcher(...args); };
  const first = skills.test(draft.id, input, context(app), () => {});
  await started;
  try { await assert.rejects(skills.test(draft.id, input, context(app), () => {}), /already being tested/); }
  finally { release(); }
  assert.equal((await first).passed, true); assert.equal(server.hits.length, 1);
});

const fakeRequest = (url, body = null, method = 'GET') => ({ url: () => url, resourceType: () => 'xhr', method: () => method,
  headers: () => ({ authorization: 'Bearer RAW-SECRET', cookie: 'RAW-COOKIE', 'content-type': 'application/json' }), postData: () => body });
test('capture rejects secret fields, nested bodies, duplicate query keys and non-selected traffic without retaining values', () => {
  const options = { origin: 'https://example.com', path: '/api', method: 'GET', seconds: 5 };
  for (const query of ['token=RAW-SECRET', 'town=one&town=two', 'password=RAW-SECRET']) {
    const got = requestShape(fakeRequest(`https://example.com/api?${query}`), options);
    assert.ok(got.unsupported); assert.doesNotMatch(JSON.stringify(got), /RAW-SECRET|RAW-COOKIE/);
  }
  assert.equal(requestShape(fakeRequest('https://other.com/api?town=secret'), options), null);
  const got = requestShape(fakeRequest('https://example.com/api', '{"town":{"password":"RAW-SECRET"}}', 'POST'), { ...options, method: 'POST' });
  assert.ok(got.unsupported); assert.deepEqual(got.body, []);
});

test('capture detaches on control revocation and caps selected requests', () => {
  const page = new EventEmitter(), frame = {}; page.mainFrame = () => frame;
  let allowed = true;
  const capture = new BrowserNetworkCapture(page, { origin: 'https://example.com', path: '/api', method: 'GET', seconds: 5 }, () => { if (!allowed) throw new Error('revoked'); });
  const request = { ...fakeRequest('https://example.com/api?town=x'), frame: () => frame };
  for (let i = 0; i < 25; i++) page.emit('request', request);
  assert.equal(capture.view().requests.length, 20); assert.equal(page.listenerCount('request'), 0);
  const second = new BrowserNetworkCapture(page, { origin: 'https://example.com', path: '/api', method: 'GET', seconds: 5 }, () => { if (!allowed) throw new Error('revoked'); });
  allowed = false; page.emit('request', request);
  assert.equal(page.listenerCount('request'), 0); assert.throws(() => second.view(), /revoked/);
});

test('owner API binds capture to the live conversation, client, epoch and selected tab', async t => {
  const app = await harness(t), server = await fixture(t), controls = new BrowserControls(), clientId = randomUUID();
  const sessionId = app.store.createSession(app.runtime.owner), binding = { owner: app.runtime.owner, conversation: sessionId, profile: null };
  const control = controls.ensure(binding, clientId), tabId = control.view().tabs[0], page = new EventEmitter(), frame = {};
  page.mainFrame = () => frame;
  app.browser = { controls, controlledPageTarget: (_binding, id, tab) => id === control.id && tab === tabId ? { page, url: 'https://example.com' } : null };
  const api = new CapturedApiSkillsApi(app); t.after(() => { api.close(); app.browser = null; });
  let fullKey = true;
  const access = { signal: new AbortController().signal, authorize: () => requireBrowserOwner(app, fullKey, false) };
  const input = { sessionId, clientId, profile: null, id: control.id, epoch: control.view().epoch, tabId,
    operation: 'start', options: { origin: server.origin, path: '/api', method: 'GET', seconds: 5 } };
  await assert.rejects(api.handle({ ...input, tabId: randomUUID() }, access), /selected tab/);
  await assert.rejects(api.handle({ ...input, clientId: randomUUID() }, access), /Take control/);
  await assert.rejects(api.handle({ ...input, epoch: input.epoch + 1 }, access), /Take control/);
  await assert.rejects(api.handle({ ...input, sessionId: randomUUID() }, access), /Conversation not found/);
  assert.equal((await api.handle(input, access)).active, true);
  page.emit('request', { ...fakeRequest(`${server.origin}/api?town=private`), headers: () => ({}), frame: () => frame });
  const seen = await api.handle({ ...input, operation: 'view' }, access);
  assert.equal(seen.requests.length, 1); assert.doesNotMatch(JSON.stringify(seen), /RAW|private/);
  const draft = await api.handle({ ...input, operation: 'draft', requestId: seen.requests[0].id, options }, access);
  const tested = await api.handle({ ...input, operation: 'test', draftId: draft.id,
    options: { arguments: { q_town: 'London' }, expected: { result: 'sunny' }, confirm: true } }, access);
  assert.equal(tested.passed, true);
  const installed = await api.handle({ ...input, operation: 'install', draftId: draft.id, revision: draft.revision }, access);
  assert.equal(installed.installed, true); assert.equal(installed.skill.activeVersion, null);
  await api.handle({ ...input, operation: 'stop' }, access);
  app.browser.controlledPageTarget = () => ({ page, url: server.origin });
  for (let i = 0; i < 6; i++) {
    const nextSession = app.store.createSession(app.runtime.owner);
    const nextControl = controls.ensure({ ...binding, conversation: nextSession }, clientId);
    const nextInput = { ...input, sessionId: nextSession, id: nextControl.id, epoch: nextControl.view().epoch, tabId: nextControl.view().tabs[0] };
    assert.equal((await api.handle(nextInput, access)).active, true);
    await api.handle({ ...nextInput, operation: 'stop' }, access);
  }
  assert.equal((await api.handle({ ...input, operation: 'view' }, access)).requests.length, 1);
  await api.handle(input, access);
  fullKey = false;
  await assert.rejects(api.handle({ ...input, operation: 'view' }, access), /full owner window key/);
  page.emit('request', { ...fakeRequest('https://example.com/api?town=private'), frame: () => frame });
  assert.equal(page.listenerCount('request'), 0);
});
