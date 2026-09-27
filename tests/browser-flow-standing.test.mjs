import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBranch, saveComfort} from '../dist/index.js';
import {BranchBrowser, registerBrowser} from '../dist/integrations/browser.js';
import {addPolicyRule, readPolicy, savePolicy} from '../dist/policy.js';

/*
 * FQ-execution.browser (review of ab478310): "Yes, always" on a browser.flow question wrote the
 * standing rule browser.flow on "*", because the flow named no target, and a conversation yes kept as
 * (browser.flow, "") let a different flow through. The real app's gate, approve and checkPolicy are
 * used throughout; the browser's own actions are replaced by a recorder, so no browser is started.
 */

const docs = {steps: [{action: 'navigate', url: 'https://docs.example.com/guide'}, {action: 'click', role: 'link', name: 'Next'}]};
const shop = {steps: [{action: 'navigate', url: 'https://shop.example.com/cart'}, {action: 'click', role: 'button', name: 'Place order'}]};
const both = {steps: [{action: 'navigate', url: 'https://docs.example.com/guide'}, {action: 'navigate', url: 'https://shop.example.com/cart'}]};
// A flow that opens no page: on a window with nothing open it names no website at all.
const nowhere = {steps: [{action: 'click', role: 'button', name: 'Place order'}]};

async function scratch(label) {
  const base = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'claude-session-files');
  await mkdir(base, {recursive: true});
  return mkdtemp(join(base, `${label}-`));
}

/** A model that calls browser.flow with `next.args` and then says it is done, every task. */
function scriptedModel() {
  const model = {name: 'scripted', args: null, calls: 0, async complete() {
    return model.calls++ % 2 === 0
      ? {content: '', toolCalls: [{id: `c${model.calls}`, name: 'browser.flow', arguments: JSON.stringify(model.args)}]}
      : {content: 'done', toolCalls: []};
  }};
  return model;
}

/** The app on `root`, with a browser whose actions only write down what they would have done. */
async function boot(root, model, did) {
  const app = await createBranch({workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider: model});
  const browser = new BranchBrowser({allowedOrigins: ['https://docs.example.com', 'https://shop.example.com']});
  let host = '';
  Object.assign(browser, {
    checkAddress: async () => {},
    hostFor: () => host,
    navigate: async (url) => { host = new URL(url).host; did.push(`navigate ${url}`); return {url, title: 'page'}; },
    click: async (role, name) => { did.push(`click ${name} on ${host}`); return {url: `https://${host}/`, clicked: name}; },
    fill: async (label) => { did.push(`fill ${label} on ${host}`); return {filled: label}; },
    screenshot: async () => ({path: 'shot.png', bytes: 1, sha256: 'x', mediaType: 'image/png', url: `https://${host}/`}),
  });
  registerBrowser(app.registry, browser);
  return app;
}

async function harness(t, label) {
  const root = await scratch(label);
  const did = [];
  const state = {model: scriptedModel(), did, root};
  // The app asks whichever model the test has put in `state.model`, so a test may swap it for its own.
  const current = {name: 'scripted', complete: (...args) => state.model.complete(...args)};
  state.app = await boot(root, current, did);
  state.reopen = async () => { await state.app.close(); state.app = await boot(root, current, did); };
  t.after(async () => { await state.app.close(); await rm(root, {recursive: true, force: true}); });
  return state;
}

/** One model turn that calls browser.flow with `args`, in `sessionId` when given. */
async function turn(state, args, sessionId) {
  state.model.args = args;
  state.model.calls = 0;
  return state.app.runtime.run({prompt: 'run the journey', ...(sessionId ? {sessionId} : {})});
}
const waitingIn = (state, run) => state.app.runtime.approvals.questionFor(run.sessionId);
const flowRules = (state) => readPolicy(state.app.store, state.app.runtime.owner).rules.filter(rule => rule.tool === 'browser.flow');
// Through the real setting, which fills in the card's other fields; a bare record would not parse and read as off.
const saveBrowser = (app, values) => saveComfort(app.store, app.runtime.owner, 'browser', values);

/**
 * The owner lets every single click and page through, and wants to be asked about browser.flow:
 * the flow's own question is the only thing that can stop a "Place order" click.
 */
function ownerRules(state) {
  const {store, runtime} = state.app;
  savePolicy(store, runtime.owner, {preset: 'ask-before-changes'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.click', match: '*', decision: 'allow', remember: 'always'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.navigate', match: '*', decision: 'allow', remember: 'always'});
}

test('(a) "Yes, always" on a docs flow never lets a later shop flow click "Place order" — in a new conversation or after a restart', async (t) => {
  const state = await harness(t, 'flow-always-docs');
  ownerRules(state);
  const first = await turn(state, docs);
  assert.equal(first.status, 'needs_input');
  const asked = waitingIn(state, first);
  assert.equal(asked.tool, 'browser.flow');
  assert.equal(asked.target, 'docs.example.com', 'the flow is asked about on the website it declares');
  state.app.runtime.approve(first.sessionId, 'allow', 'always', asked.fingerprint);
  assert.deepEqual(flowRules(state).map(rule => rule.match), ['docs.example.com'], 'the standing yes names the docs site, not "*"');
  assert.equal((await turn(state, docs, first.sessionId)).status, 'completed');
  assert.deepEqual(state.did, ['navigate https://docs.example.com/guide', 'click Next on docs.example.com']);

  state.did.length = 0;
  const later = await turn(state, shop);
  assert.equal(later.status, 'needs_input', 'a new conversation is asked about the shop flow');
  assert.equal(waitingIn(state, later).tool, 'browser.flow');
  assert.equal(waitingIn(state, later).target, 'shop.example.com');
  assert.deepEqual(state.did, [], 'nothing on the shop site ran');

  await state.reopen();
  const restarted = await turn(state, shop);
  assert.equal(restarted.status, 'needs_input', 'after a restart too');
  assert.equal(waitingIn(state, restarted).target, 'shop.example.com');
  assert.deepEqual(state.did, [], '"Place order" was never clicked');
  // The kept rule still lets the docs flow it was given for through after the restart.
  assert.equal((await turn(state, docs)).status, 'completed');
});

test('(b) a conversation yes for one flow does not let a different flow with other targets through', async (t) => {
  const state = await harness(t, 'flow-session-yes');
  ownerRules(state);
  const first = await turn(state, docs);
  const asked = waitingIn(state, first);
  state.app.runtime.approve(first.sessionId, 'allow', 'session', asked.fingerprint);
  const same = state.app.store.createRun(state.app.runtime.owner, 'more', first.sessionId);
  const context = state.app.runtime.context({runId: same.id});
  assert.equal(state.app.store.run(same.id).sessionId, first.sessionId);
  // Callers that judge a call with no fingerprint (a task picked up again, a web page's own tool)
  // look up the kept answer by tool and target alone.
  assert.equal(state.app.runtime.checkPolicy('browser.flow', docs, context).decision, 'allow', 'the flow the yes was for');
  assert.equal(state.app.runtime.checkPolicy('browser.flow', shop, context).decision, 'ask', 'a flow on another website is asked about');
  assert.equal(state.app.runtime.checkPolicy('browser.flow', both, context).decision, 'ask', 'and so is one that adds a website');
  state.did.length = 0;
  const other = await turn(state, shop, first.sessionId);
  assert.equal(other.status, 'needs_input');
  assert.equal(waitingIn(state, other).target, 'shop.example.com');
  assert.deepEqual(state.did, []);
});

test('(b) a conversation yes for a flow that names no website answers only those very bytes', async (t) => {
  const state = await harness(t, 'flow-session-nowhere');
  ownerRules(state);
  const first = await turn(state, nowhere);
  const asked = waitingIn(state, first);
  assert.equal(asked.target, '');
  state.app.runtime.approve(first.sessionId, 'allow', 'session', asked.fingerprint);
  const same = state.app.store.createRun(state.app.runtime.owner, 'more', first.sessionId);
  const context = state.app.runtime.context({runId: same.id});
  const other = {steps: [{action: 'click', role: 'button', name: 'Delete account'}]};
  assert.equal(state.app.runtime.checkPolicy('browser.flow', other, context).decision, 'ask', 'looked up with no fingerprint');
  assert.equal(state.app.runtime.checkPolicy('browser.flow', other, context, 'another-request').decision, 'ask');
});

test('(c) the flow question never offers or writes a rule broader than the websites it declares', async (t) => {
  const state = await harness(t, 'flow-no-star');
  ownerRules(state);
  // The owner's own rule for flows suggests keeping a yes for good.
  addPolicyRule(state.app.store, state.app.runtime.owner, {tool: 'browser.flow', match: '*', decision: 'ask', remember: 'always'});
  const kept = () => flowRules(state).filter(rule => rule.decision !== 'ask');
  // Two websites: the rule is kept for exactly that pair.
  const pair = await turn(state, both);
  const asked = waitingIn(state, pair);
  assert.equal(asked.target, '2 websites: docs.example.com, shop.example.com');
  assert.equal(asked.noAlways, undefined, 'a flow that names its websites may be given a standing yes');
  state.app.runtime.approve(pair.sessionId, 'allow', 'always', asked.fingerprint);
  assert.deepEqual(kept().map(rule => rule.match), ['2 websites: docs.example.com, shop.example.com']);
  const context = state.app.runtime.context({runId: state.app.store.createRun(state.app.runtime.owner, 'fresh').id});
  assert.equal(state.app.runtime.checkPolicy('browser.flow', both, context).decision, 'allow');
  assert.equal(state.app.runtime.checkPolicy('browser.flow', shop, context).decision, 'ask', 'one of the pair alone is not covered');
  assert.equal(state.app.runtime.checkPolicy('browser.flow', {steps: [
    {action: 'navigate', url: 'https://docs.example.com/guide'}, {action: 'navigate', url: 'https://evil.example.org/'},
  ]}, context).decision, 'ask', 'nor another pair');

  // No website: "Yes, always" is neither offered nor written, and the question is still waiting.
  const lost = await turn(state, nowhere);
  const blank = waitingIn(state, lost);
  assert.equal(blank.target, '');
  assert.equal(blank.noAlways, true, 'the card does not offer "Yes, always"');
  assert.equal(blank.remember, 'session', 'nor does the rule behind the question suggest keeping it for good');
  const before = flowRules(state).length;
  assert.throws(() => state.app.runtime.approve(lost.sessionId, 'allow', 'always', blank.fingerprint), /standing yes/);
  assert.throws(() => state.app.runtime.approve(lost.sessionId, 'deny', 'always', blank.fingerprint), /standing yes/);
  assert.equal(flowRules(state).length, before, 'no rule was written');
  assert.equal(kept().some(rule => rule.match === '*'), false);
  assert.equal(waitingIn(state, lost)?.fingerprint, blank.fingerprint, 'the refused answer left the question waiting');
  assert.throws(() => state.app.runtime.grantApproval('flow:step', {tool: 'browser.flow', target: '', label: 'a journey',
    source: 'owner', fingerprint: blank.fingerprint}, 'always'), /standing yes/, 'a saved workflow\'s yes is held to the same');
  assert.equal(flowRules(state).length, before);
  // A plain yes for this conversation still works.
  state.app.runtime.approve(lost.sessionId, 'allow', 'session', blank.fingerprint);
});

test('a browser.flow call that does not fit the tool is refused, not thrown, while its target is read', async (t) => {
  const state = await harness(t, 'flow-malformed');
  savePolicy(state.app.store, state.app.runtime.owner, {preset: 'ask-before-changes'});
  const context = state.app.runtime.context({runId: state.app.store.createRun(state.app.runtime.owner, 'bad').id});
  for (const sent of [{steps: 'nope'}, {steps: [{action: 'navigate', url: 'not a url'}]}, {}]) {
    assert.equal(state.app.registry.targetOf('browser.flow', sent, context), '');
    assert.equal(state.app.runtime.checkPolicy('browser.flow', sent, context).decision, 'deny');
  }
});

test('an owner rule allowing flows on *.example.com does not let a click on another website through, though the name of the pair ends in .example.com', async (t) => {
  const state = await harness(t, 'flow-pair-host-rule');
  const {store, runtime} = state.app;
  savePolicy(store, runtime.owner, {preset: 'ask-before-changes'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.flow', match: '*.example.com', decision: 'allow', remember: 'always'});
  const context = runtime.context({runId: store.createRun(runtime.owner, 'pair').id});
  assert.equal(runtime.checkPolicy('browser.flow', docs, context).decision, 'allow');
  assert.equal(runtime.checkPolicy('browser.flow', {steps: [
    {action: 'navigate', url: 'https://evil.example.org/'}, {action: 'click', role: 'button', name: 'Buy'},
    {action: 'navigate', url: 'https://docs.example.com/'},
  ]}, context).decision, 'ask', 'each website is weighed on its own: the click on evil.example.org is asked about');
});

// ------------------------------------------------------------------ FQ-execution.browser: once-only overrule

/**
 * A model that calls browser.flow with state.model.args, and when asked again, also calls
 * single-step browser.click with state.model.click arguments.
 */
function dualModel() {
  const model = {name: 'dual', args: null, click: null, calls: 0, async complete() {
    return model.calls++ % 2 === 0
      ? {content: '', toolCalls: [{id: `c${model.calls}`, name: 'browser.flow', arguments: JSON.stringify(model.args)}]}
      : {content: 'done', toolCalls: model.click ? [{id: `c${model.calls}`, name: 'browser.click', arguments: JSON.stringify(model.click)}] : []};
  }};
  return model;
}

test('(d) with confirmSensitive on, "Yes, just now" runs the flow; a retry asks again because the yes is consumed', async (t) => {
  const state = await harness(t, 'flow-once-only');
  const {store, runtime} = state.app;
  savePolicy(store, runtime.owner, {preset: 'ask-before-changes'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.flow', match: '*', decision: 'allow', remember: 'always'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.navigate', match: '*', decision: 'allow', remember: 'always'});
  saveBrowser(state.app, {confirmSensitive: true});

  // First call asks about the flow step (the click, now marked as once-only by confirmSensitive).
  const first = await turn(state, docs);
  assert.equal(first.status, 'needs_input');
  const asked = waitingIn(state, first);
  assert.equal(asked.tool, 'browser.click', 'the once-only question is for the step, not the flow');
  assert.equal(asked.target, 'docs.example.com');
  assert.equal(asked.remember, 'never', 'confirmSensitive makes it once-only (remember: never)');

  // User says "Yes, just now" — it should be a once-only overrule for that exact step.
  state.app.runtime.approve(first.sessionId, 'allow', 'never', asked.fingerprint);

  // Retry: the flow should run to completion, consuming the once-only overrule.
  state.did.length = 0;
  const second = await turn(state, docs, first.sessionId);
  assert.equal(second.status, 'completed', 'the flow ran to completion after "Yes, just now"');
  assert.deepEqual(state.did, ['navigate https://docs.example.com/guide', 'click Next on docs.example.com'],
    'the flow step executed successfully');

  // Third call: run the same flow again. The yes should have been consumed, so it should ask again.
  state.did.length = 0;
  const third = await turn(state, docs, first.sessionId);
  assert.equal(third.status, 'needs_input', 'the same flow asks again after the yes was consumed');
  const askedAgain = waitingIn(state, third);
  assert.equal(askedAgain.tool, 'browser.click');
  assert.equal(askedAgain.target, 'docs.example.com');
  assert.deepEqual(state.did, [], 'nothing ran before the question');
});

test('(d2) a yes for a step on one website does not cover the same step on another, and the question carries the step\'s own fingerprint', async (t) => {
  const state = await harness(t, 'flow-different-host');
  const {store, runtime} = state.app;
  savePolicy(store, runtime.owner, {preset: 'ask-before-changes'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.flow', match: '*', decision: 'allow', remember: 'always'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.navigate', match: '*', decision: 'allow', remember: 'always'});
  saveBrowser(state.app, {confirmSensitive: true});
  const first = await turn(state, shop);
  assert.equal(first.status, 'needs_input');
  const asked = waitingIn(state, first);
  assert.equal(asked.target, 'shop.example.com');
  const {argumentFingerprint} = await import('../dist/runtime.js');
  assert.notEqual(asked.fingerprint, argumentFingerprint('browser.click', JSON.stringify({role: 'button', name: 'Place order'})),
    'bound to the step, not only to the words of the click');
  state.app.runtime.approve(first.sessionId, 'allow', 'never', asked.fingerprint);
  // While that yes is still unused, the same click on another website asks again and nothing runs.
  state.did.length = 0;
  const elsewhere = {steps: [{action: 'navigate', url: 'https://shop.example.com:8443/cart'}, {action: 'click', role: 'button', name: 'Place order'}]};
  const other = await turn(state, elsewhere, first.sessionId);
  assert.equal(other.status, 'needs_input', 'the yes for shop.example.com does not cover :8443');
  assert.equal(waitingIn(state, other).target, 'shop.example.com:8443');
  assert.deepEqual(state.did, [], 'nothing ran on the other website');
  // The yes it was given is still there for its own website.
  const back = await turn(state, shop, first.sessionId);
  assert.equal(back.status, 'completed');
  assert.deepEqual(state.did, ['navigate https://shop.example.com/cart', 'click Place order on shop.example.com']);
});

test('after a yes for step 1, step 2 of the same flow asks again', async (t) => {
  const state = await harness(t, 'flow-two-clicks');
  const {store, runtime} = state.app;
  savePolicy(store, runtime.owner, {preset: 'ask-before-changes'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.flow', match: '*', decision: 'allow', remember: 'always'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.navigate', match: '*', decision: 'allow', remember: 'always'});
  saveBrowser(state.app, {confirmSensitive: true});

  // Flow with two clicks on the same host
  const twoClicks = {steps: [{action: 'navigate', url: 'https://shop.example.com/items'}, {action: 'click', role: 'button', name: 'Select'}, {action: 'click', role: 'button', name: 'Select'}]};

  // First call asks about the flow's first click step.
  const first = await turn(state, twoClicks);
  assert.equal(first.status, 'needs_input');
  const askedAboutFirst = waitingIn(state, first);
  assert.equal(askedAboutFirst.tool, 'browser.click', 'question is about a step');

  // User says "Yes, just now" to the first click.
  state.app.runtime.approve(first.sessionId, 'allow', 'never', askedAboutFirst.fingerprint);

  // Retry: flow runs.
  state.did.length = 0;
  const second = await turn(state, twoClicks, first.sessionId);
  assert.equal(second.status, 'needs_input', 'the flow asks about the second click after the first yes is consumed');
  const askedAboutSecond = waitingIn(state, second);
  assert.equal(askedAboutSecond.tool, 'browser.click');
  // The second click should have a different fingerprint from the first because the index differs
  assert.notEqual(askedAboutSecond.fingerprint, askedAboutFirst.fingerprint, 'the second step has a different fingerprint');
});

test('the runtime uses a step\'s one-time yes once: taken the first time, gone the second', async (t) => {
  const state = await harness(t, 'flow-consume-once');
  const {store, runtime} = state.app;
  savePolicy(store, runtime.owner, {preset: 'ask-before-changes'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.flow', match: '*', decision: 'allow', remember: 'always'});
  addPolicyRule(store, runtime.owner, {tool: 'browser.navigate', match: '*', decision: 'allow', remember: 'always'});
  saveBrowser(state.app, {confirmSensitive: true});
  const first = await turn(state, shop);
  const asked = waitingIn(state, first);
  runtime.approve(first.sessionId, 'allow', 'never', asked.fingerprint);
  const context = {runId: 'consume-check', owner: runtime.owner, approvalKey: first.sessionId};
  assert.equal(runtime.consumeStepYeses([asked.fingerprint], context), true, 'the first use takes it');
  assert.equal(runtime.consumeStepYeses([asked.fingerprint], context), false, 'a second use finds it gone');
});

test('when takeStepYeses is not wired, runFlow refuses instead of going ahead', async () => {
  const {runFlow, stepYesUsedRefusal} = await import('../dist/integrations/browser-flow.js');
  const {ToolRegistry} = await import('../dist/registry.js');

  const registry = new ToolRegistry();
  const ran = [];

  // Registry with judgeStep that returns a fingerprint but no takeStepYeses wired
  registry.judgeStep = () => 'step-fingerprint';
  // takeStepYeses is not defined

  const host = {
    hostFor: () => 'shop.example.com', checkAddress: async () => {},
    navigate: async (url) => { ran.push(`navigate ${url}`); return {url, title: ''}; },
    click: async () => { ran.push('click'); return {}; }, fill: async () => { ran.push('fill'); return {}; },
    wait: async () => ({}), screenshot: async () => ({}),
  };

  await assert.rejects(
    runFlow(registry, host, {steps: [{action: 'click', role: 'button', name: 'Place order'}]}, {runId: 'r', owner: 'local'}),
    (error) => error.message === stepYesUsedRefusal
  );
  assert.deepEqual(ran, [], 'nothing ran when takeStepYeses is not wired');
});

test('(control) a single-step browser.click with confirmSensitive still works normally', async (t) => {
  const state = await harness(t, 'single-click');
  const {store, runtime} = state.app;
  savePolicy(store, runtime.owner, {preset: 'ask-before-changes'});
  saveBrowser(state.app, {confirmSensitive: true});

  // Model that calls single-step browser.click directly (not a flow).
  const model = {name: 'single', calls: 0, async complete() {
    return model.calls++ % 2 === 0
      ? {content: '', toolCalls: [{id: `c${model.calls}`, name: 'browser.click', arguments: JSON.stringify({role: 'button', name: 'Buy'})}]}
      : {content: 'done', toolCalls: []};
  }};
  state.model = model;

  // First call asks about the click.
  const first = await turn(state, {});
  assert.equal(first.status, 'needs_input');
  const asked = waitingIn(state, first);
  assert.equal(asked.tool, 'browser.click');

  // User says "Yes, just now".
  state.app.runtime.approve(first.sessionId, 'allow', 'never', asked.fingerprint);

  // Retry: should run.
  const second = await turn(state, {}, first.sessionId);
  assert.equal(second.status, 'completed');

  // Second call of the same click: because it's single-step, the yes should also be consumed, so it should ask again.
  const third = await turn(state, {}, first.sessionId);
  assert.equal(third.status, 'needs_input', 'single-step click also consumes the yes');
});

test('(d3) a one-time yes another run of the same flow already used lets nothing run', async () => {
  const {runFlow, stepYesUsedRefusal} = await import('../dist/integrations/browser-flow.js');
  const {ToolRegistry} = await import('../dist/registry.js');
  const registry = new ToolRegistry();
  const ran = [];
  registry.judgeStep = () => 'step-fingerprint';
  registry.takeStepYeses = () => false; // the other run took it first
  const host = {
    hostFor: () => 'shop.example.com', checkAddress: async () => {},
    navigate: async (url) => { ran.push(`navigate ${url}`); return {url, title: ''}; },
    click: async () => { ran.push('click'); return {}; }, fill: async () => { ran.push('fill'); return {}; },
    wait: async () => ({}), screenshot: async () => ({}),
  };
  await assert.rejects(runFlow(registry, host, {steps: [{action: 'click', role: 'button', name: 'Place order'}]}, {runId: 'r', owner: 'local'}),
    (error) => error.message === stepYesUsedRefusal);
  assert.deepEqual(ran, [], 'nothing ran');
});
