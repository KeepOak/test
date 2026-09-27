/**
 * Dogfood C3 (CodexBar-style): the ring at the bottom right is about what the next message spends. With several
 * accounts it read the tightest one anywhere ("ChatGPT 2 · 0% left") while the next message went through another.
 * It now reads the connection and account in use, and says nothing rather than borrow another account's number.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { glanceFrom, nextRows } from "../dist/usage-glance.js";

const window = (remaining) => ({ id: "plan", title: "Plan window", kind: "requests", limit: 100, remaining, resetAt: null, measuredAt: null, state: "measured", from: "the service" });
const row = (connection, account, inUse, remaining) => ({ connection, connectionName: connection, account, accountLabel: account, inUse,
  state: "measured", windows: remaining === null ? [] : [window(remaining)], note: "" });
const settings = { ring: "shown", saveProgress: "ask" };

test("the ring reads the account the next message uses, not the tightest one anywhere", () => {
  const rows = [row("chatgpt-gpt-6-sol", "primary", true, 70), row("chatgpt-gpt-6-sol", "second", false, 0), row("other", null, false, 5)];
  const glance = glanceFrom({ rows, summary: "", empty: false }, settings, 0, Date.now(), undefined, "chatgpt-gpt-6-sol");
  assert.equal(glance.tightest.accountLabel, "primary");
  assert.equal(glance.tightest.percentLeft, 70);
});

test("when the account in use has not said, the ring says nothing rather than show another account", () => {
  const rows = [row("chatgpt-gpt-6-sol", "primary", true, null), row("chatgpt-gpt-6-sol", "second", false, 0)];
  const glance = glanceFrom({ rows, summary: "", empty: false }, settings, 0, Date.now(), undefined, "chatgpt-gpt-6-sol");
  assert.equal(glance.tightest, null);
});

test("with no connection in use known, or none of its rows, it is the tightest as before", () => {
  const rows = [row("a", null, false, 40), row("b", null, false, 10)];
  assert.deepEqual(nextRows(rows, null), rows);
  assert.deepEqual(nextRows(rows, "missing"), rows);
  assert.equal(glanceFrom({ rows, summary: "", empty: false }, settings, 0, Date.now()).tightest.connection, "b");
});
