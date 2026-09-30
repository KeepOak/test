/* SCREEN-107 (Matrix): the task browser's picture goes only into an unencrypted two-member direct room that this
   account's own m.direct names, as an image, and is replaced in place (m.replace). Such a room now counts as a direct
   chat; encrypted or larger rooms stay groups and get no picture. Matrix has no buttons, so it is view-only.
   A stand-in homeserver only. */
import test from "node:test";
import assert from "node:assert/strict";
import { MatrixAdapter } from "../dist/channels/matrix.js";

const me = "@branch:matrix.test", owner = "@owner:matrix.test";
const dm = "!dm:matrix.test", big = "!big:matrix.test", locked = "!locked:matrix.test";
const say = (id) => ({ type: "m.room.message", event_id: `$${id}:matrix.test`, sender: owner, content: { msgtype: "m.text", body: "hello" } });
function homeserver() {
  const calls = [];
  let syncs = 0, made = 0;
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const adapter = new MatrixAdapter({ id: "matrix", homeserver: "https://matrix.test", accessToken: "stand-in-token", userId: me,
    fetch: async (url, options = {}) => {
      const path = decodeURIComponent(new URL(url).pathname);
      calls.push({ path, body: typeof options.body === "string" ? JSON.parse(options.body) : null });
      if (path.endsWith("/sync")) {
        const timeline = ++syncs === 1 ? [] : [say(`a${syncs}`)];
        return reply({ next_batch: `b${syncs}`, account_data: { events: [{ type: "m.direct", content: { [owner]: [dm, locked] } }] },
          rooms: { join: {
            [dm]: { summary: { "m.joined_member_count": 2 }, timeline: { events: timeline } },
            [big]: { summary: { "m.joined_member_count": 3 }, timeline: { events: timeline } },
            [locked]: { summary: { "m.joined_member_count": 2 }, state: { events: [{ type: "m.room.encryption", content: {} }] }, timeline: { events: timeline } },
          } } });
      }
      if (path.endsWith("/joined_members")) return reply({ joined: { [me]: {}, [owner]: {} } });
      if (path.endsWith("/state/m.room.encryption")) return reply({ errcode: "M_NOT_FOUND" }, 404);
      if (path.includes("/media/v3/upload")) return reply({ content_uri: `mxc://matrix.test/pic${++made}` });
      return reply({ event_id: `$sent${++made}:matrix.test` });
    } });
  return { adapter, calls };
}
const picture = (n) => ({ name: "screen.png", mediaType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, n]), caption: "The page now" });

test("SCREEN-107: an unencrypted two-member m.direct room is a direct chat; encrypted or larger rooms stay groups", async () => {
  const { adapter } = homeserver();
  await adapter.sync();
  const kinds = Object.fromEntries((await adapter.sync()).map((message) => [message.chatTitle, message.chatKind]));
  assert.deepEqual(kinds, { [dm]: "direct", [big]: "group", [locked]: "group" });
  assert.equal(adapter.pictureViewOnly, true, "no buttons under a Matrix picture");
});

test("SCREEN-107: the picture goes into the direct room and is replaced in place; other rooms get none", async () => {
  const { adapter, calls } = homeserver();
  await adapter.sync();
  const byTitle = Object.fromEntries((await adapter.sync()).map((message) => [message.chatTitle, message.chatId]));
  const sent = await adapter.sendPicture(byTitle[dm], picture(1), []);
  const first = calls.filter((call) => call.path.includes("/send/m.room.message/")).at(-1).body;
  assert.equal(first.msgtype, "m.image");
  assert.match(first.url, /^mxc:\/\//);
  await adapter.editPicture(byTitle[dm], sent, picture(2), []);
  const edit = calls.filter((call) => call.path.includes("/send/m.room.message/")).at(-1).body;
  assert.equal(edit["m.relates_to"].rel_type, "m.replace");
  assert.equal(edit["m.new_content"].msgtype, "m.image");
  const uploads = calls.filter((call) => call.path.includes("/upload")).length;
  for (const room of [big, locked]) await assert.rejects(adapter.sendPicture(byTitle[room], picture(3), []), /direct room/);
  assert.equal(calls.filter((call) => call.path.includes("/upload")).length, uploads, "nothing is uploaded for a group");
});
