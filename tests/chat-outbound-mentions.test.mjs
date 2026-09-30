import test from "node:test";
import assert from "node:assert/strict";
import { DiscordAdapter, SlackAdapter, toMrkdwn } from "../dist/index.js";

/** A stand-in REST API that keeps each request body, JSON or the payload_json part of a multipart form. */
function recorder(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = init?.body instanceof FormData ? JSON.parse(String(init.body.get("payload_json"))) : init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init?.method, body });
    return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

test("Discord: every message Branch posts or edits may ping only people, never @everyone, @here or a role", async () => {
  const api = recorder({ id: "m1" });
  const discord = new DiscordAdapter({ id: "discord", token: "not-a-real-secret", apiBase: "http://discord.test/api", fetch: api.fetch });
  const words = "@everyone @here <@&123> and <@456>";
  const file = { name: "a.png", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]), caption: words };
  await discord.send("c1", words);
  await discord.send("c1", words, "m0", { quiet: true });
  await discord.sendButtons("c1", words, [{ label: "Yes", value: `y:${"a".repeat(32)}` }]);
  await discord.edit("c1", "m1", words);
  await discord.sendFile("c1", file);
  await discord.sendPicture("c1", file, []);
  await discord.editPicture("c1", "m1", file, []);
  const bodies = api.calls.filter((call) => call.body && "content" in call.body);
  assert.equal(bodies.length, 7, "each send, question, edit, file and picture was made");
  for (const call of bodies)
    assert.deepEqual(call.body.allowed_mentions, { parse: ["users"], replied_user: true }, `${call.method} ${call.url}`);
  assert.equal(bodies[0].body.content, words, "the words themselves are left as written");
});

test("Slack: model text cannot ping the channel or disguise a link", async () => {
  const api = recorder({ ok: true, ts: "1.2" });
  const slack = new SlackAdapter({ id: "slack", token: "not-a-real-secret", appToken: "not-a-real-secret", apiBase: "http://slack.test/api", fetch: api.fetch });
  await slack.send("C1", "<!channel> hi");
  await slack.edit("C1", "1.2", "<!here> hi");
  await slack.sendButtons("C1", "<!everyone> ok?", [{ label: "Yes", value: `y:${"a".repeat(32)}` }]);
  assert.equal(api.calls[0].body.text, "&lt;!channel&gt; hi");
  assert.equal(api.calls[1].body.text, "&lt;!here&gt; hi");
  assert.equal(api.calls[2].body.text, "&lt;!everyone&gt; ok?");
  assert.equal(api.calls[2].body.blocks[0].text.text, "&lt;!everyone&gt; ok?", "the question's mrkdwn block too");
  for (const call of api.calls) assert.ok(!JSON.stringify(call.body).includes("<!"), "no special mention reaches Slack");

  assert.equal(toMrkdwn("<!subteam^S1> and <https://evil.test|bank.test>"), "&lt;!subteam^S1&gt; and &lt;https://evil.test|bank.test&gt;");
  assert.equal(toMrkdwn("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  assert.equal(toMrkdwn("**bold** and [the docs](https://example.com/a?x=1&y=2)"), "*bold* and <https://example.com/a?x=1&amp;y=2|the docs>");
  assert.equal(toMrkdwn("thanks <@U123ABC>, see <#C0456>"), "thanks <@U123ABC>, see <#C0456>", "a person or channel named by id stays a mention");
  assert.equal(toMrkdwn("> quoted <!channel>\nplain"), "> quoted &lt;!channel&gt;\nplain", "a quote stays a quote");
  assert.equal(toMrkdwn("```\nif (a < b) x()\n```"), "```\nif (a &lt; b) x()\n```");
});
