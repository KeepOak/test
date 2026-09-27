/**
 * find-computers in the window: "Add a computer or phone" › On your network lists what the engine found, with every
 * found name escaped, and the engine looks only while that tab is open. Stand-in network parts (a string for
 * `tailscale status`, an in-memory local network); the browser only ever talks to the test's own engine on 127.0.0.1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { decodePacket, MdnsAdvertiser } from "../dist/devices/dns-sd.js";

const HOSTILE_TAILNET = `<img src=x id=pwn1 onerror="window.__pwned=1">`;
const HOSTILE_LOCAL = `<b id=pwn3>Kitchen</b>`;

function network() {
  const open = new Set();
  const socketAt = (address) => async () => {
    const listeners = [];
    const socket = {
      address, listeners,
      send(data) { decodePacket(data); for (const other of [...open]) if (other !== socket) for (const l of other.listeners) l(data, address); },
      onMessage(listener) { listeners.push(listener); },
      close() { open.delete(socket); },
    };
    open.add(socket);
    return socket;
  };
  return { socketAt, open };
}

const onboarded = (server) => fetch(new URL("/api/onboarding", server.url), { method: "POST",
  headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });

async function signedIn(t) {
  const lan = network();
  const used = { probe: 0, sent: [] };
  const root = await mkdtemp(join(tmpdir(), "branch-find-window-"));
  const peers = { a: { HostName: "desk", TailscaleIPs: ["100.100.1.2"], Online: true, UserID: 1 } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } },
    findComputers: {
      status: async () => JSON.stringify({ BackendState: "Running", Self: { UserID: 1, TailscaleIPs: ["100.64.0.1"] }, Peer: peers }),
      probe: async () => { used.probe++; return { branch: "hello", name: HOSTILE_TAILNET }; },
      send: async (address, port, body) => { used.sent.push({ address, port, body }); }, openMdns: lan.socketAt("192.168.1.10"), port: 0, addresses: () => [], idleMs: 4000,
    } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await onboarded(server);
  const waiting = new MdnsAdvertiser(lan.socketAt("192.168.1.20"), HOSTILE_LOCAL, 3216);
  await waiting.start();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { waiting.stop(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const looking = async () => (await (await fetch(new URL("/api/devices/find", server.url), { headers: { authorization: `Bearer ${server.token}` } })).json()).looking;
  const browsing = () => [...lan.open].some((s) => s.address === "192.168.1.10");
  return { page, app, errors, looking, browsing, used, browser, server };
}
async function engine(server, path, body) {
  const response = await fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return response.json();
}

async function openNetworkTab(page) {
  await page.locator('[data-act="machines"]').first().click();
  await page.locator('[data-act="addcomp"]').click();
  await page.locator("#ac-found .prow").nth(1).waitFor({ timeout: 30000 });
}

test("On your network lists what the engine found, every name escaped, each with a live Pair", async (t) => {
  const { page, errors, browsing } = await signedIn(t);
  await openNetworkTab(page);
  assert.equal(browsing(), true, "the tab being open is what makes the engine look");
  const rows = page.locator("#ac-found .prow");
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.nth(0).locator("b").innerText(), HOSTILE_TAILNET, "the tailnet name is shown as text");
  assert.equal(await rows.nth(0).locator("small").innerText(), "Found on your network");
  assert.equal(await rows.nth(1).locator("b").innerText(), HOSTILE_LOCAL, "the local name is shown as text");
  assert.equal(await rows.nth(1).locator("small").innerText(), "Found on your network");
  assert.equal(await page.locator("#pwn1, #pwn3").count(), 0, "no element was made from a found name");
  assert.equal(await page.evaluate(() => window.__pwned ?? null), null);
  for (let i = 0; i < 2; i++) {
    const pair = rows.nth(i).locator('[data-act="ac-pair"]');
    assert.equal(await pair.getAttribute("aria-disabled"), null, "Pair is live");
    assert.match(await pair.getAttribute("data-v"), /^[a-f0-9]{16}$/, "it names the engine's opaque id, never an address");
  }
  assert.deepEqual(errors, []);
});

test("the engine looks only while the tab is open: another tab, closing the dialog, or a closed page stops it", async (t) => {
  const { page, errors, looking, browsing, browser, server } = await signedIn(t);
  await openNetworkTab(page);
  assert.equal(await looking(), true);
  await page.locator('[data-act="ac-tab"][data-v="phone"]').click();
  await sleep(300);
  assert.equal(await looking(), false, "another tab stops looking");
  assert.equal(browsing(), false, "and closes the local-network socket");

  await page.locator('[data-act="ac-tab"][data-v="network"]').click();
  await page.locator("#ac-found .prow").first().waitFor({ timeout: 30000 });
  assert.equal(await looking(), true, "back on the tab: looking again");
  await page.locator('.dlg [data-act="dlg-close"]').click();
  await sleep(3200);
  assert.equal(await looking(), false, "closing the dialog stops looking");
  assert.equal(browsing(), false);
  assert.deepEqual(errors, []);

  const other = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await other.goto(server.url);
  await other.getByLabel("Session token", { exact: true }).fill(server.token);
  await other.getByRole("button", { name: "Connect", exact: true }).click();
  await other.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openNetworkTab(other);
  assert.equal(await looking(), true);
  await other.close(); // the page dies mid-look: it never says stop
  await sleep(1000);
  assert.equal(browsing(), true, "still looking just after the page died");
  await sleep(4500);
  assert.equal(await looking(), false, "the engine stopped by itself once nobody read the list");
  assert.equal(browsing(), false);
});

test("Pair on a found computer makes one invitation and hands that computer its link, never the number", async (t) => {
  const { page, errors, looking, used, server } = await signedIn(t);
  await engine(server, "/api/devices/mode", { mode: "when-needed" });
  const invites = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/devices/invite") invites.push(request.url()); });
  await openNetworkTab(page);
  const found = (await engine(server, "/api/devices/find")).found;
  const pair = page.locator('#ac-found [data-act="ac-pair"]').first();
  assert.equal(await pair.getAttribute("data-v"), found[0].id);
  await pair.evaluate((button) => { button.click(); button.click(); }); // a double click
  await page.locator(".dlg .ko-code").waitFor({ timeout: 30000 });
  for (let i = 0; i < 50 && used.sent.length === 0; i++) await sleep(100);
  await sleep(500);
  const code = (await page.locator(".dlg .ko-code").innerText()).replace(/\s/g, "");
  const { invitation } = await engine(server, "/api/devices");
  assert.ok(invitation, "an invitation is on offer");
  assert.equal(invites.length, 1, "a double click makes one invitation");
  assert.equal(used.sent.length, 1, "and hands over one link");
  assert.equal(used.sent[0].address, "100.100.1.2", "to the computer that row names");
  assert.deepEqual(Object.keys(used.sent[0].body).sort(), ["link", "name"]);
  assert.ok(used.sent[0].body.link.includes(invitation.id), "the link is the invitation's");
  assert.ok(/^\d{6}$/.test(code) && !JSON.stringify(used.sent[0].body).includes(code), "the number is never sent");
  assert.equal(await looking(), false, "looking stops once the link is handed over");
  assert.deepEqual(errors, []);
});
