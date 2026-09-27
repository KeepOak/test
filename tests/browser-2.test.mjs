import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, writeFile, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {BranchBrowser, registerBrowser} from '../dist/integrations/browser.js';
import {BrowserProfiles} from '../dist/integrations/browser-profiles.js';
import {attach, attachRefusal, attachedAddressRefusal} from '../dist/integrations/browser-attach.js';
import {recordingEntries, recordingText, leaksIn} from '../dist/integrations/browser-trace.js';
import {registerComputer} from '../dist/integrations/computer.js';
import {parseResults, requestFor} from '../dist/integrations/web-search.js';
import {hostRefusalFor} from '../dist/integrations/desktop-config.js';
import {browserSkillNames, browserSkillPackage, browserSkillList} from '../dist/browser-skills.js';
import {readSkillPackage} from '../dist/skill-package.js';
import {inferToolGroup} from '../dist/catalog.js';
import {WorkspaceFiles} from '../dist/files.js';
import {RunArtifacts, ToolRegistry, Budget} from '../dist/index.js';

/** A port nothing on this computer is listening on, so test files running side by side never share one. */
async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const {port} = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

const key = {key: async () => Buffer.alloc(32, 9)};
const password = 'hunter2-super-secret';
const sessionToken = 'branch-session-token-zzz987654321';

const runContext = (runId, owner = 'test', extra = []) => ({
  owner, workspace: '.', runId, signal: new AbortController().signal, budget: new Budget(),
  permissions: new Set(['browser.read', 'browser.interact', ...extra]), depth: 0,
});

async function scratch(label) {
  const base = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'claude-session-files');
  await mkdir(base, {recursive: true});
  return mkdtemp(join(base, `${label}-`));
}

const page = body => `<!doctype html><meta charset="utf-8"><title>Fixture</title>${body}`;
const routes = {
  '/': page('<p>home</p>'),
  '/form': page(`<form>
    <label for="who">Your name</label><input id="who" name="who">
    <label for="pw">Password</label><input id="pw" type="password" value="${password}">
    <button id="save" type="button">Save it</button>
    <a href="/">Back home</a></form><p id="echo">nothing</p>
    <script>document.getElementById("who").addEventListener("input",e=>{document.getElementById("echo").textContent="name is "+e.target.value})</script>`),
  // The button is renamed by script a moment after load, so the selector a task remembered breaks.
  '/renamed': page(`<button id="old-save">Save</button>
    <script>setTimeout(()=>{const b=document.getElementById("old-save");b.id="new-save";b.textContent="Save"},50)</script>`),
  '/rerender': page(`<div id="box"><button class="a">Alpha</button><button class="b">Beta</button></div>
    <button id="shuffle" onclick="document.getElementById('box').innerHTML='<button class=\\'b\\'>Beta</button><button class=\\'c\\'>Gamma</button><button class=\\'a\\'>Alpha</button>'">Shuffle</button>`),
  '/rows': page(`<table><tbody>
    <tr class="r"><td class="n">Rent</td><td class="v">1200</td><td class="d">2026-03-01</td></tr>
    <tr class="r"><td class="n">Power</td><td class="v">85</td><td class="d">2026-03-04</td></tr></tbody></table>`),
  '/upload': page('<input id="pick" type="file"><p id="got">nothing</p><script>document.getElementById("pick").addEventListener("change",e=>{document.getElementById("got").textContent="received "+e.target.files[0].name})</script>'),
  // A page that opens a tab of its own, to wherever the query string names.
  '/opens': page(`<a id="go" target="_blank">open</a><script>const to=new URLSearchParams(location.search).get("to");const a=document.getElementById("go");a.href=to;a.click();</script>`),
  // A form that asks for a new tab: a shape the link rewrite does not cover.
  '/opens-form': page(`<form id="f" target="_blank" method="GET"><button type="submit">go</button></form><script>const to=new URLSearchParams(location.search).get("to");const f=document.getElementById("f");f.action=to;f.submit();</script>`),
  // The other ways a page asks for a new tab: a plain link under <base target>, an image-map area, and a
  // button's formtarget, which outranks its form's own target.
  '/opens-base': page(`<base target="_blank"><a id="go">open</a><script>const to=new URLSearchParams(location.search).get("to");const a=document.getElementById("go");a.href=to;a.click();</script>`),
  '/opens-area': page(`<map name="m"><area id="go" shape="rect" coords="0,0,50,50" target="_blank"></map><img usemap="#m" width="50" height="50" alt=""><script>const to=new URLSearchParams(location.search).get("to");const a=document.getElementById("go");a.href=to;a.click();</script>`),
  '/opens-formtarget': page(`<form id="f" method="GET"><button id="b" type="submit" formtarget="_blank">go</button></form><script>const to=new URLSearchParams(location.search).get("to");const f=document.getElementById("f");f.action=to;f.requestSubmit(document.getElementById("b"));</script>`),
  // Links the window never sees clicked: one never put in the document, and one inside a closed shadow root.
  '/opens-detached': page(`<script>const a=document.createElement("a");a.href=new URLSearchParams(location.search).get("to");a.target="_blank";a.rel="noopener";a.click();</script>`),
  '/opens-detached-dispatch': page(`<script>const a=document.createElement("a");a.href=new URLSearchParams(location.search).get("to");a.target="_blank";a.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));</script>`),
  '/opens-shadow': page(`<div id="h"></div><script>const r=document.getElementById("h").attachShadow({mode:"closed"});const a=r.appendChild(document.createElement("a"));a.href=new URLSearchParams(location.search).get("to");a.target="_blank";a.textContent="x";a.dispatchEvent(new MouseEvent("click",{bubbles:true,composed:true}));</script>`),
  // A link filling a closed shadow root, clicked for real by pressing its host.
  '/opens-shadow-click': page(`<div id="h" style="display:block;width:160px;height:48px"></div><script>const r=document.getElementById("h").attachShadow({mode:"closed"});const a=r.appendChild(document.createElement("a"));a.href=new URLSearchParams(location.search).get("to");a.target="_blank";a.textContent="Open";a.style.cssText="display:block;width:160px;height:48px";</script>`),
  // Mac mini cdc7fd0: shapes where the page has the last word. B14 sets a link's target back in its own click
  // listener, B16 a form's in its submit listener, B12 is a closed shadow root the parser makes (no attachShadow
  // call), and B10 submits a form inside a closed shadow root, where no click or composed event is seen.
  '/escape-b14': page(`<a id="n">Next</a><script>const n=document.getElementById("n");n.href=new URLSearchParams(location.search).get("to");n.addEventListener("click",()=>{n.target="_blank";});</script>`),
  '/escape-b16': page(`<form id="f" method="GET"><button type="submit">Send it</button></form><script>const f=document.getElementById("f");f.action=new URLSearchParams(location.search).get("to");f.addEventListener("submit",()=>{f.target="_blank";});</script>`),
  '/escape-b12': (url) => page(`<div id="h" style="display:block;width:160px;height:48px"><template shadowrootmode="closed"><a href="${url.searchParams.get('to')}" target="_blank" style="display:block;width:160px;height:48px">Open</a></template></div>`),
  '/escape-b10': page(`<div id="h"></div><script>const r=document.getElementById("h").attachShadow({mode:"closed"});r.innerHTML='<form method="GET" target="_blank"><button>go</button></form>';const f=r.querySelector("form");f.action=new URLSearchParams(location.search).get("to");f.requestSubmit();</script>`),
  // A page that goes round the worker block: the prototype's own method, and deleting the page's copy.
  '/worker-around': page(`<script>const to=new URLSearchParams(location.search).get("to");const go=async (register)=>{try{await register();await navigator.serviceWorker.ready;const sw=(await navigator.serviceWorker.getRegistration()).active;if(sw)sw.postMessage(to);}catch{}};go(()=>ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker,"/worker.js"));try{delete navigator.serviceWorker.register;}catch{}go(()=>navigator.serviceWorker.register("/worker.js"));try{new SharedWorker("/worker.js");}catch{}</script>`),
  // A page showing whatever the query string names in a frame.
  '/framing': page(`<iframe id="f"></iframe><script>document.getElementById("f").src=new URLSearchParams(location.search).get("src");</script>`),
  // A page that starts a background worker and asks it to fetch wherever the query string names.
  '/worker': page(`<script>navigator.serviceWorker.register("/worker.js").then(async () => {await navigator.serviceWorker.ready;const sw = (await navigator.serviceWorker.getRegistration()).active;if (sw) sw.postMessage(new URLSearchParams(location.search).get("to"));}).catch(() => { document.title = "refused"; });</script>`),
  '/cookie': page('<p id="who">?</p><script>document.getElementById("who").textContent="cookie is "+document.cookie</script>'),
  // A page that tries to claim the numbering for itself: a decoy wearing number 1 and a decoy
  // wearing the scratch attribute the numbering uses, both placed before the real button.
  '/spoof': page(`<button id="decoy" data-branch-mark="1" onclick="document.getElementById('hit').textContent='decoy'">Decoy</button>
    <button data-branch-mark-pass="0" onclick="document.getElementById('hit').textContent='pass decoy'">Pass decoy</button>
    <button id="real" onclick="document.getElementById('hit').textContent='real'">Real button</button>
    <p id="hit">nothing</p>
    <button id="clone" onclick="document.getElementById('decoy').setAttribute('data-branch-mark',document.getElementById('real').getAttribute('data-branch-mark'))">Clone the number</button>`),
};

async function fixture() {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path === '/worker.js') {
      response.writeHead(200, {'content-type': 'text/javascript'});
      response.end(`self.addEventListener('activate', event => event.waitUntil(clients.claim()));
        self.addEventListener('message', event => { fetch(event.data).catch(() => undefined); });`);
      return;
    }
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    const answer = routes[path] ?? routes['/'];
    // A route may be written from the address it was asked with (what a page opens, when the parser must see it).
    response.end(typeof answer === 'function' ? answer(new URL(request.url, 'http://fixture')) : answer);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {origin: `http://127.0.0.1:${server.address().port}`,
    stop: async () => { server.close(); await once(server, 'close'); }};
}

/** A browser, a workspace and a place for kept files, all in one scratch folder. */
async function harness(label, config = {}, extraOrigins = []) {
  const root = await scratch(label);
  const workspace = join(root, 'workspace'), data = join(root, 'data');
  await mkdir(workspace, {recursive: true});
  await mkdir(data, {recursive: true});
  const {origin, stop} = await fixture();
  const browser = new BranchBrowser({allowedOrigins: [origin, ...extraOrigins], ...config});
  browser.profiles = new BrowserProfiles(join(data, 'browser-profiles'), key);
  browser.artifacts = new RunArtifacts(join(data, 'artifacts'));
  browser.files = new WorkspaceFiles(workspace);
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  return {root, workspace, data, origin, browser, registry,
    close: async () => { await browser.close(); await stop(); await rm(root, {recursive: true, force: true}); }};
}

/** The registry hands a result back and throws when a tool refuses, so a refusal is a rejection. */
const ok = result => result;
const refusal = async (promise, pattern) => {
  await assert.rejects(() => promise, error => { assert.match(error.message, pattern); return true; });
};

test('a file is sent from the workspace and anything outside it is refused', async () => {
  const h = await harness('browser2-upload');
  try {
    await writeFile(join(h.workspace, 'note.txt'), 'inside the workspace');
    const context = runContext('run-upload');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/upload`}, context);
    ok(await h.registry.execute('browser.upload', {selector: '#pick', path: 'note.txt'}, context));
    const seen = ok(await h.registry.execute('browser.extract', {selector: '#got', limit: 1}, context));
    assert.match(seen.rows[0].text, /received note\.txt/);

    await refusal(h.registry.execute('browser.upload', {selector: '#pick', path: '../secret.txt'}, context),
      /Path denied/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('an element picture of a password box holds no readable password', async () => {
  const h = await harness('browser2-shot');
  try {
    const context = runContext('run-shot');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/form`}, context);
    const shot = ok(await h.registry.execute('browser.screenshot', {selector: 'form'}, context));
    // The runtime only shows the model a picture in this exact shape; the shape is the proof it can.
    assert.equal(shot.mediaType, 'image/png');
    assert.ok(shot.sha256 && shot.bytes > 0 && shot.path);
    const bytes = await readFile(shot.path);
    assert.equal(bytes.includes(Buffer.from(password, 'utf8')), false, 'no password bytes in the picture');
    // Reading the box back as text does not hand the password over either...
    const blacked = ok(await h.registry.execute('browser.shape', {
      fields: {value: {selector: '#pw', attribute: 'value'}},
    }, context));
    assert.equal(blacked.rows[0].value, '(hidden)', 'page text never carries the password');
    // ...and the value is still in the page (a saved page, which cannot be covered, is refused for it): only the picture hides it.
    await assert.rejects(h.registry.execute('browser.pdf', {}, context), /holds a password/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('things on the page are numbered and keep their numbers when the page redraws itself', async () => {
  const h = await harness('browser2-marks');
  try {
    const context = runContext('run-marks');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/rerender`}, context);
    const first = ok(await h.registry.execute('browser.annotate', {}, context));
    const alpha = first.marks.find(mark => mark.name === 'Alpha');
    const beta = first.marks.find(mark => mark.name === 'Beta');
    assert.ok(alpha && beta, 'both buttons are numbered');
    assert.match(first.map, /^\[\d+\] button "Alpha"$/m);

    // The page throws its buttons away and draws them back in a different order, with a new one.
    ok(await h.registry.execute('browser.act', {action: 'click', name: 'Shuffle'}, context));
    const second = ok(await h.registry.execute('browser.annotate', {}, context));
    assert.equal(second.marks.find(mark => mark.name === 'Alpha').id, alpha.id, 'Alpha keeps its number');
    assert.equal(second.marks.find(mark => mark.name === 'Beta').id, beta.id, 'Beta keeps its number');
    const gamma = second.marks.find(mark => mark.name === 'Gamma');
    assert.ok(gamma && ![alpha.id, beta.id].includes(gamma.id), 'the new button gets a number of its own');

    // The labels are decoration: the page's own description never mentions them.
    const snapshot = ok(await h.registry.execute('browser.snapshot', {}, context));
    assert.equal(snapshot.accessibility.includes('branch-mark-layer'), false);
    ok(await h.registry.execute('browser.unmark', {}, context));
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('a page cannot claim a number and steer a press onto the wrong thing', async () => {
  const h = await harness('browser2-spoof');
  try {
    const context = runContext('run-spoof');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/spoof`}, context);
    const marked = ok(await h.registry.execute('browser.annotate', {}, context));
    const real = marked.marks.find(mark => mark.name === 'Real button');
    assert.ok(real, 'the real button was numbered');

    // The page put "1" on a decoy before Branch arrived; that number now belongs to whatever Branch
    // gave it to, and pressing it lands on the real button rather than the decoy.
    ok(await h.registry.execute('browser.act', {action: 'click', mark: real.id}, context));
    const hit = ok(await h.registry.execute('browser.shape', {fields: {what: {selector: '#hit', required: true}}}, context));
    assert.equal(hit.rows[0].what, 'real', 'the press landed on the real button, not the decoy');

    // Now the page copies the real button's number onto the decoy behind Branch's back. Two things
    // wearing one number is refused outright, not settled by taking whichever comes first.
    ok(await h.registry.execute('browser.act', {action: 'click', name: 'Clone the number'}, context));
    await refusal(h.registry.execute('browser.act', {action: 'click', mark: real.id}, context),
      /Nothing on this page matched/);
    const after = ok(await h.registry.execute('browser.shape', {fields: {what: {selector: '#hit', required: true}}}, context));
    assert.equal(after.rows[0].what, 'real', 'the refused press changed nothing');
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('shaped extraction returns data in the shape asked for and refuses what does not fit', async () => {
  const h = await harness('browser2-shape');
  try {
    const context = runContext('run-shape');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/rows`}, context);
    const shaped = ok(await h.registry.execute('browser.shape', {
      rows: 'tr.r',
      fields: {name: {selector: '.n', required: true}, amount: {selector: '.v', type: 'number', required: true},
        due: {selector: '.d', type: 'date', required: true}},
    }, context));
    assert.deepEqual(shaped.rows, [
      {name: 'Rent', amount: 1200, due: '2026-03-01'},
      {name: 'Power', amount: 85, due: '2026-03-04'},
    ]);

    // Asking for a number where there are only words is refused by name rather than guessed at.
    await refusal(h.registry.execute('browser.shape', {
      rows: 'tr.r', fields: {amount: {selector: '.n', type: 'number', required: true}},
    }, context), /amount/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('a renamed selector heals by name, the way that worked is recorded, and a hopeless one stops', async () => {
  const h = await harness('browser2-heal');
  const spans = [];
  h.browser.tracer = {start: (runId, kind, name, attributes) => {
    const row = {runId, kind, name, attributes, status: ''};
    spans.push(row);
    return {end: (status, _message, extra) => { row.status = status; Object.assign(row.attributes, extra); }};
  }};
  try {
    const context = runContext('run-heal');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/renamed`}, context);
    await h.registry.execute('browser.wait', {selector: '#new-save', timeoutMs: 3000}, context);
    // The selector the task remembered is gone; the name on the button still works.
    const healed = ok(await h.registry.execute('browser.act',
      {action: 'click', selector: '#old-save', name: 'Save'}, context));
    assert.equal(healed.foundBy, 'role');
    assert.equal(healed.attempts, 2);
    assert.deepEqual(healed.tried, ['selector', 'role']);
    assert.equal(spans.at(-1).attributes.foundBy, 'role');
    assert.equal(spans.at(-1).attributes.healed, true);

    await refusal(h.registry.execute('browser.act',
      {action: 'click', selector: '#nothing', name: 'Nowhere', mark: 99}, context),
      /after 4 tries \(selector, role, text, mark\)/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test("in the owner's own browser, a tab Branch opens reaches nothing and is not left behind", async () => {
  // Working in their browser means the guard is on Branch's tab alone: there is no context route,
  // no page watcher and no worker block, because none of those may touch their other tabs. So a tab
  // Branch's tab opened had neither the route nor the pause. Measured before the fix: the website
  // the owner never allowed really served the page, and the tab was still sitting in their window.
  //
  // It cannot be fixed by reacting: the tab's first request is in flight before any guard can be put
  // on it. It is stopped at the source instead, on Branch's tab only -- a window it asks for is not
  // opened, and a link asking for a new tab opens in this one, where everything is already checked.
  let forbiddenHits = 0;
  const forbidden = createServer((_request, response) => {
    forbiddenHits += 1;
    response.writeHead(200, {'content-type': 'text/html'});
    response.end('<!doctype html><body><h1>must not load</h1>');
  });
  forbidden.listen(0, '127.0.0.1');
  await once(forbidden, 'listening');
  const elsewhere = `http://127.0.0.1:${forbidden.address().port}`;

  const h = await harness('browser2-borrow-popup');
  const port = await freePort();
  const owned = await chromium.launchPersistentContext('', {headless: true, args: [`--remote-debugging-port=${port}`]});
  try {
    const theirTabs = owned.pages().filter(page => !page.isClosed()).length;
    h.browser.store = {get: () => ({data: {enabled: true, port, runId: 'run-borrow-popup',
      grantedAt: new Date().toISOString()}}), save: () => undefined};
    const context = runContext('run-borrow-popup');
    ok(await h.registry.execute('browser.borrow', {action: 'borrow'}, context));
    await h.registry.execute('browser.navigate', {url: `${h.origin}/opens?to=${encodeURIComponent(elsewhere)}`}, context);
    // Long enough that a request in flight would have landed and a tab would still be open.
    await new Promise(resolve => { setTimeout(resolve, 2500); });

    assert.equal(forbiddenHits, 0, 'the website that was not allowed was never asked for anything');
    assert.equal(owned.pages().filter(page => !page.isClosed()).length, theirTabs + 1,
      "only Branch's own tab is added to their window");

    // A form asking for a new tab is not a link, and one submitted by script raises no submit event
    // at all. Both were measured escaping before they were covered, so both are asked for here.
    await h.registry.execute('browser.navigate',
      {url: `${h.origin}/opens-form?to=${encodeURIComponent(elsewhere)}`}, context);
    await new Promise(resolve => { setTimeout(resolve, 2500); });

    assert.equal(forbiddenHits, 0, 'nor by a form asking for a new tab, submitted by script');
    assert.equal(owned.pages().filter(page => !page.isClosed()).length, theirTabs + 1,
      'and their window still has only their tabs and ours');

    // A background worker answers requests from outside the page, where neither the route nor the
    // pause can see it. Branch's own window blocks workers outright; the owner's cannot be
    // reconfigured, so the page is stopped from starting one.
    await h.registry.execute('browser.navigate',
      {url: `${h.origin}/worker?to=${encodeURIComponent(`${elsewhere}/from-worker`)}`}, context);
    await new Promise(resolve => { setTimeout(resolve, 4000); });

    assert.equal(forbiddenHits, 0, 'nor by a background worker the page tried to start');

    // Every other way a page says "open this in a new tab", and the ways round the worker block, measured
    // escaping before this (NAS b7f2560): each one opens here or not at all, and reaches nothing.
    let opened = 0;
    owned.on('page', () => { opened += 1; });
    for (const where of ['opens-base', 'opens-area', 'opens-formtarget', 'opens-detached', 'opens-detached-dispatch', 'opens-shadow']) {
      await h.registry.execute('browser.navigate', {url: `${h.origin}/${where}?to=${encodeURIComponent(elsewhere)}`}, context);
      await new Promise(resolve => { setTimeout(resolve, 2500); });
      assert.equal(forbiddenHits, 0, `nor by ${where}`);
      assert.equal(owned.pages().filter(page => !page.isClosed()).length, theirTabs + 1, `and ${where} left no tab behind`);
      assert.equal(opened, 0, `${where} opened in Branch's own tab, not a new one`);
    }
    // A real click (the assistant pressing it) on a link inside a closed shadow root: the window sees only the host.
    await h.registry.execute('browser.navigate', {url: `${h.origin}/opens-shadow-click?to=${encodeURIComponent(elsewhere)}`}, context);
    await h.registry.execute('browser.act', {action: 'click', selector: '#h', name: 'Open'}, context).catch(() => undefined);
    await new Promise(resolve => { setTimeout(resolve, 2500); });
    assert.equal(forbiddenHits, 0, 'nor by a link clicked inside a closed shadow root');
    assert.equal(opened, 0, "that link opened in Branch's own tab, not a new one");
    // The page has the last word inside itself, so these may open a tab: the window's route gives it nothing,
    // and it is closed. What matters is that the unlisted website is never asked and nothing is left behind.
    const escapes = [['escape-b14', {tool: 'browser.click', args: {role: 'link', name: 'Next'}}],
      ['escape-b16', {tool: 'browser.click', args: {role: 'button', name: 'Send it'}}],
      ['escape-b12', {tool: 'browser.act', args: {action: 'click', selector: '#h', name: 'Open'}}], ['escape-b10', null]];
    for (const [where, press] of escapes) {
      await h.registry.execute('browser.navigate', {url: `${h.origin}/${where}?to=${encodeURIComponent(elsewhere)}`}, context);
      if (press) await h.registry.execute(press.tool, press.args, context).catch(() => undefined);
      await new Promise(resolve => { setTimeout(resolve, 2500); });
      assert.equal(forbiddenHits, 0, `nor by ${where}`);
      assert.equal(owned.pages().filter(page => !page.isClosed()).length, theirTabs + 1, `and ${where} left no tab behind`);
    }
    await h.registry.execute('browser.navigate',
      {url: `${h.origin}/worker-around?to=${encodeURIComponent(`${elsewhere}/from-worker`)}`}, context);
    await new Promise(resolve => { setTimeout(resolve, 4000); });
    assert.equal(forbiddenHits, 0, 'nor by a worker started round the block');
  } finally {
    await h.close();
    await owned.close().catch(() => undefined);
    forbidden.close();
    await once(forbidden, 'close');
  }
});
test("in the owner's own browser, a frame from another website cannot be sent to an unlisted one", async () => {
  // The owner's Chrome keeps each website in a process of its own, so a frame from another website is outside
  // the pause on Branch's tab, and Chromium follows its redirects there without asking (NAS 6e33be0). Its
  // requests are sent with redirects refused instead. Branch's own window keeps such a frame in the page's
  // process (measured), which is why this is asked of a browser started the way Chrome starts: --site-per-process.
  let forbiddenHits = 0;
  const forbidden = createServer((_request, response) => { forbiddenHits += 1; response.end('must not load'); });
  forbidden.listen(0, '127.0.0.1');
  await once(forbidden, 'listening');
  const elsewhere = `http://127.0.0.1:${forbidden.address().port}`;
  const framedAsked = [];
  const framed = createServer((request, response) => {
    framedAsked.push(request.url);
    if (request.url === '/f') {
      response.writeHead(200, {'content-type': 'text/html'});
      response.end('<!doctype html><script>fetch("/r").catch(() => {}); setTimeout(() => { location = "/r2"; }, 300);</script>');
      return;
    }
    response.writeHead(302, {location: `${elsewhere}/stolen`});
    response.end();
  });
  framed.listen(0, '127.0.0.1');
  await once(framed, 'listening');
  const framedOrigin = `http://localhost:${framed.address().port}`; // another website: a separate process in Chrome

  const h = await harness('browser2-borrow-frame', {}, [framedOrigin]);
  const port = await freePort();
  const owned = await chromium.launchPersistentContext('', {headless: true, args: [`--remote-debugging-port=${port}`, '--site-per-process']});
  try {
    h.browser.store = {get: () => ({data: {enabled: true, port, runId: 'run-borrow-frame',
      grantedAt: new Date().toISOString()}}), save: () => undefined};
    const context = runContext('run-borrow-frame');
    ok(await h.registry.execute('browser.borrow', {action: 'borrow'}, context));
    await h.registry.execute('browser.navigate', {url: `${h.origin}/framing?src=${encodeURIComponent(`${framedOrigin}/f`)}`}, context);
    for (let waited = 0; waited < 50 && !(framedAsked.includes('/r') && framedAsked.includes('/r2')); waited++)
      await new Promise(resolve => { setTimeout(resolve, 100); });
    await new Promise(resolve => { setTimeout(resolve, 500); });
    assert.ok(framedAsked.includes('/r') && framedAsked.includes('/r2'), `the frame really asked: ${framedAsked.join(' ')}`);
    assert.equal(forbiddenHits, 0, "neither the frame's fetch nor its own navigation was sent onwards");
  } finally {
    await h.close();
    await owned.close().catch(() => undefined);
    for (const server of [forbidden, framed]) { server.close(); await once(server, 'close'); }
  }
});

test('the borrowed browser reuses its cookies, refuses a bank, and is let go without being closed', async () => {
  // A bank is on the allowed list on purpose: the refusal being proved is the borrowing one, not
  // the ordinary website list, which would otherwise stop the address first and prove nothing.
  const h = await harness('browser2-cdp', {}, ['https://secure.chase.com']);
  // A headless Chromium this test starts itself, standing in for the owner's own browser.
  const port = await freePort();
  const owned = await chromium.launchPersistentContext('', {headless: true, args: [`--remote-debugging-port=${port}`]});
  try {
    const seed = await owned.newPage();
    await seed.goto(`${h.origin}/cookie`);
    await seed.evaluate(() => { document.cookie = 'branch_borrowed=knows-me-4242; max-age=600; path=/'; });
    const theirTabs = owned.pages().filter(page => !page.isClosed());
    const before = theirTabs.length;

    h.browser.store = {get: () => ({data: {enabled: true, port, runId: 'run-borrow',
      grantedAt: new Date().toISOString()}}), save: () => undefined};
    const context = runContext('run-borrow');
    const borrowed = ok(await h.registry.execute('browser.borrow', {action: 'borrow'}, context));
    assert.equal(borrowed.using, 'your own browser');
    assert.ok(borrowed.version.length > 0);

    await h.registry.execute('browser.navigate', {url: `${h.origin}/cookie`}, context);
    const seen = ok(await h.registry.execute('browser.extract', {selector: '#who', limit: 1}, context));
    assert.match(seen.rows[0].text, /knows-me-4242/, 'the sign-in the owner already had is reused');

    // The bank is on the allowed website list, so the refusal that stops it can only be the
    // borrowing one — the plain website list would have let it through.
    await refusal(h.registry.execute('browser.navigate', {url: 'https://secure.chase.com/login'}, context),
      /will not use your own browser/);
    assert.equal(attachedAddressRefusal(`${h.origin}/`), null);
    // A recording would photograph their other tabs, so the two are never on at once.
    await refusal(h.registry.execute('browser.recording', {action: 'start'}, context),
      /working in your own browser/);

    ok(await h.registry.execute('browser.borrow', {action: 'give back'}, context));
    // Letting go never closes the owner's browser, and never closes a tab of theirs. Counted
    // before anything new is opened, or the check would pass whatever Branch had done.
    assert.equal(owned.pages().filter(page => !page.isClosed()).length, before, 'their tab count is unchanged');
    for (const tab of theirTabs) assert.equal(tab.isClosed(), false, 'every tab of theirs is still open');
    const after = await owned.newPage();
    await after.goto(`${h.origin}/`);
    assert.equal(await after.title(), 'Fixture', 'their browser is still working');
    await after.close();
  } finally { await owned.close(); await h.close(); }
});

test('the switch for the owner\'s own browser is off by default, tied to one task, and runs out', () => {
  assert.match(attachRefusal({enabled: false, port: 9222, runId: '', grantedAt: ''}, 'r1') ?? '', /not allowed/);
  const fresh = {enabled: true, port: 9222, runId: 'r1', grantedAt: new Date().toISOString()};
  assert.equal(attachRefusal(fresh, 'r1'), null);
  assert.match(attachRefusal(fresh, 'r2') ?? '', /different task/);
  assert.match(attachRefusal({...fresh, grantedAt: new Date(Date.now() - 3.6e6).toISOString()}, 'r1') ?? '', /run out/);
  assert.match(hostRefusalFor('vault.bitwarden.com') ?? '', /money or passwords/);
  assert.match(hostRefusalFor('my-local-bank.example') ?? '', /looks like a bank/);
  assert.equal(hostRefusalFor('example.com'), null);
});

test('a kept recording exists, is a real archive, and holds no password and no key', async () => {
  const h = await harness('browser2-trace');
  try {
    const context = runContext('run-trace');
    ok(await h.registry.execute('browser.recording', {action: 'start'}, context));
    await h.registry.execute('browser.navigate', {url: `${h.origin}/form`}, context);
    // Typing a password is refused outright, so no password can reach a recorded step either.
    await refusal(h.registry.execute('browser.act',
      {action: 'fill', selector: '#pw', value: sessionToken}, context), /Password fields/);
    ok(await h.registry.execute('browser.act', {action: 'fill', selector: '#who', value: 'Jane'}, context));
    const kept = ok(await h.registry.execute('browser.recording', {action: 'keep'}, context));

    const bytes = await readFile(kept.path);
    const entries = recordingEntries(bytes);
    assert.ok(entries.has('trace.trace'), 'the recording really is a Playwright trace');
    assert.ok(bytes.length > 0 && kept.bytes === bytes.length);
    // The proof has to be against the unpacked text: a search of the packed bytes proves nothing.
    const text = recordingText(bytes);
    assert.ok(text.length > 100, 'the recording was unpacked, not searched while squashed');
    assert.equal(text.includes(password), false, 'no password value anywhere in the recording');
    assert.equal(text.includes(sessionToken), false, 'no key anywhere in the recording');
    assert.deepEqual(leaksIn(bytes, [password, sessionToken]), []);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

/**
 * mac7/vault-autofill (integration review). The recording above holds no password only because
 * `browser.fill`/`browser.act` refuse a password box outright. A recording DOES write down what
 * every step was asked to type — that is proven here with an ordinary word, against the real
 * Playwright — so filling a saved sign-in, which really does type a password, refuses outright
 * while one is being kept rather than trusting anything in browser-trace.ts.
 */
test('a recording writes down what a step was asked to type, so a sign-in is refused while one is kept', async () => {
  const h = await harness('browser2-trace-signin');
  try {
    const context = runContext('run-trace-signin');
    ok(await h.registry.execute('browser.recording', {action: 'start'}, context));
    await h.registry.execute('browser.navigate', {url: `${h.origin}/form`}, context);
    ok(await h.registry.execute('browser.act', {action: 'fill', selector: '#who', value: 'Rumpelstiltskin'}, context));

    // The page says the sign-in is being recorded, and typing into it is refused before anything else.
    const page = h.browser.signInPage();
    assert.equal((await page.where(context)).recording, true, 'the sign-in filling is not told a recording is being kept');
    await assert.rejects(() => page.type(context, 'password', undefined, 'never-typed-anywhere-42'), /recording/i);

    const bytes = await readFile((ok(await h.registry.execute('browser.recording', {action: 'keep'}, context))).path);
    const text = recordingText(bytes);
    assert.ok(text.includes('Rumpelstiltskin'),
      'a recording no longer writes down what a step typed, so the reason for this refusal needs rechecking');
    assert.equal(text.includes('never-typed-anywhere-42'), false, 'the refused value reached the recording');
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('a task keeping a recording cannot then borrow the owner\'s browser', async () => {
  const h = await harness('browser2-trace-borrow');
  h.browser.store = {get: () => ({data: {enabled: true, port: 9412, runId: 'run-both',
    grantedAt: new Date().toISOString()}}), save: () => undefined};
  try {
    const context = runContext('run-both');
    ok(await h.registry.execute('browser.recording', {action: 'start'}, context));
    await refusal(h.registry.execute('browser.borrow', {action: 'borrow'}, context),
      /keeping a recording/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('the shared way of saying "look at this, press that" goes to the page or to a window', async () => {
  const h = await harness('browser2-computer');
  const asked = [];
  const window = {
    read: async input => { asked.push(['read', input.window]); return {window: input.window, parts: []}; },
    click: async input => { asked.push(['click', input.window]); return {clicked: input.name}; },
    type: async input => { asked.push(['type', input.window]); return {typed: input.text}; },
  };
  registerComputer(h.registry, {page: h.browser, window});
  assert.equal(inferToolGroup('computer.look'), 'desktop', 'the new tools belong in a toolbox');
  try {
    const context = runContext('run-facade', 'test', ['desktop.view', 'desktop.control']);
    await h.registry.execute('browser.navigate', {url: `${h.origin}/form`}, context);
    const page = ok(await h.registry.execute('computer.look', {at: 'page'}, context));
    assert.equal(page.at, 'page');
    assert.ok(page.marks.some(mark => mark.name === 'Save it'), 'the page was numbered, not a window read');
    assert.equal(asked.length, 0, 'nothing went to the screen layer');

    const inWindow = ok(await h.registry.execute('computer.look', {at: 'window', window: 'Notepad'}, context));
    assert.equal(inWindow.at, 'window');
    assert.deepEqual(asked, [['read', 'Notepad']]);
    ok(await h.registry.execute('computer.type', {at: 'window', window: 'Notepad', name: 'Body', text: 'hello'}, context));
    assert.deepEqual(asked.at(-1), ['type', 'Notepad']);

    // A task that may use the browser but not the screen cannot reach a window through this.
    await refusal(h.registry.execute('computer.look', {at: 'window', window: 'Notepad'}, runContext('run-facade-2')),
      /desktop\.view/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('each search service is asked in its own way and its answer is read correctly', () => {
  const settings = {backend: 'brave', keySecret: 'BRAVE_KEY'};
  const brave = requestFor(settings, 'garden gates', 3, 'k-123');
  assert.equal(brave.method, 'GET');
  assert.match(brave.url, /api\.search\.brave\.com/);
  assert.equal(brave.headers['x-subscription-token'], 'k-123');
  assert.deepEqual(parseResults('brave', JSON.stringify({web: {results: [
    {title: 'Gates', url: 'https://example.com/g', description: 'About <b>gates</b>'},
  ]}})), [{title: 'Gates', url: 'https://example.com/g', snippet: 'About gates'}]);

  const tavily = requestFor({backend: 'tavily', keySecret: 'T'}, 'q', 2, 'k-9');
  assert.equal(tavily.method, 'POST');
  assert.equal(tavily.headers.authorization, 'Bearer k-9');
  assert.deepEqual(parseResults('tavily', JSON.stringify({results: [
    {title: 'T', url: 'https://example.com/t', content: 'body'},
  ]})), [{title: 'T', url: 'https://example.com/t', snippet: 'body'}]);

  assert.deepEqual(parseResults('exa', JSON.stringify({results: [{title: 'E', url: 'https://example.com/e'}]})),
    [{title: 'E', url: 'https://example.com/e', snippet: ''}]);
  assert.deepEqual(parseResults('serper', JSON.stringify({organic: [{title: 'S', link: 'https://example.com/s', snippet: 'x'}]})),
    [{title: 'S', url: 'https://example.com/s', snippet: 'x'}]);

  const searx = requestFor({backend: 'searxng', searxngUrl: 'http://127.0.0.1:8080/'}, 'q', 5, '');
  assert.equal(searx.url, 'http://127.0.0.1:8080/search?q=q&format=json');
  assert.deepEqual(parseResults('searxng', JSON.stringify({results: [{title: 'X', url: 'https://example.com/x', content: 'c'}]})),
    [{title: 'X', url: 'https://example.com/x', snippet: 'c'}]);

  assert.throws(() => requestFor({backend: 'searxng'}, 'q', 5, ''), /address of your SearXNG/);
  assert.throws(() => parseResults('brave', 'not json'), /not results/);
  // The free fallback still goes where it always went, so nothing already set up changes.
  assert.equal(requestFor({backend: 'duckduckgo'}, 'q', 5, '', 'http://127.0.0.1:1/lite/').url, 'http://127.0.0.1:1/lite/');
});

test('the shipped browser skills pack, read back, and describe steps the fixtures really support', async () => {
  assert.deepEqual(browserSkillNames.slice().sort(),
    ['fill-a-form-from-a-document', 'read-several-pages-of-one-site', 'search-and-summarise',
      'watch-a-page-for-a-change', 'write-a-site-skill']);
  for (const name of browserSkillNames) {
    const {manifest, files} = readSkillPackage(browserSkillPackage(name));
    assert.equal(manifest.name, name);
    assert.equal(manifest.format, 'branch-skill-package');
    assert.deepEqual(manifest.permissions, ['skills.read'], 'a skill of instructions asks for nothing else');
    assert.ok(files['SKILL.md'].length > 200);
  }
  assert.equal(browserSkillList().length, 5);

  // What "fill a form from a document" tells the assistant to do is run against the fixture form.
  const h = await harness('browser2-skills');
  try {
    const context = runContext('run-skill');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/form`}, context);
    const marks = ok(await h.registry.execute('browser.annotate', {}, context));
    const box = marks.marks.find(mark => mark.name === 'Your name');
    assert.ok(box, 'the skill\'s step 2 finds the numbered boxes it talks about');
    ok(await h.registry.execute('browser.act', {action: 'fill', mark: box.id, value: 'Jane Doe'}, context));
    const filled = ok(await h.registry.execute('browser.shape', {
      fields: {echo: {selector: '#echo', required: true}},
    }, context));
    assert.equal(filled.rows[0].echo, 'name is Jane Doe');
    // Step 6: the skill never submits, and the password box it is told to leave alone refuses.
    await refusal(h.registry.execute('browser.act',
      {action: 'fill', mark: marks.marks.find(m => m.name === 'Password').id, value: 'x'}, context),
      /Password fields/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('connecting to a browser that is not there says so in plain words', async () => {
  await assert.rejects(() => attach(9),
    /could not find a browser listening on door 9/);
});
