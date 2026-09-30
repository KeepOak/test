/* PLAT-162: an automatic problem report is sent only under the consent that is in force when it is sent. If the owner
   turns reports off, or Branch is locked, while a report is being gathered, nothing is sent and a changed consent is
   not retried. Stand-in delivery functions only. */
import test from "node:test";
import assert from "node:assert/strict";
import { AutomaticProblemReports, AutomaticProblemReportSettingsSchema } from "../dist/automatic-problem-reports.js";

const on = AutomaticProblemReportSettingsSchema.parse({ mode: "on", destination: { kind: "channel", channel: "discord", chatId: "owner-room" }, items: ["about"] });

function reporter({ during = () => {}, requireDelivery } = {}) {
  let settings = on;
  const delivered = [], recorded = [];
  const service = new AutomaticProblemReports({
    settings: () => settings,
    linkedChannels: () => [{ channel: "discord", chatId: "owner-room" }],
    gather: async () => { settings = during(settings) ?? settings; return [{ id: "about", title: "About", why: "Version", text: "Branch 1" }]; },
    deliverChannel: async (...args) => delivered.push(args),
    createGitHubIssue: async () => assert.fail("GitHub was not chosen"),
    ...(requireDelivery ? { requireDelivery } : {}),
    record: (entry) => recorded.push(entry),
  });
  return { service, delivered, recorded };
}

test("PLAT-162: reports switched off while one is being gathered send nothing, and it is not retried", async () => {
  const { service, delivered, recorded } = reporter({ during: () => AutomaticProblemReportSettingsSchema.parse({ ...on, mode: "off" }) });
  const result = await service.report("crash", "engine stopped", "incident-1");
  assert.equal(result.sent, false);
  assert.equal(result.retryable, false);
  assert.match(result.reason, /settings changed while the report was prepared/);
  assert.deepEqual(delivered, []);
  assert.equal(recorded.at(-1).outcome, "failed");
});

test("PLAT-162: a lock or Lockdown at the moment of sending stops it, and the same consent may try again later", async () => {
  const { service, delivered } = reporter({ requireDelivery: () => { throw new Error("Unlock Branch before automatic problem reports can be sent."); } });
  const result = await service.report("crash", "engine stopped", "incident-2");
  assert.equal(result.sent, false);
  assert.equal(result.retryable, true);
  assert.deepEqual(delivered, []);
});

test("PLAT-162: unchanged consent still sends", async () => {
  let checked = 0;
  const { service, delivered } = reporter({ requireDelivery: () => { checked++; } });
  assert.equal((await service.report("crash", "engine stopped", "incident-3")).sent, true);
  assert.equal(checked, 1);
  assert.equal(delivered.length, 1);
});
