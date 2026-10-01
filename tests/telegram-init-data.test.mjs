import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyTelegramLaunch, TelegramLaunchRefusal } from "../dist/channels/telegram-init-data.js";
const token = "1234:TEST-fake-token", now = 1_800_000_000;
function signed(change = {}, signingToken = token) {
  const pairs = Object.entries({ query_id: "launch-1", auth_date: String(now), user: JSON.stringify({ id: 42, first_name: "Owner" }), ...change });
  const check = [...pairs].sort().map(([k,v]) => `${k}=${v}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(signingToken).digest();
  return new URLSearchParams([...pairs, ["hash", createHmac("sha256", key).update(check).digest("hex")]]).toString();
}
test("signed launch verifies exact bot, owner id, age and newer signature field", () => {
  const raw = signed({ signature: "signed-field-from-Telegram" });
  const result = verifyTelegramLaunch(raw, token, now);
  assert.equal(result.senderId, "42"); assert.equal(result.authDate, now);
  assert.match(result.hash, /^[a-f0-9]{64}$/);
  assert.equal(verifyTelegramLaunch(signed({ auth_date: String(now-180), chat_type: "private" }), token, now).senderId, "42");
});
test("changing signed user, bot token or signature is refused", () => {
  const raw = signed(), parsed = new URLSearchParams(raw);
  parsed.set("user", JSON.stringify({ id: 77 }));
  assert.throws(() => verifyTelegramLaunch(parsed.toString(), token, now), TelegramLaunchRefusal);
  assert.throws(() => verifyTelegramLaunch(raw, "another-token", now), TelegramLaunchRefusal);
  const extra = new URLSearchParams(signed({ signature: "real" })); extra.set("signature", "forged");
  assert.throws(() => verifyTelegramLaunch(extra.toString(), token, now), TelegramLaunchRefusal);
});
for (const [label, change] of [
  ["expired", { auth_date: String(now-181) }], ["future", { auth_date: String(now+6) }],
  ["bot user", { user: JSON.stringify({ id: 42, is_bot: true }) }],
  ["group launch", { chat_type: "group" }], ["supergroup data", { chat: JSON.stringify({ id: -42, type: "supergroup" }) }],
  ["invalid user", { user: "{broken" }], ["unsafe id", { user: JSON.stringify({ id: 9007199254740992 }) }],
]) test(`signed ${label} cannot authorize a screen session`, () => {
  assert.throws(() => verifyTelegramLaunch(signed(change), token, now), TelegramLaunchRefusal);
});
test("duplicate fields, malformed encodings, missing hashes and oversized launches are refused", () => {
  const raw = signed();
  for (const malformed of [raw+"&user=%7B%22id%22%3A77%7D", raw+"&auth_date="+now, raw+"&hash="+"a".repeat(64), raw+"&bad=%GG", "user=42", "a".repeat(8193)])
    assert.throws(() => verifyTelegramLaunch(malformed, token, now), TelegramLaunchRefusal);
  assert.throws(() => verifyTelegramLaunch(raw, token, NaN), TelegramLaunchRefusal);
});
