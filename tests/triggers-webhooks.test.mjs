import test from "node:test";
import { signIn, openPlace } from "./new-window-places.mjs";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch, backoffMs } from "../dist/index.js";
import { startServer } from "../dist/server.js";

function scripted() {
  const provider = {
    name: "scripted",
    requests: [],
    failNext: false,
    next: null,
    async complete(request) {
      provider.requests.push(request);
      if (provider.failNext) {
        provider.failNext = false;
        throw new Error("provider down");
      }
      if (provider.next) {
        const reply = provider.next;
        provider.next = null;
        return reply;
      }
      return { content: `Result ${provider.requests.length}`, toolCalls: [] };
    },
  };
  return provider;
}

async function fixture(t, { allowLocal = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-triggers-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  // Tests deliver to a loopback server, which the network policy refuses by default.
  if (allowLocal) app.web.policy.configure({ allowPrivateAddresses: true });
  app.webhooks.retryDelays = [1, 1]; // three attempts, no real waiting
  t.after(async () => {
    await app.close();
    await discardTemp(root);
  });
  return { app, root, provider, context: app.runtime.context() };
}

/**
 * A fake endpoint that records every request with its exact bytes, so signatures can be checked,
 * and lets a test wait for the arrival of a particular event.
 */
async function fakeEndpoint(t, handle = () => ({ status: 200 })) {
  const received = [];
  const waiters = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const entry = { raw, headers: request.headers, body: JSON.parse(raw.toString("utf8")) };
      received.push(entry);
      for (const waiter of waiters.splice(0)) waiter();
      const { status } = handle(entry);
      response.writeHead(status).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const find = (event) => received.filter((entry) => entry.body.event === event);
  return {
    url: `http://127.0.0.1:${server.address().port}/hook`,
    received,
    find,
    /** Waits until at least one request for `event` has arrived, or fails after two seconds. */
    async wait(event) {
      const deadline = Date.now() + 2000;
      while (!find(event).length) {
        if (Date.now() > deadline) throw new Error(`No ${event} delivery arrived`);
        await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 20); });
      }
      return find(event)[0];
    },
  };
}

function signatureOf(secret, raw) {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

// --- inbound triggers ---------------------------------------------------------------------

test("a trigger is created with its own secret and reads back unchanged after a rotation", async (t) => {
  const { app, context } = await fixture(t);
  const trigger = app.triggers.create(context, { name: "Deploy", prompt: "Deploy {{branch}}", rateLimitPerMinute: 30 });
  assert.ok(trigger.id);
  assert.equal(trigger.enabled, true);
  assert.equal(trigger.secret.length, 48);
  assert.deepEqual(app.triggers.get("local", trigger.id), trigger);

  const rotated = app.triggers.rotateSecret("local", trigger.id);
  const after = app.triggers.get("local", trigger.id);
  assert.equal(after.secret, rotated);
  assert.notEqual(after.secret, trigger.secret);
  assert.equal(after.id, trigger.id, "the row id must survive a write-through");
  assert.equal(after.createdAt, trigger.createdAt, "the row timestamps must survive a write-through");
});

test("a bearer secret or a matching signature is accepted and anything else is refused", async (t) => {
  const { app, context } = await fixture(t);
  const trigger = app.triggers.create(context, { name: "Test", prompt: "Go", rateLimitPerMinute: 30 });
  const body = Buffer.from(JSON.stringify({ event: "test" }));

  assert.ok(app.triggers.verify(trigger, { authorization: `Bearer ${trigger.secret}` }, body).valid);
  assert.ok(app.triggers.verify(trigger, { "x-branch-signature": signatureOf(trigger.secret, body) }, body).valid);
  assert.ok(!app.triggers.verify(trigger, { authorization: "Bearer wrong" }, body).valid);
  assert.ok(!app.triggers.verify(trigger, { "x-branch-signature": signatureOf("other secret", body) }, body).valid);
  assert.ok(!app.triggers.verify(trigger, { "x-branch-signature": signatureOf(trigger.secret, Buffer.from("{}")) }, body).valid,
    "a signature over different bytes must not pass");
  assert.ok(!app.triggers.verify(trigger, {}, body).valid);
});

test("firing a trigger fills in the prompt, starts a task and records it in the log", async (t) => {
  const { app, context, provider } = await fixture(t);
  const trigger = app.triggers.create(context, {
    name: "Deploy", prompt: "Deploy {{branch}} to {{environment}}. Everything: {{payload}}", rateLimitPerMinute: 30,
  });

  const result = await app.triggers.fire("local", trigger.id, { branch: "main", environment: "prod" });
  assert.ok(result.runId);
  assert.equal(result.status, "completed");

  const sent = provider.requests[0].messages.filter((m) => m.role === "user")[0].content;
  assert.match(sent, /Deploy main to prod/);

  const log = app.triggers.getLog(trigger.id, "local");
  assert.equal(log.length, 1);
  assert.equal(log[0].runId, result.runId);
  assert.equal(log[0].status, "completed");
  assert.match(log[0].payloadSummary, /main/);
});

test("a trigger that is turned off refuses to fire and says so over HTTP", async (t) => {
  const { app, context, root } = await fixture(t);
  const trigger = app.triggers.create(context, { name: "Off", prompt: "Go", rateLimitPerMinute: 30 });
  app.triggers.setEnabled("local", trigger.id, false);
  assert.equal(app.triggers.get("local", trigger.id).enabled, false);

  await assert.rejects(app.triggers.fire("local", trigger.id, {}), /disabled/);
  assert.equal(app.triggers.getLog(trigger.id, "local")[0].status, "Trigger is disabled");

  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const response = await fetch(`${server.url}/api/triggers/${trigger.id}/fire`, {
    method: "POST", headers: { authorization: `Bearer ${trigger.secret}`, "content-type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 403);
});

test("a wrong signature is refused and an oversize body is refused over HTTP", async (t) => {
  const { app, context, root } = await fixture(t);
  const trigger = app.triggers.create(context, { name: "Guarded", prompt: "Go", rateLimitPerMinute: 30 });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const fire = `${server.url}/api/triggers/${trigger.id}/fire`;

  const body = JSON.stringify({ event: "push" });
  const wrong = await fetch(fire, {
    method: "POST",
    headers: { "content-type": "application/json", "x-branch-signature": signatureOf("not the secret", Buffer.from(body)) },
    body,
  });
  assert.equal(wrong.status, 401);
  assert.equal(app.triggers.getLog(trigger.id, "local").length, 0, "a refused request must not start a task");

  const oversize = await fetch(fire, {
    method: "POST",
    headers: { authorization: `Bearer ${trigger.secret}`, "content-type": "application/json" },
    body: JSON.stringify({ blob: "x".repeat(300 * 1024) }),
  });
  assert.equal(oversize.status, 413);
});

test("a trigger stops firing once it hits its limit for the minute", async (t) => {
  const { app, context } = await fixture(t);
  const trigger = app.triggers.create(context, { name: "Busy", prompt: "Go", rateLimitPerMinute: 2 });

  assert.ok((await app.triggers.fire("local", trigger.id, {})).runId);
  assert.ok((await app.triggers.fire("local", trigger.id, {})).runId);
  await assert.rejects(app.triggers.fire("local", trigger.id, {}), /Rate limit exceeded/);
  assert.equal(app.triggers.getLog(trigger.id, "local")[0].status, "Rate limit exceeded");
});

// --- outbound webhooks --------------------------------------------------------------------

test("a finished task tells a webhook, signed, with the task id and how it ended", async (t) => {
  const { app, context } = await fixture(t);
  const endpoint = await fakeEndpoint(t);
  app.webhooks.create(context, { name: "Watcher", url: endpoint.url, secret: "shared secret", events: ["run.completed", "run.failed"] });

  const run = await app.runtime.run({ prompt: "Say hello" });
  const delivery = await endpoint.wait("run.completed");

  assert.equal(delivery.body.runId, run.id);
  assert.equal(delivery.body.status, "completed");
  assert.ok(delivery.body.timestamp);
  assert.equal(delivery.headers["x-branch-signature"], signatureOf("shared secret", delivery.raw));
  assert.equal(app.webhooks.list("local")[0].failureCount, 0);
});

test("a task that breaks tells the webhook it failed", async (t) => {
  const { app, context, provider } = await fixture(t);
  const endpoint = await fakeEndpoint(t);
  app.webhooks.create(context, { name: "Watcher", url: endpoint.url, events: ["run.completed", "run.failed"] });

  provider.failNext = true;
  const run = await app.runtime.run({ prompt: "This will break" });
  assert.equal(run.status, "failed");

  const delivery = await endpoint.wait("run.failed");
  assert.equal(delivery.body.runId, run.id);
  assert.equal(delivery.body.status, "failed");
  assert.equal(endpoint.find("run.completed").length, 0);
});

test("firing a trigger also tells a webhook, with the task it started", async (t) => {
  const { app, context } = await fixture(t);
  const endpoint = await fakeEndpoint(t);
  app.webhooks.create(context, { name: "Watcher", url: endpoint.url, events: ["trigger.fired"] });
  const trigger = app.triggers.create(context, { name: "Inbound", prompt: "Handle {{event}}", rateLimitPerMinute: 30 });

  const result = await app.triggers.fire("local", trigger.id, { event: "push" });
  const delivery = await endpoint.wait("trigger.fired");

  assert.equal(delivery.body.triggerId, trigger.id);
  assert.equal(delivery.body.name, "Inbound");
  assert.equal(delivery.body.runId, result.runId);
  assert.equal(app.triggers.getLog(trigger.id, "local")[0].runId, result.runId);
  assert.equal(endpoint.find("run.completed").length, 0, "this webhook asked only about trigger.fired");
});

test("a scheduled task and a question waiting for the owner both tell a webhook", async (t) => {
  const { app, context, provider } = await fixture(t);
  const endpoint = await fakeEndpoint(t);
  app.webhooks.create(context, { name: "Watcher", url: endpoint.url, events: ["schedule.fired", "approval.needed"] });

  const schedule = app.scheduler.create(context, { prompt: "Check the mail", dueAt: new Date().toISOString(), kind: "task" });
  const scheduled = await app.scheduler.trigger("local", schedule.id, undefined, "local");
  const fired = await endpoint.wait("schedule.fired");
  assert.equal(fired.body.scheduleId, schedule.id);
  assert.equal(fired.body.runId, scheduled.id);
  assert.equal(fired.body.status, "completed");

  provider.next = { content: "", toolCalls: [{ id: "q1", name: "user.ask", arguments: JSON.stringify({ question: "Which folder?" }) }] };
  const asked = await app.runtime.run({ prompt: "Clean up" });
  assert.equal(asked.status, "needs_input");
  const approval = await endpoint.wait("approval.needed");
  assert.equal(approval.body.runId, asked.id);
  assert.equal(approval.body.question, "Which folder?");
});

test("a chat message that can never be sent tells a webhook once it is given up on", async (t) => {
  const { app, context } = await fixture(t);
  const endpoint = await fakeEndpoint(t);
  app.webhooks.create(context, { name: "Watcher", url: endpoint.url, events: ["delivery.failed"] });

  const ledger = app.channels.deliveries;
  ledger.enqueue("tg", "chat9", "never arrives", "run:doomed");
  const refuse = async () => { throw new Error("chat app is down"); };
  for (let attempt = 1; attempt <= 5; attempt++) {
    ledger.now = () => new Date(Date.now() + backoffMs(5) * attempt);
    await ledger.flush("tg", refuse);
  }
  assert.equal(ledger.outstanding()[0].status, "dead");

  const delivery = await endpoint.wait("delivery.failed");
  assert.equal(delivery.body.chatId, "chat9");
  assert.equal(delivery.body.channel, "tg");
  assert.equal(delivery.body.attempts, 5);
  assert.match(delivery.body.error, /chat app is down/);
  assert.equal(endpoint.find("delivery.failed").length, 1, "only the final giving-up is announced");
});

test("a webhook only hears about the events it asked for", async (t) => {
  const { app, context } = await fixture(t);
  const endpoint = await fakeEndpoint(t);
  app.webhooks.create(context, { name: "Watcher", url: endpoint.url, events: ["delivery.failed"] });

  await app.runtime.run({ prompt: "Say hello" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(endpoint.received.length, 0);
});

test("a delivery that fails first is retried and then succeeds", async (t) => {
  const { app, context } = await fixture(t);
  let calls = 0;
  const endpoint = await fakeEndpoint(t, () => ({ status: ++calls === 1 ? 500 : 200 }));
  const webhook = app.webhooks.create(context, { name: "Flaky", url: endpoint.url, events: ["run.completed"] });

  await app.webhooks.deliver("local", webhook.id, "run.completed", { runId: "abc" });

  assert.equal(calls, 2);
  const log = app.webhooks.getLog(webhook.id, "local");
  assert.deepEqual(log.map((entry) => `${entry.status}#${entry.attempt}`), ["success#2", "failed#1"]);
  assert.equal(app.webhooks.get("local", webhook.id).failureCount, 0);
});

test("a webhook that keeps failing switches itself off and can be turned back on", async (t) => {
  const { app, context } = await fixture(t);
  const endpoint = await fakeEndpoint(t, () => ({ status: 500 }));
  const webhook = app.webhooks.create(context, { name: "Broken", url: endpoint.url, events: ["run.completed"] });

  for (let i = 0; i < 5; i++) await app.webhooks.deliver("local", webhook.id, "run.completed", { runId: `run-${i}` });

  const off = app.webhooks.get("local", webhook.id);
  assert.equal(off.enabled, false);
  assert.equal(off.failureCount, 5);
  assert.match(off.disabledReason, /5 consecutive delivery failures/);
  assert.equal(off.id, webhook.id, "the row id must survive a write-through");

  const back = app.webhooks.enable("local", webhook.id);
  assert.equal(back.enabled, true);
  assert.equal(back.failureCount, 0);
  assert.equal(back.disabledReason, null);
});

test("a test delivery reports the answer and shows up in the delivery history", async (t) => {
  const { app, context } = await fixture(t);
  const endpoint = await fakeEndpoint(t);
  const webhook = app.webhooks.create(context, { name: "Watcher", url: endpoint.url, events: ["run.completed"] });

  const result = await app.webhooks.test("local", webhook.id);
  assert.equal(result.ok, true);
  assert.equal(result.message, "HTTP 200");
  assert.equal(endpoint.received[0].body.test, true);
  assert.equal(app.webhooks.getLog(webhook.id, "local")[0].eventType, "webhook.test");
});

test("a private address is refused while the network policy forbids it", async (t) => {
  const { app, context } = await fixture(t, { allowLocal: false });
  const endpoint = await fakeEndpoint(t);
  const webhook = app.webhooks.create(context, { name: "Local", url: endpoint.url, events: ["run.completed"] });

  const result = await app.webhooks.test("local", webhook.id);
  assert.equal(result.ok, false);
  assert.match(result.message, /private or local address/);
  assert.equal(endpoint.received.length, 0, "nothing may leave the machine while the policy forbids it");
});

// --- the automations panel ----------------------------------------------------------------

test("the Schedules screen shows both automations, with a web address and recent activity", async (t) => {
  const { app, context, root } = await fixture(t);
  const endpoint = await fakeEndpoint(t);
  const trigger = app.triggers.create(context, { name: "From the shop", prompt: "New order {{id}}", rateLimitPerMinute: 30 });
  app.webhooks.create(context, { name: "My dashboard", url: endpoint.url, events: ["run.completed"] });
  await app.triggers.fire("local", trigger.id, { id: 7 });

  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const httpCall = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await httpCall("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await signIn(page, server);
  // Redesign: Automations › Triggers in the new window (public/app/places/automations.js, prototype.html's Triggers tab)
  // lists each trigger with what it asks and its own on/off switch. The web address, recent activity, the webhooks list
  // and "Send a test" are not in the prototype: replaced by the new window, so they are not looked for here (the engine's
  // side of each is tested above).
  const place = await openPlace(page, "automations", "triggers");
  const row = place.locator(".prow").filter({ hasText: "From the shop" });
  await row.waitFor();
  assert.match(await row.innerText(), /New order \{\{id\}\}/);
  const toggle = row.getByRole("checkbox", { name: "From the shop on or off", exact: true });
  assert.equal(await toggle.isChecked(), true);
  await toggle.uncheck();
  for (let tries = 0; tries < 40 && app.triggers.list("local").find((one) => one.id === trigger.id)?.enabled; tries++) await page.waitForTimeout(50);
  assert.equal(app.triggers.list("local").find((one) => one.id === trigger.id)?.enabled, false, "the switch turned it off");
  assert.deepEqual(errors, []);
});

test("a webhook that refuses every delivery never disturbs the task that caused it", async (t) => {
  const { app, context } = await fixture(t);
  const endpoint = await fakeEndpoint(t, () => ({ status: 500 }));
  const webhook = app.webhooks.create(context, { name: "Broken", url: endpoint.url, events: ["run.completed"] });

  const run = await app.runtime.run({ prompt: "Say hello" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "Result 1");

  // Let the background attempts finish before the fixture closes the store.
  while (app.webhooks.get("local", webhook.id).failureCount === 0) await new Promise((r) => setTimeout(r, 20));
  assert.equal(endpoint.received.length, 3, "three attempts, then it gives up");
});
