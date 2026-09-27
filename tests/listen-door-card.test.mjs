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

