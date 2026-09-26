/**
 * The card "How Branch runs on this computer" says, in one line, where Branch's own door listens:
 * on every address, on private IPv4 networks only, or on this computer only, and when the door was
 * closed while Branch ran, why, and whether starting Branch again would open it. The line is made
 * from what `GET /api/listen` says, so these tests read that route from a real Branch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveListenSettings } from "../dist/listen-address.js";

const loopback = { address: "127.0.0.1", internal: true };
const home = { address: "192.168.1.40", internal: false };
const outward = (address) => ({ address, internal: false });
const tick = 40;

const card = () => import("../public/deployment.js");
const words = async (language) =>
  JSON.parse(await readFile(new URL(`../public/locales/${language}.json`, import.meta.url), "utf8"));
/** The line in one language, as the card writes it once that language's words have loaded. */
const inLanguage = (dictionary) => (key, values) =>
  (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));

async function waitFor(check, what) {
  const until = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > until) assert.fail(`${what} (not within 8000 ms)`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/* Redesign: the card "How Branch runs on this computer" and its door line (public/deployment.js doorLine and doorText,
   #listen-door-status in public/index.html) are not in prototype.html: its Settings › Branch itself and Gateway pages
   have no line about where Branch listens, and the new window (public/app/**) draws none. The route the line was made
   from is still Branch's, so the first test keeps every fact the line said, read from GET /api/listen itself; the
   three about the card's own words and markup are skipped. */
test("the route says where the door listens, why it was closed while running, and when a start would open it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-door-card-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  saveListenSettings(app.store, app.runtime.owner, { where: "private-network" });
  let addresses = [loopback, home];
  t.mock.method(console, "log", () => {});
  const server = await startServer(app, {
    dataDir: join(root, "data"), port: 0, listenAddresses: addresses, readListenAddresses: () => addresses, listenCheckMs: tick,
    tailscale: async () => { throw new Error("Tailscale is not asked in this test"); },
  });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const view = () => fetch(`${server.url}/api/listen`, { headers: { authorization: `Bearer ${server.token}` } })
    .then((response) => response.json());
  // Closing the wider socket also lets go of idle connections, so a question asked at that moment may
  // be cut off; asking again is what the card does the next time it is drawn.
  const viewSoon = () => view().catch(() => ({}));

  const wide = await view();
  for (const field of ["listeningOn", "beyondThisComputer", "ipv4Only", "refusal", "closedWhileRunning", "restartOpens"])
    assert.ok(field in wide, `GET /api/listen says ${field}`);
  // What the line said as "beyond this computer, on every address it answers on (0.0.0.0)".
  assert.deepEqual([wide.beyondThisComputer, wide.ipv4Only, wide.listeningOn, wide.closedWhileRunning], [true, null, "0.0.0.0", false]);

  addresses = [loopback, home, outward("203.0.113.7")];
  await waitFor(async () => (await viewSoon()).closedWhileRunning === true, "the door was closed");
  const closed = await view();
  // "on this computer only (127.0.0.1); its door to the private network was closed while Branch was running", and why.
  assert.deepEqual([closed.beyondThisComputer, closed.listeningOn, closed.restartOpens], [false, "127.0.0.1", false]);
  assert.match(closed.refusal, /203\.0\.113\.7/, "and why is Branch's own sentence");

  addresses = [loopback, home];
  await waitFor(async () => (await viewSoon()).restartOpens === true, "the addresses would let a start open it");
  // "This computer's addresses would let it open again: start Branch again to open it."
  const reopenable = await view();
  assert.deepEqual([reopenable.beyondThisComputer, reopenable.listeningOn, reopenable.closedWhileRunning], [false, "127.0.0.1", true]);
});

// Redesign: the door line's words (public/deployment.js doorLine) are not in the new window; see the note above.
test.skip("a door on private IPv4 networks only, and a door kept here at the start, each say so", async () => {
  const { doorLine, doorText } = await card();
  const ipv4 = { listeningOn: "0.0.0.0", beyondThisComputer: true, refusal: null, closedWhileRunning: false, restartOpens: false,
    ipv4Only: "This computer also answers on 2001:db8::5, which is not a private address, so Branch listens on private IPv4 networks only." };
  assert.equal(doorText(doorLine(ipv4)), "Branch listens beyond this computer, on private IPv4 networks only (0.0.0.0).");
  const kept = { listeningOn: "127.0.0.1", beyondThisComputer: false, ipv4Only: null, closedWhileRunning: false, restartOpens: false,
    refusal: "Lockdown is on, so Branch is listening on this computer only." };
  assert.equal(doorText(doorLine(kept)), "Branch listens on this computer only (127.0.0.1). Lockdown is on, so Branch is listening on this computer only.");
  const asked = { ...kept, refusal: null };
  assert.equal(doorText(doorLine(asked)), "Branch listens on this computer only (127.0.0.1).");
});

// Redesign: the door line's words (public/deployment.js doorLine) are not in the new window; see the note above.
test.skip("the line's words are in English and French, with the address in the same place", async () => {
  const { doorLine, doorText } = await card();
  const [english, french] = await Promise.all([words("en"), words("fr")]);
  const views = [
    { listeningOn: "0.0.0.0", beyondThisComputer: true, ipv4Only: null, refusal: null, closedWhileRunning: false, restartOpens: false },
    { listeningOn: "0.0.0.0", beyondThisComputer: true, ipv4Only: "IPv4 only.", refusal: null, closedWhileRunning: false, restartOpens: false },
    { listeningOn: "127.0.0.1", beyondThisComputer: false, ipv4Only: null, refusal: "Why.", closedWhileRunning: true, restartOpens: false },
    { listeningOn: "127.0.0.1", beyondThisComputer: false, ipv4Only: null, refusal: "Why.", closedWhileRunning: true, restartOpens: true },
  ];
  for (const view of views) {
    const line = doorLine(view);
    for (const key of line.keys) {
      assert.equal(typeof english[key], "string", `${key} has English words`);
      assert.equal(typeof french[key], "string", `${key} has French words`);
      assert.equal(english[key].includes("{address}"), french[key].includes("{address}"), `${key} keeps its address`);
    }
    assert.equal(doorText(line, inLanguage(english)), doorText(line), "the English file says what the card says before it loads");
    const inFrench = doorText(line, inLanguage(french));
    assert.notEqual(inFrench, doorText(line), "French is not English");
    assert.ok(inFrench.includes(view.listeningOn), `the French line names the address: ${inFrench}`);
  }
});

// Redesign: no card or status line in the new window (public/index.html #deployment-card is gone); see the note above.
test.skip("the card has the line, as a status line that stays hidden until there is something to say", async () => {
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const card = page.slice(page.indexOf('<section id="deployment-card"'), page.indexOf("</section>", page.indexOf('<section id="deployment-card"')));
  assert.match(card, /<p id="listen-door-status" role="status" class="meta" hidden><\/p>/);
  const script = await readFile(new URL("../public/deployment.js", import.meta.url), "utf8");
  assert.match(script, /fetch\("\/api\/listen"/, "the card reads the door's own route");
});
