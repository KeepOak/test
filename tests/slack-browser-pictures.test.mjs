/* SCREEN-107 (Slack): the task browser's picture is shown in the owner's Slack direct message and replaced in place as
   the page changes. It is uploaded privately (never shared into a channel), only into a real one-to-one DM, and an
   unchanged picture is not uploaded again. Stand-in Slack only. */
import test from "node:test";
import assert from "node:assert/strict";
import { SlackAdapter } from "../dist/index.js";

const png = (n) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from([n])]);
function slack({ info = { id: "D1", is_im: true, user: "U1" } } = {}) {
  const calls = [];
  let files = 0;
  const reply = (body) => new Response(JSON.stringify(body));
  const adapter = new SlackAdapter({ id: "slack", token: "stand-in-bot", appToken: "stand-in-app", apiBase: "http://slack.test/api",
    fetch: async (url, init) => {
      const address = String(url), method = address.split("/").pop();
      if (address.startsWith("https://files.slack.com/")) { calls.push({ method: "upload" }); return new Response("ok"); }
      const body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(String(init.body)));
      calls.push({ method, body });
      if (method === "conversations.info") return reply({ ok: true, channel: info });
      if (method === "files.getUploadURLExternal") return reply({ ok: true, upload_url: `https://files.slack.com/upload/v1/${++files}`, file_id: `F${files}` });
      return reply({ ok: true, ts: "111.222" });
    } });
  return { adapter, calls };
}
const picture = (n) => ({ name: "screen.png", mediaType: "image/png", bytes: png(n), caption: "The page now" });
const named = (calls, method) => calls.filter((call) => call.method === method);

test("SCREEN-107: a picture goes privately into the DM as an image block, and is replaced in place", async () => {
  const { adapter, calls } = slack();
  const ts = await adapter.sendPicture("D1", picture(1), [{ label: "Stop", value: "stop" }]);
  assert.equal(ts, "111.222");
  assert.equal(named(calls, "files.completeUploadExternal")[0].body.channel_id, undefined, "the file is never shared into a channel");
  const posted = named(calls, "chat.postMessage")[0].body;
  assert.deepEqual(posted.blocks[0].slack_file, { id: "F1" });
  assert.equal(posted.blocks[2].elements[0].value, "stop");
  await adapter.editPicture("D1", ts, picture(1), []);
  assert.equal(named(calls, "upload").length, 1, "the same picture is not uploaded again");
  await adapter.editPicture("D1", ts, picture(2), []);
  assert.equal(named(calls, "upload").length, 2);
  assert.deepEqual(named(calls, "chat.update").at(-1).body.blocks[0].slack_file, { id: "F2" });
  assert.deepEqual(named(calls, "files.delete").map((call) => call.body.file), ["F1"], "the old private picture is removed");
});

test("SCREEN-107: anything but a one-to-one DM, or a file that is not a small picture, gets no picture", async () => {
  for (const info of [{ id: "C1", is_im: false, user: "U1" }, { id: "D1", is_im: true, user: "U1", num_members: 3 }]) {
    const { adapter, calls } = slack({ info });
    await assert.rejects(adapter.sendPicture(info.id, picture(1), []));
    assert.equal(named(calls, "upload").length, 0, JSON.stringify(info));
  }
  const { adapter } = slack({ info: { id: "D1", is_im: true, user: "U1", num_members: 2 } });
  assert.ok(await adapter.sendPicture("D1", picture(1), []), "a member count of two is fine when Slack gives one");
  await assert.rejects(adapter.sendPicture("D1", { ...picture(1), mediaType: "application/pdf" }, []), /supported images/);
});
