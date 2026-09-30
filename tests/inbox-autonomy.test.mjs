/* Real isolated engine, scoped questions and a headless window. No provider or real desktop. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createBranch } from '../dist/index.js';
import { startServer } from '../dist/server.js';
import { setLockdown } from '../dist/lockdown.js';
import { SelfStarting } from '../dist/autonomy/procedures.js';
import { discardTemp } from './temp-dir.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'branch-inbox-autonomy-'));
  const prompts = [];
  const provider = { name: 'scripted', async complete(request) { prompts.push(request.messages.filter((m) => m.role === 'user').at(-1)?.content); return { content: 'Done.', toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'data'),
    provider });
  const server = await startServer(app, { dataDir: join(root, 'data'), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, token = server.token) => {
    const response = await fetch(server.url + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const api = async (path, body) => { const result = await call(path, body); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  await api('/api/autonomy/switch', { part: 'procedures', mode: 'on', confirmLoosening: true });
  const make = async (name, level = 'ask-to-start') => (await api('/api/autonomy/procedures', { name, level, start: { kind: 'manual' }, permissions: ['files.read'], perDay: 2,
    steps: [{ title: 'First <img src=x>', prompt: 'Read the first isolated report.' }, { title: 'Final check', prompt: 'Read the second isolated report.', confirm: true }] })).procedure;
  const pending = async () => (await api('/api/autonomy/ledger')).entries;
  const start = async (flow) => { await api(`/api/autonomy/procedures/${flow.id}/run`, {}); return (await pending()).find((entry) => entry.kind === 'start' && entry.payload.procedureId === flow.id); };
  return { app, server, prompts, provider, api, call, make, pending, start };
}

test('switching off an active model turn cancels once and its late return cannot continue the flow', async (t) => {
  const { app, provider, api } = await fixture(t);
  let markStarted, calls = 0;
  const started = new Promise((resolve) => { markStarted = resolve; });
  provider.complete = async (request) => {
    calls++;
    markStarted();
    return new Promise((resolve, reject) => {
      if (request.signal?.aborted) reject(new Error('Already stopped.'));
      else request.signal?.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true });
    });
  };
  const { procedure } = await api('/api/autonomy/procedures', { name: 'Active stop', level: 'auto', start: { kind: 'manual' },
    steps: [{ title: 'Working', prompt: 'Wait in the isolated provider.' }, { title: 'Next', prompt: 'Never start this after revocation.' }] });
  await api(`/api/autonomy/procedures/${procedure.id}/run`, {});
  await started;
  await api('/api/autonomy/switch', { part: 'procedures', mode: 'off' });
  await app.autonomy.idle();
  const state = app.autonomy.procedures.get(procedure.id);
  assert.equal(state.running, null);
  assert.deepEqual(state.stats, { completed: 0, failed: 0, cancelled: 1 });
  assert.equal(calls, 1);
  assert.equal(state.recent.length, 1, 'the late cancelled turn cannot settle the flow a second time');
});

test('removing a flow cancels its active model turn before deleting its state', async (t) => {
  const { app, provider, api, pending } = await fixture(t);
  let start, release, aborted = false, calls = 0;
  const entered = new Promise((resolve) => { start = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  provider.complete = async (request) => {
    calls++;
    request.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
    start();
    await held; // A model response may still arrive after its turn was cancelled.
    return { content: 'Late answer', toolCalls: [] };
  };
  const { procedure } = await api('/api/autonomy/procedures', { name: 'Remove active flow', level: 'auto', start: { kind: 'manual' },
    steps: [{ title: 'Working', prompt: 'Hold an isolated model turn.' }, { title: 'Later', prompt: 'Never start after removal.' }] });
  await api(`/api/autonomy/procedures/${procedure.id}/run`, {});
  await entered;
  const runId = [...app.autonomy.runner.started].at(-1);
  assert.equal(app.store.run(runId).status, 'running');
  await api(`/api/autonomy/procedures/${procedure.id}/remove`, {});
  try { assert.equal(aborted, true, 'removal must cancel the already dispatched model turn'); }
  finally { release(); }
  await app.autonomy.idle();
  assert.equal(app.store.run(runId).status, 'cancelled');
  assert.throws(() => app.autonomy.procedures.get(procedure.id), /no procedure/);
  assert.equal((await pending()).some((entry) => entry.payload.procedureId === procedure.id), false);
  assert.equal(calls, 1, 'the late answer cannot start the next step');
});

test('saved off mode refuses a stale yes and withdraws its questions on reopen', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'branch-inbox-off-reopen-'));
  const prompts = [], options = { workspace: join(root, 'workspace'), dataDir: join(root, 'data'),
    provider: { name: 'scripted', async complete() { prompts.push('ran'); return { content: 'Done.', toolCalls: [] }; } } };
  let app = await createBranch(options);
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.autonomy.setMode('procedures', { mode: 'on' });
  const flow = app.autonomy.procedures.create({ name: 'Torn switch', start: { kind: 'manual' }, level: 'ask-to-start',
    steps: [{ title: 'Do work', prompt: 'Only after a new yes.' }] });
  app.autonomy.procedures.trigger(flow.id, 'owner');
  const old = app.autonomy.ledger.list('pending').find((entry) => entry.kind === 'start' && entry.payload.procedureId === flow.id);
  assert.ok(old);
  app.store.save('settings', app.runtime.owner, 'autonomy-procedures', { mode: 'off' }); // A saved switch before its cleanup finished.
  assert.throws(() => app.autonomy.decide(old.id, true), /switched off/);
  assert.equal(prompts.length, 0);
  await app.close();
  app = await createBranch(options);
  assert.equal(app.autonomy.ledger.list('pending').some((entry) => entry.id === old.id), false);
  assert.equal(app.autonomy.procedures.get(flow.id).running, null);
  app.autonomy.setMode('procedures', { mode: 'on' });
  assert.throws(() => app.autonomy.decide(old.id, true), /Nothing waits/);
  assert.equal(prompts.length, 0);
});

test('answers are exact, fresh, owner scoped and revocable; rejected and stale questions execute nothing', async (t) => {
  const { app, server, prompts, api, call, make, pending, start } = await fixture(t);
  const first = await make('One'), second = await make('Two');
  const one = await start(first), two = await start(second);
  assert.equal((await api('/api/state')).needsYou, 2);
  assert.equal(one.payload.scope.procedure.permissions[0], 'files.read');
  assert.equal((await call('/api/autonomy/decide', { yes: true })).status, 400, 'generic yes never authorizes a task');
  const short = app.sessionTokens.create(app.runtime.owner, { name: 'isolated key', scope: 'run', minutes: 5 }).token;
  assert.equal((await call('/api/autonomy/decide', { id: one.id, yes: true }, short)).status, 401);
  const person = app.store.profiles.create({ name: 'Sam', pin: '2468' });
  app.store.profiles.switch({ profileId: person.id, pin: '2468' });
  const householdRead = await call('/api/autonomy/ledger');
  assert.equal(householdRead.status, 400);
  assert.match(householdRead.body.error, /owner/i);
  assert.equal((await call('/api/autonomy/decide', { id: one.id, yes: true })).status, 400);
  assert.equal((await api('/api/state')).needsYou, 0);
  app.store.profiles.switch({ profileId: null });
  setLockdown(app.store, app.runtime.owner, { on: true });
  assert.equal((await call('/api/autonomy/decide', { id: one.id, yes: true })).status, 409);
  assert.throws(() => app.autonomy.decide(one.id, true), /Lockdown/);
  setLockdown(app.store, app.runtime.owner, { on: false });
  await api('/api/autonomy/decide', { id: one.id, yes: false });
  assert.equal((await pending()).some((entry) => entry.id === two.id), true);
  assert.equal(prompts.length, 0);
  const levelFlow = await make('Level reversal');
  const levelQuestion = await start(levelFlow);
  await api(`/api/autonomy/procedures/${levelFlow.id}/update`, { level: 'ask-each-step' });
  await api(`/api/autonomy/procedures/${levelFlow.id}/update`, { level: 'ask-to-start' });
  assert.equal((await call('/api/autonomy/decide', { id: levelQuestion.id, yes: true })).status, 400, 'returning to the same level cannot revive an old answer');
  await api('/api/autonomy/decide', { id: levelQuestion.id, yes: false });
  await api(`/api/autonomy/procedures/${second.id}/pause`, {});
  await api(`/api/autonomy/procedures/${second.id}/resume`, {});
  assert.equal((await call('/api/autonomy/decide', { id: two.id, yes: true })).status, 400, 'pause revokes the old answer even after resume');
  assert.equal((await call('/api/autonomy/decide', { id: two.id, yes: false })).status, 400, 'the old question was withdrawn');
  const changed = await start(second);
  const proposed = await api(`/api/autonomy/procedures/${second.id}/propose`, { steps: [{ title: 'Changed', prompt: 'A different isolated task.' }] });
  await api('/api/autonomy/decide', { id: proposed.id, yes: true });
  assert.equal((await call('/api/autonomy/decide', { id: changed.id, yes: true })).status, 400, 'changed steps cannot inherit yes');
  await api('/api/autonomy/switch', { part: 'procedures', mode: 'off' });
  await api('/api/autonomy/switch', { part: 'procedures', mode: 'on', confirmLoosening: true });
  assert.equal((await call('/api/autonomy/decide', { id: changed.id, yes: true })).status, 400, 'off withdraws old questions permanently');
  assert.equal((await pending()).length, 0);
  assert.equal(prompts.length, 0);
  const fresh = await start(second);
  await api('/api/autonomy/decide', { id: fresh.id, yes: true });
  await app.autonomy.idle();
  assert.equal(prompts.length, 1);
  assert.equal((await call('/api/autonomy/decide', { id: fresh.id, yes: true })).status, 400, 'answered id cannot replay');
  const guarded = (await api('/api/autonomy/procedures', { name: 'Confirm first', level: 'ask-to-start', start: { kind: 'manual' },
    steps: [{ title: 'Ask first', prompt: 'This requires its own yes.', confirm: true }] })).procedure;
  const guardedStart = await start(guarded);
  await api('/api/autonomy/decide', { id: guardedStart.id, yes: true });
  await app.autonomy.idle();
  const guardedStep = (await pending()).find((entry) => entry.payload.procedureId === guarded.id);
  assert.equal(guardedStep.kind, 'step', 'even the first explicitly confirmed step needs its own answer');
  assert.equal(prompts.length, 1);
  const timed = (await api('/api/autonomy/procedures', { name: 'Timed stop', level: 'auto', start: { kind: 'manual' },
    steps: [{ kind: 'wait', title: 'Wait', minutes: 5 }, { title: 'Later', prompt: 'Do not resume this after switching off.' }] })).procedure;
  await api(`/api/autonomy/procedures/${timed.id}/run`, {});
  await app.autonomy.idle();
  assert.ok(app.autonomy.procedures.get(timed.id).running?.waitUntil);
  await api('/api/autonomy/switch', { part: 'procedures', mode: 'off' });
  await api('/api/autonomy/switch', { part: 'procedures', mode: 'on', confirmLoosening: true });
  assert.equal(app.autonomy.procedures.get(timed.id).running, null, 'off cancels timed waits as well as unanswered steps');
  assert.equal(app.autonomy.procedures.get(guarded.id).running, null);
  assert.equal(app.autonomy.procedures.get(timed.id).stats.cancelled, 1);
  assert.equal(prompts.length, 1);
});

test('Inbox shows arriving exact start and step questions; answers only the reviewed id and refreshes without a click', async (t) => {
  const { app, server, prompts, api, make, start, pending, call } = await fixture(t);
  await api('/api/onboarding', { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel('Session token', { exact: true }).fill(server.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#side [data-act="view"][data-v="inbox"]').first().click();
  const first = await make('Inbox One', 'ask-each-step'), second = await make('Inbox Two');
  const one = await start(first), two = await start(second);
  const row = (id) => page.locator(`[data-act="autonomy-review"][data-id="${id}"]`);
  await row(one.id).waitFor({ timeout: 20000 });
  await row(two.id).waitFor();
  assert.equal(await page.locator('[data-act="allowall"]').count(), 0, 'autonomy is never included in batch yes');
  await row(two.id).click();
  assert.match(await page.locator('.dlg').innerText(), /Read the first isolated report[\s\S]*Read the second isolated report[\s\S]*files.read[\s\S]*2 starts per day/);
  assert.equal(await page.locator('.dlg img').count(), 0, 'step markup is text');
  await page.locator('.dlg [data-act="autonomy-answer"][data-v="no"]').click();
  await row(two.id).waitFor({ state: 'detached' });
  assert.equal(prompts.length, 0);
  assert.equal((await pending()).find((entry) => entry.id === one.id)?.status, 'pending');
  await row(one.id).click();
  await page.locator('.dlg [data-act="autonomy-answer"][data-v="yes"]').click();
  await page.waitForFunction(() => !document.querySelector('.dlg [data-act="autonomy-answer"]'));
  await app.autonomy.idle();
  const step = (await pending()).find((entry) => entry.kind === 'step');
  assert.ok(step);
  assert.equal(prompts.length, 0, 'ask-each-step starts by asking rather than executing');
  await row(step.id).waitFor({ timeout: 20000 });
  await row(step.id).click();
  assert.match(await page.locator('.dlg').innerText(), /Read the first isolated report/);
  assert.doesNotMatch(await page.locator('.dlg').innerText(), /Read the second isolated report/, 'step yes covers only one step');
  await page.locator('.dlg [data-act="autonomy-answer"][data-v="yes"]').click();
  await page.waitForFunction(() => !document.querySelector('.dlg [data-act="autonomy-answer"]'));
  await app.autonomy.idle();
  const next = (await pending()).find((entry) => entry.kind === 'step');
  assert.equal(next.payload.step, 1);
  assert.equal(prompts.length, 1);
  await row(next.id).waitFor({ timeout: 20000 });
  await row(next.id).click();
  /* Review reads the ledger again before it opens its dialog (places/inbox-autonomy.js review). Switched off before that
     read landed, the question was already gone and rightly never shown (CI run 36587157671). The dialog is waited for,
     so this is the stale review it means to test: open on screen, then withdrawn by the engine. */
  await page.locator('.dlg [data-act="autonomy-answer"][data-v="yes"]').waitFor();
  await api('/api/autonomy/switch', { part: 'procedures', mode: 'off' });
  const answers = [];
  page.on('request', (request) => { if (request.url().endsWith('/api/autonomy/decide')) answers.push(request.postDataJSON()); });
  await page.locator('.dlg [data-act="autonomy-answer"][data-v="yes"]').click();
  await page.locator('.toast', { hasText: 'This question is no longer waiting.' }).waitFor();
  assert.deepEqual(answers, [], 'stale review never posts a substitute yes');
  assert.equal(prompts.length, 1);
  assert.equal((await call('/api/autonomy/decide', { id: next.id, yes: true })).status, 400);
  assert.deepEqual(errors, []);
});

test('paused clock and after-task waits stay inert, and pending steps need fresh approval after resume', async (t) => {
  const { app, prompts, api, make, start, pending, call } = await fixture(t);
  let now = new Date('2026-09-27T09:00:00Z');
  const procedures = new SelfStarting({ store: app.store, owner: app.runtime.owner, runner: app.autonomy.runner,
    ledger: app.autonomy.ledger, held: () => ['files.read'], now: () => now });
  const sameClock = procedures.create({ name: 'Fresh start at same clock', start: { kind: 'manual' },
    steps: [{ title: 'Later', prompt: 'This still needs its own start answer.' }] });
  procedures.trigger(sameClock.id, 'owner');
  const priorStart = (await pending()).find((entry) => entry.payload.procedureId === sameClock.id);
  await api('/api/autonomy/decide', { id: priorStart.id, yes: false });
  procedures.trigger(sameClock.id, 'owner again');
  const nextStart = (await pending()).find((entry) => entry.payload.procedureId === sameClock.id);
  assert.ok(nextStart, 'a new start at the same clock moment still asks');
  assert.notEqual(nextStart.fingerprint, priorStart.fingerprint);
  await api('/api/autonomy/decide', { id: nextStart.id, yes: false });
  for (const wait of [{ kind: 'wait', minutes: 1 }, { kind: 'when', at: { kind: 'after-task', words: 'report' } }]) {
    const flow = procedures.create({ name: `Paused ${wait.kind}`, level: 'auto', start: { kind: 'manual' },
      steps: [{ ...wait, title: 'Wait' }, { title: 'Later', prompt: 'Only after a fresh owner start.' }] });
    procedures.trigger(flow.id, 'owner');
    await procedures.idle();
    const waiting = procedures.get(flow.id);
    // An older saved paused run can still be present on restart. Scheduling must guard it too.
    app.store.save('settings', app.runtime.owner, `autonomy-procedure:${flow.id}`, { ...waiting, status: 'paused' });
    now = new Date(now.getTime() + 120000);
    await procedures.tick();
    procedures.afterTask('report finished');
    await procedures.idle();
    assert.deepEqual(procedures.get(flow.id).running, waiting.running);
    assert.equal(prompts.length, 0, `${wait.kind} must not start a request while paused`);
    procedures.update(flow.id, { paused: false });
    assert.equal(procedures.get(flow.id).running, null, 'direct resume cancels a saved paused run');
    await procedures.tick();
    procedures.afterTask('report finished');
    await procedures.idle();
    assert.equal(prompts.length, 0, 'resume does not resurrect the cancelled wait');
  }
  const flow = await make('Fresh step', 'ask-each-step');
  const question = await start(flow);
  await api('/api/autonomy/decide', { id: question.id, yes: true });
  await app.autonomy.idle();
  const oldStep = (await pending()).find((entry) => entry.payload.procedureId === flow.id);
  await api(`/api/autonomy/procedures/${flow.id}/pause`, {});
  await api(`/api/autonomy/procedures/${flow.id}/resume`, {});
  assert.equal((await call('/api/autonomy/decide', { id: oldStep.id, yes: true })).status, 400);
  const freshStart = await start(flow);
  await api('/api/autonomy/decide', { id: freshStart.id, yes: true });
  await app.autonomy.idle();
  const freshStep = (await pending()).find((entry) => entry.payload.procedureId === flow.id);
  assert.notEqual(freshStep.id, oldStep.id);
  assert.notEqual(freshStep.fingerprint, oldStep.fingerprint);
  assert.equal(prompts.length, 0);
  await api('/api/autonomy/decide', { id: freshStep.id, yes: true });
  await app.autonomy.idle();
  assert.equal(prompts.length, 1, 'only the fresh step answer permits a request');
});

test('reopening saved paused runs cancels waits and withdraws questions before direct Resume', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'branch-inbox-paused-reopen-'));
  const prompts = [], options = { workspace: join(root, 'workspace'), dataDir: join(root, 'data'),
    provider: { name: 'scripted', async complete() { prompts.push('request'); return { content: 'Done.', toolCalls: [] }; } } };
  let app = await createBranch(options);
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.autonomy.setMode('procedures', { mode: 'on' });
  const flows = [];
  for (const step of [{ kind: 'wait', minutes: 1 }, { kind: 'when', at: { kind: 'after-task', words: 'report' } }, {}]) {
    const flow = app.autonomy.procedures.create({ name: `Reopen ${step.kind ?? 'question'}`, start: { kind: 'manual' },
      level: step.kind ? 'auto' : 'ask-each-step', steps: [{ ...step, title: 'First', ...(!step.kind ? { prompt: 'Wait for a fresh answer.' } : {}) },
        { title: 'Later', prompt: 'Requires a fresh start.' }] });
    app.autonomy.procedures.trigger(flow.id, 'owner');
    if (!step.kind) app.autonomy.decide(app.autonomy.ledger.list('pending').find((entry) => entry.kind === 'start').id, true);
    await app.autonomy.idle();
    const state = app.autonomy.procedures.get(flow.id), running = { ...state.running };
    delete running.id; // Saved before run generations were introduced.
    if (step.kind === 'wait') running.waitUntil = '2000-01-01T00:00:00.000Z';
    app.store.save('settings', app.runtime.owner, `autonomy-procedure:${flow.id}`, { ...state, status: 'paused', running });
    flows.push(flow.id);
  }
  const start = app.autonomy.procedures.create({ name: 'Saved start question', start: { kind: 'manual' },
    steps: [{ title: 'Work', prompt: 'Needs its own answer.' }] });
  app.autonomy.procedures.trigger(start.id, 'owner');
  app.store.save('settings', app.runtime.owner, `autonomy-procedure:${start.id}`, { ...app.autonomy.procedures.get(start.id), status: 'paused' });
  const oldQuestions = app.autonomy.ledger.list('pending').filter((entry) => entry.kind === 'start' || entry.kind === 'step');
  assert.equal(oldQuestions.length, 2);
  await app.close();
  app = await createBranch(options);
  assert.equal(app.autonomy.ledger.list('pending').filter((entry) => entry.kind === 'start' || entry.kind === 'step').length, 0);
  for (const id of [...flows, start.id]) app.autonomy.procedures.update(id, { paused: false });
  await app.autonomy.procedures.tick();
  app.autonomy.procedures.afterTask('report finished');
  await app.autonomy.idle();
  assert.equal(prompts.length, 0, 'direct Resume never releases an old wait or question');
  for (const id of flows) {
    assert.equal(app.autonomy.procedures.get(id).running, null);
    assert.deepEqual(app.autonomy.procedures.get(id).stats, { completed: 0, failed: 0, cancelled: 1 });
  }
  for (const question of oldQuestions) assert.throws(() => app.autonomy.decide(question.id, true));
  app.autonomy.procedures.trigger(flows[2], 'fresh owner start');
  const fresh = app.autonomy.ledger.list('pending').find((entry) => entry.kind === 'start');
  assert.ok(fresh && oldQuestions.every((entry) => entry.id !== fresh.id));
  app.autonomy.decide(fresh.id, true);
  await app.autonomy.idle();
  assert.equal(prompts.length, 0, 'fresh start still requires the fresh step answer');
  app.autonomy.decide(app.autonomy.ledger.list('pending').find((entry) => entry.kind === 'step').id, true);
  await app.autonomy.idle();
  assert.equal(prompts.length, 1);
});

for (const revoke of ['off', 'pause']) test(`a late cancelled response after ${revoke} cannot alter a newer run of the same flow`, async (t) => {
  const { app, provider, api } = await fixture(t);
  const procedures = new SelfStarting({ store: app.store, owner: app.runtime.owner, runner: app.autonomy.runner,
    ledger: app.autonomy.ledger, held: () => ['files.read'], now: () => new Date('2026-09-27T09:00:00Z') });
  const release = [], started = [];
  let finishOld;
  const oldFinished = new Promise((resolve) => { finishOld = resolve; });
  app.registry.onRunFinished(async () => { finishOld(); });
  provider.complete = async () => {
    const index = release.length;
    const response = new Promise((resolve) => { release.push(() => resolve({ content: `Response ${index}`, toolCalls: [] })); });
    started[index]?.();
    return response; // A response in transit can arrive despite cancellation.
  };
  t.after(() => release.forEach((resolve) => resolve()));
  const { procedure } = await api('/api/autonomy/procedures', { name: `Generations ${revoke}`, level: 'auto', start: { kind: 'manual' },
    steps: [{ title: 'Work', prompt: 'One isolated request.' }] });
  const oldStarted = new Promise((resolve) => { started[0] = resolve; });
  assert.equal(procedures.trigger(procedure.id, 'isolated owner start').started, true);
  await oldStarted;
  const old = procedures.get(procedure.id).running;
  if (revoke === 'off') {
    await api('/api/autonomy/switch', { part: 'procedures', mode: 'off' });
    await api('/api/autonomy/switch', { part: 'procedures', mode: 'on', confirmLoosening: true });
  } else {
    await api(`/api/autonomy/procedures/${procedure.id}/pause`, {});
    await api(`/api/autonomy/procedures/${procedure.id}/resume`, {});
  }
  const newStarted = new Promise((resolve) => { started[1] = resolve; });
  const restarted = procedures.trigger(procedure.id, 'isolated owner restart');
  if (!restarted.started) release.forEach((resolve) => resolve());
  assert.equal(restarted.started, true, restarted.reason);
  await newStarted;
  const before = procedures.get(procedure.id);
  assert.notEqual(before.running.id, old.id);
  assert.equal(before.running.startedAt, old.startedAt, 'generation stays distinct even at the same clock moment');
  assert.equal(before.stats.cancelled, 1);
  release[0]();
  await oldFinished;
  await new Promise(setImmediate); // Flush the cancelled turn's continuation, without settling the held new turn.
  assert.deepEqual(procedures.get(procedure.id), before, 'old response cannot write session, progress or stats into the new run');
  release[1]();
  await procedures.idle();
  const after = procedures.get(procedure.id);
  assert.equal(after.running, null);
  assert.deepEqual(after.stats, { completed: 1, failed: 0, cancelled: 1 });
  assert.equal(after.recent.length, 2);
});
