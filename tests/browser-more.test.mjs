import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, writeFile, rm, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BranchBrowser, registerBrowser} from '../dist/integrations/browser.js';
import {BrowserProfiles} from '../dist/integrations/browser-profiles.js';
import {WorkspaceFiles} from '../dist/files.js';
import {RunArtifacts, ToolRegistry, Budget, createBranch, savePolicy, OpenAIProvider, AnthropicProvider} from '../dist/index.js';
import { chromium } from "playwright";

const key = {key: async () => Buffer.alloc(32, 7)};
const runContext = (runId, owner = 'test', signal = new AbortController().signal) => ({
  owner, workspace: '.', runId, signal, budget: new Budget(),
  permissions: new Set(['browser.read', 'browser.interact']), depth: 0,
});

async function scratch(label) {
  const base = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'claude-session-files');
  await mkdir(base, {recursive: true});
  return mkdtemp(join(base, `${label}-`));
}

const page = body => `<!doctype html><meta charset="utf-8"><title>Fixture</title>${body}`;
const routes = {
  '/set-cookie': page('<p>signed in</p><script>document.cookie="branch_demo=keep-me-9876; max-age=600; path=/"</script>'),
  '/whoami': page('<p id="who">?</p><script>document.getElementById("who").textContent="cookie is "+document.cookie</script>'),
  '/table': page(`<table><tbody>
    <tr><td>Rent</td><td>1200</td></tr><tr><td>Power</td><td>85</td></tr></tbody></table>
    <p id="later">not yet</p><script>setTimeout(()=>{document.getElementById("later").textContent="all done"},300)</script>`),
  '/dialog': page('<button onclick="alert(\'Your session will expire\')">Warn</button>'),
  '/upload': page('<input id="pick" type="file"><p id="got">nothing</p><script>document.getElementById("pick").addEventListener("change",e=>{document.getElementById("got").textContent="received "+e.target.files[0].name+" of "+e.target.files[0].size+" bytes"})</script>'),
  '/grab': page('<a id="dl" href="/report.csv" download="report.csv">Get report</a><a href="/thing.exe" download="thing.exe">Get program</a>'),
  '/secret-filled': page('<label>Pass<input type="password" value="hunter2-super-secret"></label>'),
  '/secret-empty': page('<label>Pass<input type="password" value=""></label>'),
  '/': page('<p>home</p>'),
};
async function fixture() {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path === '/report.csv') {
      response.writeHead(200, {'content-type': 'text/csv'});
      response.end('item,amount\nRent,1200\n');
      return;
    }
    if (path === '/thing.exe') {
      response.writeHead(200, {'content-type': 'application/octet-stream'});
      response.end('MZ not really a program');
      return;
    }
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end(routes[path] ?? routes['/']);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {server, origin, stop: async () => { server.close(); await once(server, 'close'); }};
}

/** A browser with saved sign-ins, a place for screenshots, and a workspace, all in one scratch folder. */
async function harness(label, config = {}) {
  const root = await scratch(label);
  const workspace = join(root, 'workspace'), data = join(root, 'data');
  await mkdir(workspace, {recursive: true});
  await mkdir(data, {recursive: true});
  const {server, origin, stop} = await fixture();
  const browser = new BranchBrowser({allowedOrigins: [origin], ...config});
  browser.profiles = new BrowserProfiles(join(data, 'browser-profiles'), key);
  browser.artifacts = new RunArtifacts(join(data, 'artifacts'));
  browser.files = new WorkspaceFiles(workspace);
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  return {root, workspace, data, origin, browser, registry, server,
    close: async () => { await browser.close(); await stop(); await rm(root, {recursive: true, force: true}); }};
}


test("this test needs a real browser, and says so", () => {
  // It drives one through Branch's own browser tool rather than importing Playwright to steer it, so
  // without this the file looks like a test that needs nothing and the lane that runs it installs no
  // browser. The import above is what the test selector reads; this asserts it is really there.
  assert.equal(chromium.name(), "chromium", "this test declares the browser engine it requires");
});

test('a saved sign-in keeps a cookie across two tasks and holds nothing readable on disk', async () => {
  const h = await harness('browser-profile');
  try {
    const first = runContext('run-one');
    await h.registry.execute('browser.profile', {action: 'create', name: 'demo-site'}, first);
    await h.registry.execute('browser.profile', {action: 'use', name: 'demo-site'}, first);
    await h.registry.execute('browser.navigate', {url: `${h.origin}/set-cookie`}, first);
    await h.registry.finishRun(first);

    const folder = join(h.data, 'browser-profiles');
    const [owner] = await readdir(folder);
    const raw = await readFile(join(folder, owner, 'demo-site.bin'));
    assert.equal(raw.includes('keep-me-9876'), false, 'the cookie value must not be readable on disk');
    assert.equal(raw.includes('branch_demo'), false, 'the cookie name must not be readable on disk');

    const second = runContext('run-two');
    await h.registry.execute('browser.profile', {action: 'use', name: 'demo-site'}, second);
    await h.registry.execute('browser.navigate', {url: `${h.origin}/whoami`}, second);
    const snapshot = await h.registry.execute('browser.snapshot', {}, second);
    assert.match(snapshot.accessibility, /keep-me-9876/);
    await h.registry.finishRun(second);

    const listed = await h.registry.execute('browser.profile', {action: 'list'}, runContext('run-three'));
    assert.deepEqual(listed.profiles.map(p => p.name), ['demo-site']);
    assert.ok(listed.profiles[0].cookies >= 1);
    await assert.rejects(h.registry.execute('browser.profile', {action: 'use', name: 'no-such'}, runContext('run-four')),
      /no saved sign-in called/);
  } finally { await h.close(); }
});

test('a sign-in cannot be chosen once the task already has a browser window open', async () => {
  const h = await harness('browser-profile-late');
  try {
    const context = runContext('late');
    await h.registry.execute('browser.profile', {action: 'create', name: 'later'}, context);
    await h.registry.execute('browser.navigate', {url: h.origin}, context);
    await assert.rejects(h.registry.execute('browser.profile', {action: 'use', name: 'later'}, context),
      /before opening a page/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('waiting and extracting read a table as rows, and tabs can be opened and switched', async () => {
  const h = await harness('browser-extract');
  try {
    const context = runContext('extract');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/table`}, context);
    const waited = await h.registry.execute('browser.wait', {text: 'all done', timeoutMs: 5000}, context);
    assert.match(waited.waitedFor, /all done/);
    const plain = await h.registry.execute('browser.extract', {selector: 'tbody tr'}, context);
    assert.deepEqual(plain.rows, [
      {column1: 'Rent', column2: '1200'}, {column1: 'Power', column2: '85'},
    ]);
    const named = await h.registry.execute('browser.extract',
      {selector: 'tbody tr', fields: {item: 'td:nth-child(1)', amount: 'td:nth-child(2)'}}, context);
    assert.deepEqual(named.rows[0], {item: 'Rent', amount: '1200'});
    assert.equal(named.matched, 2);

    const opened = await h.registry.execute('browser.tab', {action: 'open'}, context);
    assert.equal(opened.tabs.length, 2);
    await h.registry.execute('browser.navigate', {url: `${h.origin}/`}, context);
    assert.match((await h.registry.execute('browser.snapshot', {}, context)).accessibility, /home/);
    await h.registry.execute('browser.tab', {action: 'select', index: 0}, context);
    assert.match((await h.registry.execute('browser.snapshot', {}, context)).accessibility, /Rent/);
    const closed = await h.registry.execute('browser.tab', {action: 'close', index: 1}, context);
    assert.equal(closed.tabs.length, 1);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('the current page can be saved as a PDF beside the private database', async () => {
  const h = await harness('browser-pdf');
  try {
    const context = runContext('pdf');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/table`}, context);
    const saved = await h.registry.execute('browser.pdf', {}, context);
    assert.equal(saved.mediaType, 'application/pdf');
    const bytes = await readFile(saved.path);
    assert.equal(bytes.subarray(0, 5).toString('utf8'), '%PDF-');
    assert.equal(bytes.byteLength, saved.bytes);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('a message box from the website is dismissed and reported instead of stopping the task', async () => {
  const h = await harness('browser-dialog');
  try {
    const context = runContext('dialog');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/dialog`}, context);
    const clicked = await h.registry.execute('browser.click', {role: 'button', name: 'Warn'}, context);
    assert.equal(clicked.messageBoxes.length, 1);
    assert.equal(clicked.messageBoxes[0].kind, 'alert');
    assert.match(clicked.messageBoxes[0].message, /session will expire/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('files go to the website only from the workspace, and files it sends land in downloads', async () => {
  const h = await harness('browser-transfer');
  try {
    await writeFile(join(h.workspace, 'notes.txt'), 'twenty-four bytes here!!');
    await writeFile(join(h.workspace, '.branchignore'), 'private/\n');
    await mkdir(join(h.workspace, 'private'), {recursive: true});
    await writeFile(join(h.workspace, 'private', 'diary.txt'), 'not for websites');
    const context = runContext('transfer');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/upload`}, context);
    await h.registry.execute('browser.upload', {selector: '#pick', path: 'notes.txt'}, context);
    assert.match((await h.registry.execute('browser.snapshot', {}, context)).accessibility, /received notes.txt of 24 bytes/);
    await assert.rejects(h.registry.execute('browser.upload', {selector: '#pick', path: '../outside.txt'}, context),
      /traversal|outside workspace/);
    await assert.rejects(h.registry.execute('browser.upload', {selector: '#pick', path: 'private/diary.txt'}, context),
      /branchignore/);

    await h.registry.execute('browser.navigate', {url: `${h.origin}/grab`}, context);
    const got = await h.registry.execute('browser.click', {role: 'link', name: 'Get report'}, context);
    assert.equal(got.downloads.length, 1);
    assert.equal(got.downloads[0].file, 'downloads/report.csv');
    assert.equal(await readFile(join(h.workspace, 'downloads', 'report.csv'), 'utf8'), 'item,amount\nRent,1200\n');
    const refused = await h.registry.execute('browser.click', {role: 'link', name: 'Get program'}, context);
    assert.match(refused.downloads[0].from, /files ending in \.exe are not saved/);
    assert.equal(refused.downloads[0].file, '');
    // SCREEN-021: the owner's view keeps the session's completed downloads after the task's once-only events were taken,
    // newest last, with the plain source address (never the refusal's words) and the refusal as an unsaved file.
    const history = [...h.browser.sessions.values()].map((entry) => entry.session.completedDownloads()).find((list) => list.length);
    assert.deepEqual(history.map((one) => one.file), ['downloads/report.csv', '']);
    assert.doesNotMatch(history[1].from, /not saved/);
    assert.match(history[1].from, /^http:\/\/127\.0\.0\.1:\d+\//);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('a task is stopped in plain language once it has opened too many different websites', async () => {
  const other = await fixture();
  const third = await fixture();
  const root = await scratch('browser-origins');
  const first = await fixture();
  const browser = new BranchBrowser({allowedOrigins: [first.origin, other.origin, third.origin], maxOriginsPerRun: 2});
  browser.artifacts = new RunArtifacts(join(root, 'artifacts'));
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  try {
    const context = runContext('origins');
    await registry.execute('browser.navigate', {url: first.origin}, context);
    await registry.execute('browser.navigate', {url: other.origin}, context);
    await assert.rejects(registry.execute('browser.navigate', {url: third.origin}, context),
      /already opened 2 different websites/);
    await registry.execute('browser.navigate', {url: `${first.origin}/table`}, context);
    await registry.finishRun(context);
  } finally {
    await browser.close();
    await Promise.all([first.stop(), other.stop(), third.stop()]);
    await rm(root, {recursive: true, force: true});
  }
});

test('a task is stopped once it has taken too many browser actions', async () => {
  const h = await harness('browser-actions', {maxActionsPerRun: 2});
  try {
    const context = runContext('actions');
    await h.registry.execute('browser.navigate', {url: h.origin}, context);
    await h.registry.execute('browser.snapshot', {}, context);
    await assert.rejects(h.registry.execute('browser.snapshot', {}, context), /already taken 2 browser actions/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('a password box is blacked out before the shutter, so the picture is the same whether it is filled or empty', async () => {
  const h = await harness('browser-redaction');
  try {
    const filled = runContext('filled'), empty = runContext('empty');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/secret-filled`}, filled);
    const a = await h.registry.execute('browser.screenshot', {selector: 'input[type=password]'}, filled);
    await h.registry.execute('browser.navigate', {url: `${h.origin}/secret-empty`}, empty);
    const b = await h.registry.execute('browser.screenshot', {selector: 'input[type=password]'}, empty);
    const [one, two] = await Promise.all([readFile(a.path), readFile(b.path)]);
    assert.equal(one.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'the file is a PNG');
    assert.equal(a.sha256, b.sha256, 'a filled password box must look exactly like an empty one');
    assert.deepEqual(one, two);
    await Promise.all([h.registry.finishRun(filled), h.registry.finishRun(empty)]);
  } finally { await h.close(); }
});

test('a screenshot is kept as a signed run artifact and shown to a model that can look at pictures', async () => {
  const root = await scratch('browser-vision');
  const {origin, stop} = await fixture();
  const seen = [];
  let round = 0;
  const provider = {
    name: 'fake-vision', acceptsImages: true,
    async complete(request) {
      seen.push(request.messages.map(m => ({role: m.role, images: (m.images ?? []).length})));
      if (round === 0) { round++; return {content: '', toolCalls: [
        {id: 'go', name: 'browser.navigate', arguments: JSON.stringify({url: origin})}]}; }
      if (round === 1) { round++; return {content: '', toolCalls: [
        {id: 'shot', name: 'browser.screenshot', arguments: JSON.stringify({})}]}; }
      return {content: 'I looked at the picture.', toolCalls: []};
    },
  };
  const app = await createBranch({workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider});
  const browser = new BranchBrowser({allowedOrigins: [origin]});
  browser.artifacts = app.artifacts;
  registerBrowser(app.registry, browser);
  try {
    const run = await app.runtime.run({prompt: 'look at the page'});
    assert.equal(run.status, 'completed');
    const last = seen.at(-1);
    assert.equal(last.filter(m => m.images > 0).length, 1, 'exactly one picture reached the model');
    assert.equal(last.at(-1).role, 'user');
    const attached = app.store.events(run.id).find(e => e.kind === 'image.attached');
    assert.ok(attached, 'the run records that a picture was attached');

    const completed = app.store.events(run.id).filter(e => e.kind === 'tool.completed' && e.data.name === 'browser.screenshot');
    assert.equal(completed.length, 1);
    assert.ok(completed[0].data.receipt?.mac, 'the screenshot result carries a receipt');
    assert.deepEqual(await app.store.receipts.verify(run.id, completed[0].data), {valid: true});
    const bytes = await readFile(completed[0].data.result.path);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(completed[0].data.result.mediaType, 'image/png');
  } finally {
    await browser.close(); await app.close(); await stop();
    await rm(root, {recursive: true, force: true});
  }
});

test('a model that cannot look at pictures is never sent one', async () => {
  const root = await scratch('browser-novision');
  const {origin, stop} = await fixture();
  const seen = [];
  let round = 0;
  const provider = {
    name: 'fake-text-only',
    async complete(request) {
      seen.push(request.messages);
      if (round === 0) { round++; return {content: '', toolCalls: [
        {id: 'go', name: 'browser.navigate', arguments: JSON.stringify({url: origin})}]}; }
      if (round === 1) { round++; return {content: '', toolCalls: [
        {id: 'shot', name: 'browser.screenshot', arguments: JSON.stringify({})}]}; }
      return {content: 'done', toolCalls: []};
    },
  };
  const app = await createBranch({workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider});
  const browser = new BranchBrowser({allowedOrigins: [origin]});
  browser.artifacts = app.artifacts;
  registerBrowser(app.registry, browser);
  try {
    const run = await app.runtime.run({prompt: 'look at the page'});
    assert.equal(run.status, 'completed');
    assert.equal(seen.at(-1).some(m => m.images?.length), false);
  } finally {
    await browser.close(); await app.close(); await stop();
    await rm(root, {recursive: true, force: true});
  }
});

test('the approval settings ask before a file is sent to a website, but not before a picture is taken', async () => {
  const root = await scratch('browser-approve');
  const {origin, stop} = await fixture();
  const steps = [
    () => ({content: '', toolCalls: [{id: 'go', name: 'browser.navigate', arguments: JSON.stringify({url: `${origin}/upload`})}]}),
    () => ({content: '', toolCalls: [{id: 'shot', name: 'browser.screenshot', arguments: '{}'}]}),
    () => ({content: '', toolCalls: [{id: 'up', name: 'browser.upload', arguments: JSON.stringify({selector: '#pick', path: 'notes.txt'})}]}),
    () => ({content: 'done', toolCalls: []}),
  ];
  let step = 0;
  const provider = {name: 'scripted', async complete() { return steps[Math.min(step++, steps.length - 1)](); }};
  const app = await createBranch({workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider});
  await writeFile(join(root, 'workspace', 'notes.txt'), 'hello');
  const browser = new BranchBrowser({allowedOrigins: [origin]});
  browser.artifacts = app.artifacts;
  browser.files = app.files;
  registerBrowser(app.registry, browser);
  try {
    // The "Just do it inside my workspace" preset asks before a file is sent to a website; the
    // other rules of that preset are dropped here so the task reaches the upload in one go.
    const workspacePreset = savePolicy(app.store, app.runtime.owner, {preset: 'workspace'});
    assert.ok(workspacePreset.rules.some(rule => rule.tool === 'browser.upload' && rule.decision === 'ask'));
    savePolicy(app.store, app.runtime.owner, {rules: workspacePreset.rules.filter(rule => rule.tool === 'browser.upload')});
    const run = await app.runtime.run({prompt: 'send my notes'});
    assert.equal(run.status, 'needs_input');
    assert.match(run.output, /Is that all right\?/);
    const asked = app.store.events(run.id).filter(e => e.kind === 'policy.ask');
    assert.deepEqual(asked.map(e => e.data.name), ['browser.upload']);
    assert.equal(asked.at(-1).data.target, new URL(origin).host);
    const shot = app.store.events(run.id).filter(e => e.kind === 'tool.completed' && e.data.name === 'browser.screenshot');
    assert.equal(shot.length, 1, 'taking a picture is reading, so it is never held up');
  } finally {
    await browser.close(); await app.close(); await stop();
    await rm(root, {recursive: true, force: true});
  }
});

test('a picture reaches OpenAI as a data URL and Anthropic as a base64 image block', async () => {
  const bodies = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(request.url.includes('messages')
        ? JSON.stringify({content: [{type: 'text', text: 'seen'}]})
        : JSON.stringify({choices: [{message: {content: 'seen'}}]}));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const messages = [{role: 'user', content: 'what is this?', images: [{mediaType: 'image/png', data: 'AAAB'}]}];
  const request = {messages, tools: [], signal: new AbortController().signal, maxTokens: 64};
  try {
    await new OpenAIProvider({endpoint, model: 'm', apiKey: 'k'}).complete(request);
    const openai = bodies[0].messages[0].content;
    assert.deepEqual(openai[1], {type: 'image_url', image_url: {url: 'data:image/png;base64,AAAB'}});
    assert.deepEqual(openai[0], {type: 'text', text: 'what is this?'});
    await new AnthropicProvider({endpoint, model: 'm', apiKey: 'k'}).complete(request);
    const anthropic = bodies[1].messages[0].content;
    assert.deepEqual(anthropic[1], {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'AAAB'}});
  } finally { server.close(); await once(server, 'close'); }
});
