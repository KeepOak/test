import test from "node:test";
import { saveLongWorkSettings } from "../dist/long-work.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { z } from "zod";
import {
  createBranch,
  OpenAIProvider,
  AnthropicProvider,
  ProviderStreamError,
} from "../dist/index.js";
import { Budget } from "../dist/contracts.js";
import {
  ProviderHttpError,
  parseRetryAfter,
  parseRetryPolicy,
} from "../dist/provider-retry.js";

const fastPolicy = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 20 };
const finalBody = (kind) =>
  kind === "openai"
    ? {
        choices: [{ message: { content: "done" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }
    : {
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      };
function respond(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
async function fixture(t, kind, handler, policy = fastPolicy) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const requests = [],
    root = await mkdtemp(join(scratch, "branch-retry-"));
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const entry = {
      body: JSON.parse(raw),
      url: req.url,
      headers: req.headers,
      time: Date.now(),
    };
    requests.push(entry);
    await handler(entry, res, requests.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const options = {
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    retryPolicy: policy,
  };
  const ProviderClass = kind === "openai" ? OpenAIProvider : AnthropicProvider;
  const provider = new ProviderClass({
    endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    model: "unchanged-fixture-model",
    apiKey: "fixture-secret",
  });
  const app = await createBranch({ ...options, provider });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
    await discardTemp(root);
  });
  return { app, requests, provider, options };
}
for (const kind of ["openai", "anthropic"])
  test(`${kind} retries transient HTTP failures with unchanged model and per-attempt usage`, async (t) => {
    const { app, requests } = await fixture(t, kind, (_entry, res, n) =>
      respond(
        res,
        n < 3 ? 503 : 200,
        n < 3
          ? { error: { message: "do not persist raw provider message" } }
          : finalBody(kind),
      ),
    );
    const run = await app.runtime.run({ prompt: "retry" });
    assert.equal(run.status, "completed");
    assert.equal(requests.length, 3);
    assert.ok(
      requests.every(
        (request) => request.body.model === "unchanged-fixture-model",
      ),
    );
    assert.ok(
      requests.every(
        (request) =>
          (request.headers.authorization ?? request.headers["x-api-key"]) ===
          (kind === "openai" ? "Bearer fixture-secret" : "fixture-secret"),
      ),
    );
    const usage = app.store.usage(run.id);
    assert.equal(usage.attempts, 3);
    assert.equal(usage.unreportedCalls, 2);
    assert.equal(usage.incompleteCalls, 2);
    const events = app.store.events(run.id),
      starts = events.filter((event) => event.kind === "model.started");
    assert.equal(
      usage.estimatedInput,
      starts.reduce((sum, event) => sum + event.data.estimatedInput, 0),
    );
    assert.deepEqual(
      events
        .filter((event) => event.kind === "model.retry_scheduled")
        .map((event) => ({
          attempt: event.data.attempt,
          maxRetries: event.data.maxRetries,
          status: event.data.status,
        })),
      [
        { attempt: 1, maxRetries: 2, status: 503 },
        { attempt: 2, maxRetries: 2, status: 503 },
      ],
    );
    assert.ok(
      !JSON.stringify(events).includes("do not persist raw provider message"),
    );
  });

test("failure after a completed tool retries only the next completion", async (t) => {
  let effects = 0;
  const { app, requests } = await fixture(t, "openai", (entry, res, n) => {
    if (n === 1)
      return respond(res, 200, {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "effect",
                  type: "function",
                  function: {
                    name: entry.body.tools.find(
                      (tool) =>
                        tool.function.description === "Count a side effect",
                    ).function.name,
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      });
    respond(res, n === 2 ? 500 : 200, n === 2 ? {} : finalBody("openai"));
  });
  app.registry.register({
    name: "fixture.effect",
    description: "Count a side effect",
    permission: "fixture.effect",
    parameters: z.object({}),
    execute: async () => ({ effects: ++effects }),
  });
  const run = await app.runtime.run({ prompt: "effect once" });
  assert.equal(run.status, "completed");
  assert.equal(effects, 1);
  assert.deepEqual(requests[1].body.messages, requests[2].body.messages);
  assert.equal(
    app.store.events(run.id).filter((event) => event.kind === "tool.completed")
      .length,
    1,
  );
  assert.equal(app.store.usage(run.id).attempts, 3);
});

test("transient retries stop after two retries", async (t) => {
  const { app, requests } = await fixture(t, "openai", (_entry, res) =>
    respond(res, 529, {}),
  );
  const run = await app.runtime.run({ prompt: "stop" });
  assert.equal(run.status, "failed");
  assert.equal(requests.length, 3);
  assert.equal(app.store.usage(run.id).attempts, 3);
});

for (const failure of [
  { status: 401 },
  { status: 400 },
  { status: 429 },
  { status: 429, code: "insufficient_quota", retryAfter: "0" },
  { status: 429, code: "billing_hard_limit_reached", retryAfter: "0" },
  { status: 429, type: "rate_limit_error" },
  ...[
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
  ].map((code) => ({ status: 429, code, retryAfter: "0" })),
])
  test(`HTTP ${failure.status} ${failure.code ?? failure.type ?? "unknown"} does not auto-retry`, async (t) => {
    const { app, requests } = await fixture(t, "openai", (_entry, res) =>
      respond(
        res,
        failure.status,
        {
          error: {
            code: failure.code,
            type: failure.type,
            message: "private diagnostic",
          },
        },
        failure.retryAfter ? { "retry-after": failure.retryAfter } : {},
      ),
    );
    const run = await app.runtime.run({ prompt: "no retry" });
    assert.equal(run.status, "failed");
    assert.equal(requests.length, 1);
    assert.ok(!run.output.includes("private diagnostic"));
  });

test("explicit rate-limit code and Retry-After minimum are respected", async (t) => {
  const { app, requests } = await fixture(
    t,
    "openai",
    (_entry, res, n) =>
      respond(
        res,
        n === 1 ? 429 : 200,
        n === 1
          ? { error: { code: "rate_limit_exceeded" } }
          : finalBody("openai"),
        n === 1 ? { "retry-after": "1" } : {},
      ),
    { ...fastPolicy, maxDelayMs: 1500 },
  );
  const run = await app.runtime.run({ prompt: "rate limit" });
  assert.equal(run.status, "completed");
  assert.equal(requests.length, 2);
  assert.ok(requests[1].time - requests[0].time >= 1000);
  assert.equal(
    app.store
      .events(run.id)
      .find((event) => event.kind === "model.retry_scheduled").data.delayMs,
    1000,
  );
});

test("Retry-After beyond wait ceiling fails instead of retrying early", async (t) => {
  const { app, requests } = await fixture(t, "anthropic", (_entry, res) =>
    respond(
      res,
      429,
      { error: { type: "rate_limit_error" } },
      { "retry-after": "60" },
    ),
  );
  // long-work: with "wait for limits" on (its default) the task waits the whole minute and carries on
  // (tests/long-work-resilience.test.mjs); here it is off, so the retry policy's own ceiling is what is tested.
  saveLongWorkSettings(app.store, app.runtime.owner, { waitForLimits: false });
  const run = await app.runtime.run({ prompt: "long wait" });
  assert.equal(run.status, "failed");
  assert.equal(requests.length, 1);
  assert.equal(
    app.store
      .events(run.id)
      .filter((event) => event.kind === "model.retry_scheduled").length,
    0,
  );
});

test("Retry-After parser supports seconds and HTTP date without leaking header text", () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0);
  assert.equal(parseRetryAfter("2", now), 2000);
  assert.equal(parseRetryAfter("Tue, 15 Sep 2026 12:00:03 GMT", now), 3000);
  assert.equal(parseRetryAfter("secret-header-value", now), undefined);
  assert.ok(parseRetryAfter("999999999999999999999999", now) > 5000);
  assert.ok(!new ProviderHttpError(503, 0).message.includes("undefined"));
  const secret = new ProviderHttpError(503, 0, "private-code-value");
  assert.equal(secret.code, undefined);
  assert.ok(!JSON.stringify(secret).includes("private-code-value"));
  assert.deepEqual(parseRetryPolicy(), {
    maxRetries: 2,
    baseDelayMs: 250,
    maxDelayMs: 5000,
  });
});

test("cancellation during backoff stops before another provider attempt", async (t) => {
  const { app, requests } = await fixture(
    t,
    "openai",
    (_entry, res) => respond(res, 503, {}),
    { ...fastPolicy, baseDelayMs: 2000, maxDelayMs: 2000 },
  );
  const controller = new AbortController();
  let id;
  const pending = app.runtime.run({
    prompt: "cancel retry",
    signal: controller.signal,
    onStarted: (run) => {
      id = run.id;
    },
  });
  // onStarted fires after the run's first bookkeeping, so wait for the id before reading its events.
  while (
    id === undefined ||
    !app.store
      .events(id)
      .some((event) => event.kind === "model.retry_scheduled")
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const run = await pending;
  assert.equal(run.status, "cancelled");
  assert.equal(requests.length, 1);
});

test("exhausted step or token budget prevents another HTTP attempt", async (t) => {
  const { app, requests } = await fixture(t, "openai", (_entry, res) =>
    respond(res, 503, {}),
  );
  const stepRun = await app.runtime.run({
    prompt: "one step",
    budget: { maxSteps: 1, maxTokens: 30000 },
  });
  assert.equal(stepRun.status, "budget_exceeded");
  assert.equal(requests.length, 1);
  const input = app.store.usage(stepRun.id).estimatedInput;
  const tokenRun = await app.runtime.run({
    prompt: "one step",
    budget: { maxSteps: 30, maxTokens: input + 50 },
  });
  assert.equal(tokenRun.status, "budget_exceeded");
  assert.equal(requests.length, 2);
});

for (const kind of ["openai", "anthropic"])
  test(`${kind} stream wrapper permits pre-body HTTP retries but not partial output`, async (t) => {
    const { app, requests } = await fixture(t, kind, (_entry, res, n) => {
      if (n === 1) return respond(res, 503, {});
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (kind === "openai")
        res.end(
          "data: " +
            JSON.stringify({
              choices: [{ index: 0, delta: { content: "partial" } }],
            }) +
            "\n\n",
        );
      else
        res.end(
          "data: " +
            JSON.stringify({
              type: "message_start",
              message: { usage: { input_tokens: 2, output_tokens: 0 } },
            }) +
            "\n\ndata: " +
            JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "partial" },
            }) +
            "\n\n",
        );
    });
    const chunks = [],
      run = await app.runtime.run({
        prompt: "stream",
        onTextDelta: (text) => chunks.push(text),
      });
    assert.equal(run.status, "failed");
    assert.equal(requests.length, 2);
    assert.deepEqual(chunks, ["partial"]);
    assert.equal(app.store.usage(run.id).attempts, 2);
    assert.ok(app.store.usage(run.id).estimatedOutput > 0);
    assert.equal(
      app.store
        .messages(run.sessionId)
        .filter((message) => message.role === "assistant").length,
      0,
    );
  });

test("stream wrapper with observed usage cannot retry even when cause is typed HTTP error", async (t) => {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-retry-observed-"));
  let calls = 0;
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    retryPolicy: fastPolicy,
    provider: {
      name: "typed-fixture",
      async complete() {
        calls++;
        throw new ProviderStreamError(new ProviderHttpError(503), 0, {
          input: 2,
          output: 0,
        });
      },
    },
  });
  t.after(async () => {
    await app.close();
    await discardTemp(root);
  });
  assert.equal(
    (await app.runtime.run({ prompt: "no retry" })).status,
    "failed",
  );
  assert.equal(calls, 1);
});

test("invalid SDK retry policy rejects before creating application state", async (t) => {
  const { options } = await fixture(t, "openai", (_entry, res) =>
    respond(res, 200, finalBody("openai")),
  );
  await assert.rejects(
    createBranch({ ...options, retryPolicy: { maxRetries: 3 } }),
    /retry|Retries/i,
  );
  await assert.rejects(
    createBranch({
      ...options,
      retryPolicy: { baseDelayMs: 50, maxDelayMs: 20 },
    }),
    /delay|Delay/i,
  );
});

for (const status of [408, 502, 504])
  test(`HTTP ${status} is eligible for bounded retry`, async (t) => {
    const { app, requests } = await fixture(t, "openai", (_entry, res, n) =>
      respond(res, n === 1 ? status : 200, n === 1 ? {} : finalBody("openai")),
    );
    assert.equal(
      (await app.runtime.run({ prompt: "transient" })).status,
      "completed",
    );
    assert.equal(requests.length, 2);
  });

test("SDK policy can disable retries", async (t) => {
  const { app, requests } = await fixture(
    t,
    "openai",
    (_entry, res) => respond(res, 503, {}),
    { ...fastPolicy, maxRetries: 0 },
  );
  assert.equal(
    (await app.runtime.run({ prompt: "disabled" })).status,
    "failed",
  );
  assert.equal(requests.length, 1);
});

for (const body of [
  '{"choices":',
  JSON.stringify({ choices: [{ message: { content: 42 } }] }),
])
  test(`successful HTTP with invalid ${body.endsWith(":") ? "JSON" : "schema"} is never retried`, async (t) => {
    const { app, requests } = await fixture(t, "openai", (_entry, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    assert.equal(
      (await app.runtime.run({ prompt: "invalid body" })).status,
      "failed",
    );
    assert.equal(requests.length, 1);
  });

test("delegated retries consume the unchanged parent step and token budget", async (t) => {
  const { app, requests } = await fixture(t, "openai", (_entry, res) =>
    respond(res, 503, {}),
  );
  // Budget.limits is read-only (it folds in the billed limits), so the lower step limit is set where the budget is made.
  const context = app.runtime.context({ budget: new Budget({ maxSteps: 2, maxTokens: 200000 }) });
  const run = await app.runtime.delegate(
    "child retry",
    context,
    ["files.read"],
    "Read only",
  );
  assert.equal(run.status, "budget_exceeded");
  assert.equal(requests.length, 2);
  assert.equal(context.budget.steps, 2);
  assert.equal(context.budget.tokens, app.store.usage(run.id).estimatedInput);
});

test("a headers-only transient response cannot stall error handling indefinitely", async (t) => {
  const { app, requests } = await fixture(
    t,
    "openai",
    (_entry, res, n) => {
      if (n > 1) return respond(res, 200, finalBody("openai"));
      res.writeHead(503, { "content-type": "application/json" });
      res.flushHeaders();
    },
    { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
  );
  const before = Date.now(),
    run = await app.runtime.run({ prompt: "headers only" });
  assert.equal(run.status, "completed");
  assert.equal(requests.length, 2);
  assert.ok(Date.now() - before < 5000);
});

for (const kind of ["dripping", "oversized"])
  test(`429 ${kind} error bodies cannot hide quota behind Retry-After`, async (t) => {
    const { app, requests } = await fixture(t, "openai", (_entry, res) => {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "0",
      });
      if (kind === "oversized") {
        res.end(
          JSON.stringify({
            error: { message: "x".repeat(20000), code: "insufficient_quota" },
          }),
        );
        return;
      }
      res.flushHeaders();
      res.write('{"error":{"message":"');
      const timer = setInterval(() => res.write("x"), 50);
      res.on("close", () => clearInterval(timer));
    });
    const run = await app.runtime.run({ prompt: "do not hide quota" });
    assert.equal(run.status, "failed");
    assert.equal(requests.length, 1);
  });

test("abort while reading a rejected HTTP body stops without a retry", async (t) => {
  let received;
  const ready = new Promise((resolve) => {
    received = resolve;
  });
  const { app, requests } = await fixture(t, "openai", (_entry, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.flushHeaders();
    received();
  });
  const controller = new AbortController(),
    pending = app.runtime.run({
      prompt: "cancel error read",
      signal: controller.signal,
    });
  await ready;
  controller.abort();
  const run = await pending;
  assert.equal(run.status, "cancelled");
  assert.equal(requests.length, 1);
});

for (const hint of [
  "later please",
  "Tuesday, 15-Sep-26 12:00:03 GMT",
  "Tue, 31 Feb 2026 12:00:03 GMT",
  "Tue, 15 Sep 2026 24:00:00 GMT",
])
  test(`unsupported Retry-After ${hint} prevents an early retry`, async (t) => {
    assert.equal(parseRetryAfter(hint), undefined);
    const { app, requests } = await fixture(t, "openai", (_entry, res) =>
      respond(res, 503, {}, { "retry-after": hint }),
    );
    assert.equal(
      (await app.runtime.run({ prompt: "respect unknown hint" })).status,
      "failed",
    );
    assert.equal(requests.length, 1);
  });
