import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {BranchBrowser, registerBrowser} from '../dist/integrations/browser.js';
import {SiteSkills, siteSkillsFrom, applyQuirks} from '../dist/integrations/browser-sites.js';
import {markProblem} from '../dist/integrations/browser-heal.js';
import {attachedAddressRefusal} from '../dist/integrations/browser-attach.js';
import {browserSkillNames, browserSkillPackage, browserSkillList} from '../dist/browser-skills.js';
import {packSkill, readSkillPackage, requestedPermissions, declaredSites} from '../dist/skill-package.js';
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

/**
 * The third pass over the browser. Everything here runs against a fixture web server this file
 * starts on the loopback address: no real website is ever opened, and the only browser started is
 * a headless one of the test's own. The borrowing test starts its own headless Chromium with a
 * debugging door, standing in for the owner's browser; the owner's real Chrome is never touched.
 */
const runContext = (runId, owner = 'test', permissions = ['browser.read', 'browser.interact']) => ({
  owner, workspace: '.', runId, signal: new AbortController().signal, budget: new Budget(),
  permissions: new Set(permissions), depth: 0,
});

async function scratch(label) {
  const base = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'claude-session-files');
  await mkdir(base, {recursive: true});
  return mkdtemp(join(base, `${label}-`));
}

const page = body => `<!doctype html><meta charset="utf-8"><title>Fixture</title>${body}`;
const routes = {
  '/': page('<p>home</p>'),
  // The page takes the number off the real button and puts it on a decoy, without ever having two
  // things wearing it at once — the one shape the "no two claimants" rule does not catch.
  '/moved': page(`<button id="decoy" onclick="document.getElementById('hit').textContent='decoy'">Decoy</button>
    <button id="real" onclick="document.getElementById('hit').textContent='real'">Real button</button>
    <button id="move" onclick="(()=>{const r=document.getElementById('real'),d=document.getElementById('decoy');
      const n=r.getAttribute('data-branch-mark');r.removeAttribute('data-branch-mark');d.setAttribute('data-branch-mark',n)})()">Move the number</button>
    <p id="hit">nothing</p>`),
  // A button that takes itself off the page, so its number points at nothing at all.
  '/vanish': page(`<button id="gone" onclick="document.getElementById('hit').textContent='pressed'">Temporary</button>
    <button id="remove" onclick="document.getElementById('gone').remove()">Remove it</button>
    <p id="hit">nothing</p>`),
  // Two buttons that are genuinely alike: same kind, same words, same surroundings.
  '/twins': page(`<div id="box"><button onclick="document.getElementById('hit').textContent='first'">Send</button>
    <button onclick="document.getElementById('hit').textContent='second'">Send</button></div><p id="hit">nothing</p>`),
  '/rebuild': page(`<div id="box"><button class="a" onclick="say('Alpha')">Alpha</button>
      <button class="b" onclick="say('Beta')">Beta</button></div>
    <button id="shuffle" onclick="redraw()">Shuffle</button><p id="hit">nothing</p>
    <script>function say(w){document.getElementById('hit').textContent=w}
    function redraw(){document.getElementById('box').innerHTML=
      '<button class="b" onclick="say(\\'Beta\\')">Beta</button><button class="a" onclick="say(\\'Alpha\\')">Alpha</button>'}</script>`),
  // A shop with a notice over everything and a table drawn a moment after the page opens.
  '/shop': page(`<div id="notice">We use cookies <button id="accept">Accept</button></div>
    <div id="results"></div>
    <script>document.getElementById('accept').onclick=()=>document.getElementById('notice').remove();
    setTimeout(()=>{document.getElementById('results').innerHTML=
      '<table><tr class="line"><td class="name">Tea</td><td class="price">3.50</td></tr>'
      +'<tr class="line"><td class="name">Mug</td><td class="price">8</td></tr></table>'},80)</script>`),
};

/** A one-pixel PNG, so a picture the page asks for is a real answer rather than a guess. */
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

/**
 * Two pictures from the same fixture server under its two names. Nothing asked the browser to open
 * either of them; they are the requests the *page itself* makes, which is the thing being checked.
 */
const imagesPage = origin => page(`<img src="${origin}/pixel.png" onload="done('control','loaded')" onerror="done('control','refused')">
  <img src="${origin.replace('127.0.0.1', 'localhost')}/pixel.png" onload="done('guarded','loaded')" onerror="done('guarded','refused')">
  <p id="hit">nothing</p>
  <script>const seen={};function done(which,how){seen[which]=how;
    if(seen.control&&seen.guarded)document.getElementById('hit').textContent=seen.control+'/'+seen.guarded}</script>`);

async function fixture() {
  let origin = '';
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path === '/pixel.png') {
      response.writeHead(200, {'content-type': 'image/png'});
      response.end(pixel);
      return;
    }
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    response.end(path === '/images' ? imagesPage(origin) : routes[path] ?? routes['/']);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  return {origin, stop: async () => { server.close(); await once(server, 'close'); }};
}

async function harness(label, config = {}, extraOrigins = []) {
  const root = await scratch(label);
  const workspace = join(root, 'workspace'), data = join(root, 'data');
  await mkdir(workspace, {recursive: true});
  await mkdir(data, {recursive: true});
  const {origin, stop} = await fixture();
  // The very same fixture server under its other name is allowed too, so when one of the two
  // is refused below it can only be the borrowing guard that refused it.
  const browser = new BranchBrowser({
    allowedOrigins: [origin, origin.replace('127.0.0.1', 'localhost'), ...extraOrigins], ...config});
  browser.artifacts = new RunArtifacts(join(data, 'artifacts'));
  browser.files = new WorkspaceFiles(workspace);
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  return {root, origin, browser, registry,
    close: async () => { await browser.close(); await stop(); await rm(root, {recursive: true, force: true}); }};
}

const ok = result => result;
const refusal = async (promise, pattern) => {
  await assert.rejects(() => promise, error => { assert.match(error.message, pattern); return true; });
};
const hitText = (h, context) => h.registry.execute('browser.shape',
  {fields: {what: {selector: '#hit', required: true}}}, context).then(seen => seen.rows[0].what);

test('a number moved onto something else is refused rather than pressed', async () => {
  const h = await harness('browser3-moved');
  try {
    const context = runContext('run-moved');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/moved`}, context);
    const marked = ok(await h.registry.execute('browser.annotate', {}, context));
    const real = marked.marks.find(mark => mark.name === 'Real button');
    assert.ok(real, 'the real button was numbered');

    // Behind Branch's back the page takes the number off the real button and puts it on the decoy.
    // Exactly one thing wears it, so counting claimants proves nothing; what the number was handed
    // to is what decides.
    ok(await h.registry.execute('browser.act', {action: 'click', name: 'Move the number'}, context));
    await refusal(h.registry.execute('browser.act', {action: 'click', mark: real.id}, context),
      /is now on a different thing from the one it was given to/);
    assert.equal(await hitText(h, context), 'nothing', 'the refused press pressed nothing at all');
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('a number that has gone, and a number never given out, each say so plainly', async () => {
  const h = await harness('browser3-gone');
  try {
    const context = runContext('run-gone');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/vanish`}, context);
    const marked = ok(await h.registry.execute('browser.annotate', {}, context));
    const temporary = marked.marks.find(mark => mark.name === 'Temporary');
    assert.ok(temporary, 'the button that will go was numbered');

    await refusal(h.registry.execute('browser.act', {action: 'click', mark: 499}, context),
      /Number 499 was never given out on this page/);
    ok(await h.registry.execute('browser.act', {action: 'click', name: 'Remove it'}, context));
    await refusal(h.registry.execute('browser.act', {action: 'click', mark: temporary.id}, context),
      new RegExp(`Number ${temporary.id} is no longer on this page`));
    assert.equal(await hitText(h, context), 'nothing');
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('a number survives the page drawing itself again, and still presses the right thing', async () => {
  const h = await harness('browser3-rebuild');
  try {
    const context = runContext('run-rebuild');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/rebuild`}, context);
    const first = ok(await h.registry.execute('browser.annotate', {}, context));
    const alpha = first.marks.find(mark => mark.name === 'Alpha');
    assert.ok(alpha, 'Alpha was numbered');

    ok(await h.registry.execute('browser.act', {action: 'click', name: 'Shuffle'}, context));
    const second = ok(await h.registry.execute('browser.annotate', {}, context));
    assert.equal(second.marks.find(mark => mark.name === 'Alpha').id, alpha.id, 'Alpha keeps its number');
    // The checking added here must not make a legitimate redraw look like tampering.
    const pressed = ok(await h.registry.execute('browser.act', {action: 'click', mark: alpha.id}, context));
    assert.equal(pressed.foundBy, 'mark');
    assert.equal(await hitText(h, context), 'Alpha', 'the number still reaches the thing it named');
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('why a number could not be used is said in one plain sentence each time', async () => {
  const checks = {keyOf: mark => (mark === 3 ? 'abc' : undefined), liveKey: async () => 'abc'};
  assert.match(await markProblem(7, 1, checks), /Number 7 was never given out/);
  assert.match(await markProblem(3, 0, checks), /no longer on this page/);
  assert.match(await markProblem(3, 2, checks), /on more than one thing/);
  assert.equal(await markProblem(3, 1, checks), '');
  assert.match(await markProblem(3, 1, {...checks, liveKey: async () => 'different'}),
    /now on a different thing/);
  // With nothing known about the numbers, being there is still checked.
  assert.equal(await markProblem(3, 1, {}), '');
  assert.match(await markProblem(3, 0, {}), /no longer on this page/);
});

test('a site skill presses the notice, waits for the table, and reads it by name', async () => {
  const h = await harness('browser3-site');
  try {
    const sites = new SiteSkills();
    sites.add('the-shop', {site: {
      hosts: ['127.0.0.1'], dismiss: ['#accept'], waitFor: '#results table', settleMs: 10,
      readings: {basket: {rows: 'tr.line', fields: {
        item: {selector: '.name', required: true}, price: {selector: '.price', type: 'number', required: true}}}},
      notes: 'The table is drawn after the page opens, so wait for it first.',
    }});
    h.browser.siteSkills = () => sites;
    const context = runContext('run-site');

    const opened = ok(await h.registry.execute('browser.navigate', {url: `${h.origin}/shop`}, context));
    assert.equal(opened.site.skill, 'the-shop');
    assert.deepEqual(opened.site.dismissed, ['#accept'], 'the cookie notice was pressed once');
    assert.equal(opened.site.waited, true, 'it waited for the table the site draws late');
    assert.match(opened.site.notes, /drawn after the page opens/);
    const gone = ok(await h.registry.execute('browser.shape',
      {fields: {notice: {selector: '#notice'}}}, context));
    assert.equal(gone.rows[0].notice, null, 'the notice is off the page');

    const read = ok(await h.registry.execute('browser.site', {action: 'read', name: 'basket'}, context));
    assert.deepEqual(read.rows, [{item: 'Tea', price: 3.5}, {item: 'Mug', price: 8}]);
    assert.equal(read.skill, 'the-shop');
    // A task allowed only to read gets the waiting but never the pressing, and is told so.
    const reader = runContext('run-site-read', 'test', ['browser.read']);
    const opened2 = ok(await h.registry.execute('browser.navigate', {url: `${h.origin}/shop`}, reader));
    assert.deepEqual(opened2.site.dismissed, [], 'a reading task presses nothing');
    assert.deepEqual(opened2.site.notPressed, ['#accept'], 'it is told what it would have pressed');
    const still = ok(await h.registry.execute('browser.shape', {fields: {notice: {selector: '#notice'}}}, reader));
    assert.match(still.rows[0].notice, /We use cookies/, 'the notice is still there');
    await h.registry.finishRun(reader);

    const listed = ok(await h.registry.execute('browser.site', {action: 'list'}, context));
    assert.deepEqual(listed.sites[0].readings, ['basket']);
    await refusal(h.registry.execute('browser.site', {action: 'read', name: 'nothing'}, context),
      /has no reading called "nothing"/);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('a site skill never widens anything and holds no script', () => {
  const sites = new SiteSkills();
  const site = {hosts: ['shop.example.com'], dismiss: ['#accept']};
  assert.throws(() => sites.add('bad', {site: {...site, hosts: ['chase.com']}}), /never opens/);
  assert.throws(() => sites.add('bad', {site: {...site, hosts: ['vault.bitwarden.com']}}), /never opens/);
  assert.throws(() => sites.add('bad', {site: {...site, hosts: ['gmail.com']}}), /never opens/);
  assert.throws(() => sites.add('bad', {site: {...site, hosts: ['my-local-bank.example']}}), /never opens/);
  assert.throws(() => sites.add('bad', {site: {...site, dismiss: ['<script>x()</script>']}}), /never markup or script/);
  assert.throws(() => sites.add('bad', {site: {...site, onOpen: 'alert(1)'}}), /[Uu]nrecognized|[Uu]nexpected/);
  // A skill knows the site it names and no other.
  sites.add('the-shop', {site});
  assert.equal(sites.forUrl('https://shop.example.com/basket')?.skill, 'the-shop');
  assert.equal(sites.forUrl('https://other.example.com/basket'), undefined);
  assert.equal(sites.size, 1);
});

test('only the site skills that are installed and switched on bring quirks', () => {
  const site = JSON.stringify({site: {hosts: ['shop.example.com']}});
  const packages = [
    {skillId: 'on', manifest: {name: 'the-shop'}, files: {'site.json': site}},
    {skillId: 'off', manifest: {name: 'the-other-shop'}, files: {'site.json': site}},
    {skillId: 'on', manifest: {name: 'no-site'}, files: {'SKILL.md': '# nothing'}},
    {skillId: 'on', manifest: {name: 'broken'}, files: {'site.json': 'not json at all'}},
  ];
  const loaded = siteSkillsFrom(packages, new Set(['on']));
  assert.deepEqual(loaded.list().map(entry => entry.skill), ['the-shop']);
});

test('a site block rides inside a skill package and is checked when the package is made', () => {
  const document = ['---', 'name: the-shop', 'description: Knows the quirks of one shop.', '---', '', '# The shop', ''].join('\n');
  const site = JSON.stringify({site: {hosts: ['shop.example.com'], dismiss: ['#accept']}});
  const bytes = packSkill({files: {'SKILL.md': document, 'site.json': site}, author: 'Branch', packageVersion: '1.0.0'});
  const opened = readSkillPackage(bytes);
  assert.equal(opened.manifest.name, 'the-shop');
  assert.ok(opened.files['site.json'], 'the site block survives the round trip');
  // It asks for nothing extra, but the owner is told which websites it claims to know.
  assert.deepEqual(opened.manifest.permissions, ['skills.read']);
  assert.deepEqual(declaredSites(opened.files), ['shop.example.com']);
  assert.match(requestedPermissions(opened.files).map(asked => asked.why).join(' '),
    /Know the quirks of shop\.example\.com: presses #accept when a page opens/);
  assert.throws(() => packSkill({files: {'SKILL.md': document, 'site.json': '{"site":{"hosts":["chase.com"],"run":"x"}}'},
    author: 'Branch', packageVersion: '1.0.0'}), /[Uu]nrecognized|[Uu]nexpected/);
  assert.throws(() => packSkill({files: {'SKILL.md': document, 'quirks.js': 'x'},
    author: 'Branch', packageVersion: '1.0.0'}), /is not one of them/);
});

test('the browser skills that ship cover the site a person uses, and every one packs', () => {
  assert.deepEqual(browserSkillNames, ['search-and-summarise', 'fill-a-form-from-a-document',
    'watch-a-page-for-a-change', 'read-several-pages-of-one-site', 'write-a-site-skill']);
  for (const name of browserSkillNames) {
    const {manifest, files} = readSkillPackage(browserSkillPackage(name));
    assert.equal(manifest.name, name);
    assert.ok(files['SKILL.md'].length > 400, `${name} says something`);
  }
  const listed = browserSkillList();
  assert.equal(listed.length, 5);
  assert.match(listed.find(entry => entry.name === 'read-several-pages-of-one-site').description, /following its own links/);
  assert.equal(inferToolGroup('browser.site'), 'browser');
});

test('a website Branch never opens is refused on every request, not only the first', async () => {
  // A made-up bank on a reserved ending that can never resolve, so even a broken refusal could not
  // reach anything real. It is on the allowed-website list on purpose: the refusal being proved is
  // the borrowing one, which is the only thing that can stop it here.
  const bank = 'https://my-local-bank.example';
  assert.match(attachedAddressRefusal(`${bank}/login`) ?? '', /looks like a bank/);
  assert.match(attachedAddressRefusal('https://vault.bitwarden.com/') ?? '', /money or passwords/);
  assert.match(attachedAddressRefusal('https://mail.google.com/') ?? '', /money or passwords/);
  assert.match(attachedAddressRefusal('https://schwab.com/') ?? '', /money or passwords/);

  const h = await harness('browser3-refused', {}, [bank]);
  const port = await freePort();
  const owned = await chromium.launchPersistentContext('', {headless: true, args: [`--remote-debugging-port=${port}`]});
  try {
    h.browser.store = {get: () => ({data: {enabled: true, port, runId: 'run-refused',
      grantedAt: new Date().toISOString()}}), save: () => undefined};
    const context = runContext('run-refused');
    ok(await h.registry.execute('browser.borrow', {action: 'borrow'}, context));
    // Refused, then an ordinary page works, then refused again: the refusal is not a latch that
    // trips once and then forgets.
    for (const round of [1, 2, 3]) {
      await refusal(h.registry.execute('browser.navigate', {url: `${bank}/login?round=${round}`}, context),
        /looks like a bank/);
      const fine = ok(await h.registry.execute('browser.navigate', {url: `${h.origin}/`}, context));
      assert.equal(fine.title, 'Fixture', `round ${round}: an ordinary website still opens`);
    }
    ok(await h.registry.execute('browser.borrow', {action: 'give back'}, context));
  } finally { await owned.close(); await h.close(); }
});

test('quirks that do not apply are simply not applied, and never fail the page', async () => {
  const h = await harness('browser3-quirkless');
  try {
    const context = runContext('run-quirkless');
    // A skill for a site this page is not on: the page opens with no quirks and says nothing.
    const sites = new SiteSkills();
    sites.add('elsewhere', {site: {hosts: ['shop.example.com'], dismiss: ['#accept']}});
    h.browser.siteSkills = () => sites;
    const plain = ok(await h.registry.execute('browser.navigate', {url: `${h.origin}/`}, context));
    assert.equal(plain.site, undefined, 'a page no skill knows is opened exactly as before');

    // A skill for this site whose selectors match nothing: the page still opens.
    const missing = new SiteSkills();
    const entry = missing.add('hopeful', {site: {hosts: ['127.0.0.1'], dismiss: ['#not-there'], waitFor: '#never'}});
    h.browser.siteSkills = () => missing;
    const opened = ok(await h.registry.execute('browser.navigate', {url: `${h.origin}/`}, context));
    assert.deepEqual(opened.site.dismissed, []);
    assert.equal(opened.site.waited, false, 'a wait that never comes is reported, not thrown');
    assert.equal(typeof applyQuirks, 'function');
    assert.equal(entry.site.settleMs, 0);
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});

test('the refusal applies to every request the page makes, not only the address it was given', async () => {
  const h = await harness('browser3-subrequest');
  const port = await freePort();
  const owned = await chromium.launchPersistentContext('', {headless: true, args: [`--remote-debugging-port=${port}`]});
  try {
    // The owner has added one of the fixture server's two names to their own refused list. Both
    // names answer, and both are on the allowed-website list, so the only thing that can tell them
    // apart is the check Branch puts on every request its borrowed tab makes.
    h.browser.store = {get: () => ({data: {enabled: true, port, runId: 'run-sub',
      grantedAt: new Date().toISOString(), extraRefusedHosts: ['localhost']}}), save: () => undefined};
    const context = runContext('run-sub');
    ok(await h.registry.execute('browser.borrow', {action: 'borrow'}, context));
    ok(await h.registry.execute('browser.navigate', {url: `${h.origin}/images`}, context));
    ok(await h.registry.execute('browser.wait', {text: 'loaded/refused', timeoutMs: 8000}, context));
    assert.equal(await hitText(h, context), 'loaded/refused',
      'the picture from the allowed name loaded; the one from the refused name never left the browser');
    // Asking for the refused name outright is refused in the same words.
    await refusal(h.registry.execute('browser.navigate',
      {url: `${h.origin.replace('127.0.0.1', 'localhost')}/`}, context), /money or passwords/);
    ok(await h.registry.execute('browser.borrow', {action: 'give back'}, context));
  } finally { await owned.close(); await h.close(); }
});

test('two things that are genuinely alike share a number, and that number is refused', async () => {
  const h = await harness('browser3-twins');
  try {
    const context = runContext('run-twins');
    await h.registry.execute('browser.navigate', {url: `${h.origin}/twins`}, context);
    const marked = ok(await h.registry.execute('browser.annotate', {}, context));
    const sends = marked.marks.filter(mark => mark.name === 'Send');
    assert.equal(sends.length, 2, 'both were numbered');
    assert.equal(sends[0].id, sends[1].id, 'and both were given the same number, being alike');
    // Taking whichever comes first is how a press lands on the wrong thing, so neither is pressed.
    await refusal(h.registry.execute('browser.act', {action: 'click', mark: sends[0].id}, context),
      /is on more than one thing, so it was not used/);
    assert.equal(await hitText(h, context), 'nothing');
    await h.registry.finishRun(context);
  } finally { await h.close(); }
});
