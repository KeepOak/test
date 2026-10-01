// RES-115/116: exact Stripe Link purchases ship off; a paid charge needs the owner's one-time authorization bound to
// that exact quote, used once; a changed challenge releases no credential; App lock or a settings change ends an
// authorization; USD cents up to $1,000 only; chats, helpers and the model get no spend authority.
// Stand-in seller and Link servers only: nothing leaves this computer and no real charge is made.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { stripeChallenge } from "../dist/purchases/mpp.js";

const SHOP = "https://shop.example", ITEM_URL = `${SHOP}/buy/lamp`;
const settings = { enabled: true, paymentMethodId: "csmrpd_test", origins: [SHOP], acknowledge: "single-use Stripe Link USD purchases" };
const challenge = ({ amount = "1250", currency = "usd", id = "ch_1", expires = new Date(Date.now() + 600000).toISOString() } = {}) => {
  const request = Buffer.from(JSON.stringify({ amount, currency, methodDetails: { networkId: "net_test" } })).toString("base64url");
  return `Payment id="${id}", realm="shop.example", method="stripe", intent="charge", request="${request}", expires="${expires}"`;
};

/** A seller answering 402 with its current challenge, and a Link wallet that approves and settles exactly. */
function stand(app) {
  const s = { header: challenge(), calls: [], secretReads: 0, paid: 0 };
  let status = "approved";
  s.setStatus = (value) => { status = value; };
  const json = (body, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const spend = (extra = {}) => ({ id: "lsrq_1", status, amount: stripeChallenge(s.header).amount, currency: "usd", network_id: "net_test",
    credential_type: "shared_payment_token", merchant_url: ITEM_URL, ...extra });
  s.fetch = async (url, init = {}) => {
    const u = new URL(String(url)); s.calls.push(`${init.method ?? "GET"} ${u.host}${u.pathname}`);
    if (u.host === "shop.example") {
      if (new Headers(init.headers).get("authorization")) { s.paid++; status = "succeeded"; return new Response("ok", { status: 200 }); }
      return new Response("pay", { status: 402, headers: { "www-authenticate": s.header } });
    }
    if (u.host === "api.link.com") {
      if (u.searchParams.get("include")) return json(spend({ shared_payment_token: { id: "spt_test" } }));
      return json(spend(status === "succeeded" ? { payment_status_details: { outcome: "success", amount: stripeChallenge(s.header).amount, currency: "usd" }, link_transaction_id: "tx_1" } : {}));
    }
    throw new Error(`unexpected network call to ${u.host}`);
  };
  const purchases = app.personal.purchases;
  purchases.deps.fetch = s.fetch;
  purchases.deps.secret = async () => { s.secretReads++; return "link-test-token"; };
  s.purchases = purchases;
  return s;
}
async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-purchases-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "buy the lamp" });
  const context = (extra = {}) => ({ owner: app.runtime.owner, workspace: join(root, "workspace"), runId: run.id, signal: new AbortController().signal,
    budget: {}, permissions: new Set(["payments.spend", "personal.read"]), depth: 0, source: "owner", ...extra });
  return { app, context, s: stand(app) };
}

test("(1) off by default: nothing configured means no quote, no spend and no network call", async (t) => {
  const { app, context, s } = await world(t);
  assert.equal(s.purchases.settings().enabled, false);
  await assert.rejects(s.purchases.quote({ url: ITEM_URL, item: "Lamp", seller: "Shop" }, context()), /Purchases are off/);
  await assert.rejects(s.purchases.spend({ quoteId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f" }, context()), /Quote expired/);
  await assert.rejects(app.runtime.executeTool("payments.quote", { url: ITEM_URL, item: "Lamp", seller: "Shop" }, { mode: "owner", source: "owner" }));
  assert.deepEqual(s.calls, []);
  assert.equal(s.secretReads, 0);
  assert.throws(() => s.purchases.configure({ ...settings, acknowledge: undefined }), /acknowledgement/);
});

test("(2) one owner authorization is bound to that exact quote and is used once", async (t) => {
  const { context, s } = await world(t);
  s.purchases.configure(settings);
  const quote = await s.purchases.quote({ url: ITEM_URL, item: "Lamp", seller: "Shop" }, context());
  assert.deepEqual([quote.amountMinor, quote.currency, quote.seller, quote.item, quote.url], [1250, "usd", "Shop", "Lamp", ITEM_URL]);
  assert.match(s.purchases.target(quote.id), /Shop: Lamp; exact 1250 USD cents/);
  await assert.rejects(s.purchases.spend({ quoteId: quote.id }, context()), /single-use authorization/, "no authorization, no spend");
  const other = await s.purchases.quote({ url: ITEM_URL, item: "Other", seller: "Shop" }, context());
  const grant = s.purchases.authorize({ quoteId: quote.id });
  await assert.rejects(s.purchases.spend({ quoteId: other.id, authorizationId: grant.authorizationId }, context()), /single-use authorization/, "bound to its own quote");
  const receipt = await s.purchases.spend({ quoteId: quote.id, authorizationId: grant.authorizationId }, context());
  assert.equal(receipt.state, "payment-recorded", JSON.stringify(receipt));
  assert.equal(s.paid, 1);
  await assert.rejects(s.purchases.spend({ quoteId: quote.id, authorizationId: grant.authorizationId }, context()), /Quote expired/, "used once");
  assert.equal(s.paid, 1);
});

test("(3) a challenge or amount changed after authorization is refused and releases no credential", async (t) => {
  const { context, s } = await world(t);
  s.purchases.configure(settings);
  const quote = await s.purchases.quote({ url: ITEM_URL, item: "Lamp", seller: "Shop" }, context());
  const grant = s.purchases.authorize({ quoteId: quote.id });
  s.header = challenge({ amount: "99999" });
  const receipt = await s.purchases.spend({ quoteId: quote.id, authorizationId: grant.authorizationId }, context());
  assert.equal(receipt.state, "unknown");
  assert.equal(s.secretReads, 0, "the Link token was never read");
  assert.equal(s.calls.filter((c) => c.includes("api.link.com")).length, 0);
  assert.equal(s.paid, 0);
});

test("(4) App lock or a settings change ends a waiting authorization", async (t) => {
  const { app, context, s } = await world(t);
  s.purchases.configure(settings);
  let quote = await s.purchases.quote({ url: ITEM_URL, item: "Lamp", seller: "Shop" }, context());
  let grant = s.purchases.authorize({ quoteId: quote.id });
  s.purchases.configure({ ...settings, origins: [SHOP, "https://other.example"] });
  await assert.rejects(s.purchases.spend({ quoteId: quote.id, authorizationId: grant.authorizationId }, context()), /Quote expired|settings changed/);
  quote = await s.purchases.quote({ url: ITEM_URL, item: "Lamp", seller: "Shop" }, context());
  grant = s.purchases.authorize({ quoteId: quote.id });
  app.sessionLock.lock();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(s.purchases.spend({ quoteId: quote.id, authorizationId: grant.authorizationId }, context()), /Unlock|locked/i);
  app.sessionLock.unlock({});
  await assert.rejects(s.purchases.spend({ quoteId: quote.id, authorizationId: grant.authorizationId }, context()), /Quote expired|single-use/,
    "unlocking again does not bring the authorization back");
  assert.equal(s.paid, 0);
  assert.equal(s.secretReads, 0);
});

test("(4b) a purchase waiting for approval in Link is dropped by App lock and by a settings change", async (t) => {
  const { app, context, s } = await world(t);
  for (const end of [() => { app.sessionLock.lock(); app.sessionLock.unlock({}); }, () => s.purchases.configure({ ...settings, origins: [SHOP, "https://b.example"] })]) {
    s.purchases.configure(settings);
    s.setStatus("pending_approval");
    const quote = await s.purchases.quote({ url: ITEM_URL, item: "Lamp", seller: "Shop" }, context());
    const grant = s.purchases.authorize({ quoteId: quote.id });
    const waiting = await s.purchases.spend({ quoteId: quote.id, authorizationId: grant.authorizationId }, context());
    assert.equal(waiting.state, "pending_approval");
    assert.deepEqual(s.purchases.overview().pending, ["lsrq_1"]);
    end();
    await new Promise((resolve) => setImmediate(resolve));
    s.setStatus("approved");
    await assert.rejects(s.purchases.complete({ requestId: "lsrq_1" }, context()), /absent, expired or changed/);
  }
  assert.equal(s.paid, 0);
});

test("(5) USD cents only, up to $1,000", () => {
  assert.equal(stripeChallenge(challenge({ amount: "100000" })).amount, 100000);
  assert.throws(() => stripeChallenge(challenge({ amount: "100001" })), /1,000/);
  assert.throws(() => stripeChallenge(challenge({ amount: "12.50" })));
  assert.throws(() => stripeChallenge(challenge({ currency: "eur" })));
  assert.throws(() => stripeChallenge(challenge({ expires: new Date(Date.now() - 1000).toISOString() })), /expiry/);
});

test("(6) chats, helpers, Trunks and the model's own attempt get no spend authority", async (t) => {
  const { app, context, s } = await world(t);
  s.purchases.configure(settings);
  const quote = await s.purchases.quote({ url: ITEM_URL, item: "Lamp", seller: "Shop" }, context());
  for (const extra of [{ source: "channel" }, { trunk: "ada" }, { isolated: true }]) {
    await assert.rejects(s.purchases.quote({ url: ITEM_URL, item: "Lamp", seller: "Shop" }, context(extra)), /original owner task/, JSON.stringify(extra));
    await assert.rejects(s.purchases.spend({ quoteId: quote.id }, context(extra)), /original owner task/, JSON.stringify(extra));
  }
  const helper = await app.runtime.run({ prompt: "helper" });
  app.store.sqlite.prepare("UPDATE events SET data=json_set(data,'$.parentRunId',?) WHERE run_id=? AND kind='run.started'").run(context().runId, helper.id);
  await assert.rejects(s.purchases.spend({ quoteId: quote.id }, context({ runId: helper.id })), /original owner task/, "a helper of the owner's task");
  // The model in the owner's own task, with no authorization the owner gave in the window, spends nothing.
  await assert.rejects(s.purchases.spend({ quoteId: quote.id }, context()), /single-use authorization/);
  await assert.rejects(s.purchases.spend({ quoteId: quote.id, authorizationId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f" }, context()), /single-use authorization/);
  assert.equal(s.paid, 0);
  assert.equal(s.secretReads, 0);
});
