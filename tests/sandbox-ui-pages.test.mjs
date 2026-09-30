// UI-263 / UP-RESEARCH-018: plugin pages sit in named slots and are shown only inside the no-script frame; a saved reply's
// HTML block opens read-only, and its scripts run only after the owner approves that exact preview.
import test from "node:test";
import assert from "node:assert/strict";
import { PluginPageSlots } from "../dist/plugin-page-slots.js";
import { SandboxUiPages, replyCanvas } from "../dist/sandbox-ui-pages.js";

const session = "0f8c2d4e-1b2a-4c3d-9e8f-123456789abc";
const page = (extra = {}) => ({ id: "notes", sessionId: session, slot: "conversation-aside", title: "Notes", html: "<p>hi</p>", ...extra });

test("page slots keep good entries, name them for their plugin, and drop bad ones on their own", () => {
  const slots = new PluginPageSlots();
  const left = slots.register("helper", "Helper", [page(), page({ id: "notes" }), page({ id: "x", slot: "anywhere" }), page({ id: "y", html: "<script>" + "a".repeat(40001) + "</script>" })]);
  assert.equal(left.length, 3);
  assert.deepEqual(slots.list(session, () => true).map((p) => [p.id, p.pluginName]), [["helper:notes", "Helper"]]);
  assert.deepEqual(slots.list(session, () => false), [], "a plugin switched off shows nothing");
  slots.forget("helper");
  assert.deepEqual(slots.list(session, () => true), []);
});

test("a saved reply's HTML opens read-only first; scripts need the owner's yes on that same preview", () => {
  const reply = "Here:\n```html\n<button>go</button>\n```\n";
  assert.equal(replyCanvas(reply), "<button>go</button>");
  assert.equal(replyCanvas("no block"), null);
  const store = { profiles: { requireOwner() {} }, ownsSession: (_o, id) => id === session, get: () => undefined,
    sessionView: () => ({ messages: [{ messageId: 4, role: "assistant", content: reply }] }) };
  const pages = new SandboxUiPages(store, () => "owner", { pageContributions: () => [] }, () => true);
  const preview = pages.open({ sessionId: session, messageId: 4 });
  assert.equal(preview.scripts, false);
  assert.equal(preview.html, undefined, "a read-only preview hands no HTML to the window");
  assert.throws(() => pages.open({ sessionId: session, messageId: 4, scripts: true }), /must approve/);
  assert.throws(() => pages.open({ sessionId: session, messageId: 4, scripts: true, confirmed: true }), /Preview this saved reply again/);
  const run = pages.open({ sessionId: session, messageId: 4, scripts: true, confirmed: true, previewCapability: preview.capability });
  assert.equal(run.scripts, true);
  assert.ok(pages.page(run.capability), "the scripted frame is served once");
  assert.equal(pages.page(run.capability), null, "and never again");
  assert.throws(() => pages.open({ sessionId: "11111111-2222-4333-8444-555555555555", messageId: 4 }), /not found/);
});
