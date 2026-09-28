/* RES-710 review: a saved sign-in is typed only into the website it was matched to. A page can move to another website
   between Branch checking the address and Branch typing, and a box found again at typing time would then be the other
   website's. Here the sign-in page sends itself elsewhere while its password box is being looked at; the other page
   reports anything typed into its own password box. Nothing may reach it: the call is refused instead.
   Mutation: in src/integrations/browser.ts signInPage().type, type with found.fill(value) (found again at typing time)
   instead of the held box, without the second address check, and the other website receives the password. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {BranchBrowser, registerBrowser} from '../dist/integrations/browser.js';
import {ToolRegistry, Budget} from '../dist/index.js';

const SECRET = 'page-moves-secret-5517';
const page = (body) => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;

test('a page that moves to another website while its box is found gets nothing typed', async () => {
  const leaks = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture');
    if (url.pathname === '/leak') { leaks.push(url.searchParams.get('v')); response.end('ok'); return; }
    response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    if (url.pathname === '/other') {
      response.end(page(`<input id="pass" type="password"><script>
        const box = document.getElementById("pass");
        setInterval(() => { if (box.value) { fetch("/leak?v=" + encodeURIComponent(box.value)); box.value = ""; } }, 20);</script>`));
      return;
    }
    // The sign-in page: looking at its password box sends it to the other website.
    response.end(page(`<input id="pass" type="password"><script>
      const box = document.getElementById("pass"), to = new URLSearchParams(location.search).get("to");
      let gone = false;
      Object.defineProperty(box, "tagName", { get() { if (!gone) { gone = true; location.href = to; } return "INPUT"; } });</script>`));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port, here = `http://127.0.0.1:${port}`, elsewhere = `http://localhost:${port}`;
  const browser = new BranchBrowser({allowedOrigins: [here, elsewhere]});
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  const context = {owner: 'test', workspace: '.', runId: 'run-page-moves', signal: new AbortController().signal,
    budget: new Budget(), permissions: new Set(['browser.read', 'browser.interact']), depth: 0};
  try {
    await registry.execute('browser.navigate', {url: `${here}/login?to=${encodeURIComponent(`${elsewhere}/other`)}`}, context);
    const signIn = browser.signInPage();
    const typed = await signIn.type(context, 'password', undefined, SECRET, '127.0.0.1').then(() => null, (error) => error);
    // Give the other page time to report anything typed into it.
    await new Promise((done) => setTimeout(done, 600));
    assert.deepEqual(leaks, [], 'the other website received the password');
    assert.match(typed?.message ?? 'typed', /moved to another website|could not (find|type into) that password box/);
    await registry.finishRun(context);
  } finally { await browser.close(); server.close(); await once(server, 'close'); }
});
