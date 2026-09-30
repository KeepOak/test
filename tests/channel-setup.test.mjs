/**
 * mac7/connect: the recipes for setting up every chat app, the package managers on each system (with
 * fakes), the token check (with a fake service), the square codes, the one-time paste page, and the
 * owner-only save. Nothing here installs, opens, or reaches a real chat service.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { recipes, recipeFor, supportedChannels, createLink } from "../dist/channel-setup/recipes.js";
import { installArgs, isInstalled, openCommand, planInstall } from "../dist/channel-setup/platform.js";
import { cleanServer, readValues, runCheck, scrub } from "../dist/channel-setup/check.js";
import { entryLine, qrFor, saveSetup, saveSetupMode, setupMode, setupPanel } from "../dist/channel-setup/service.js";
import { openPastePage } from "../dist/channel-setup/paste-page.js";
import { encodeQr } from "../dist/remote/qr.js";
import { telegramSecretName } from "../dist/never-break/telegram-setup.js";
import { paritySwitch } from "../dist/channels/parity-switch.js";
import { jsQr, readCode } from "./qr-reader.mjs";

const root = join(import.meta.dirname, "..");
const telegramToken = `123456789:${"A".repeat(35)}`;

/* ---------- the recipes ---------- */

test("every channel Branch supports has exactly one recipe, and there are 56", () => {
  const supported = supportedChannels().map((channel) => channel.id).sort();
  const written = recipes().map((recipe) => recipe.id).sort();
  assert.deepEqual(written, supported);
  assert.equal(written.length, 56);
  for (const channel of supportedChannels()) assert.equal(recipeFor(channel.id).family, channel.family, channel.id);
});

test("a recipe with nothing to install, no bot page or no check says why, in words", () => {
  for (const recipe of recipes()) {
    assert.ok(recipe.app || recipe.noApp?.length > 20, `${recipe.id}: app or reason`);
    assert.ok(recipe.create || recipe.noCreate?.length > 20, `${recipe.id}: create link or reason`);
    assert.ok(recipe.check || recipe.noCheck?.length > 20, `${recipe.id}: check or reason`);
    if (!recipe.create) assert.ok((recipe.steps ?? []).length > 0 || recipe.fields.length === 0 || recipe.id === "imessage", `${recipe.id}: plain steps`);
  }
});

/* Only vendor-verified Flathub apps and verified Snap publishers (checked 2026-09-17), never a community repackage. */
const VERIFIED_FLATPAK = new Set(["org.telegram.desktop", "com.discordapp.Discord", "org.zulip.Zulip", "chat.delta.desktop", "info.mumble.Mumble", "chat.simplex.simplex"]);
const VERIFIED_SNAP = new Set(["telegram-desktop", "slack", "rocketchat-desktop"]);

test("only official packages and official store pages are named", () => {
  for (const recipe of recipes()) {
    if (recipe.app?.flatpak) assert.ok(VERIFIED_FLATPAK.has(recipe.app.flatpak), `${recipe.id}: ${recipe.app.flatpak}`);
    if (recipe.app?.snap) assert.ok(VERIFIED_SNAP.has(recipe.app.snap), `${recipe.id}: ${recipe.app.snap}`);
    for (const url of Object.values(recipe.stores ?? {}))
      assert.match(url, /^https:\/\/(apps\.apple\.com\/app\/id\d+|play\.google\.com\/store\/apps\/details\?id=[\w.]+|f-droid\.org\/packages\/[\w.]+\/)$/, recipe.id);
  }
  assert.equal(recipeFor("mumble").app.brew, undefined, "Homebrew's Mumble cask is disabled");
  assert.equal(recipeFor("signal").create, undefined, "signal-cli is not Signal's and is never installed");
});

test("Telegram opens BotFather with /newbot typed, and Slack's page arrives filled in", () => {
  const telegram = recipeFor("telegram");
  assert.equal(telegram.create.url, "https://t.me/BotFather?text=%2Fnewbot");
  assert.equal(telegram.create.app, "tg://resolve?domain=BotFather&text=%2Fnewbot");
  assert.equal(telegram.paste[0].secret, telegramSecretName, "the same locker entry as the Telegram card");
  const slack = createLink(recipeFor("slack"));
  assert.match(slack, /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
  const manifest = JSON.parse(decodeURIComponent(slack.split("manifest_json=")[1]));
  assert.equal(manifest.settings.socket_mode_enabled, true);
  assert.ok(manifest.oauth_config.scopes.bot.includes("chat:write"));
  assert.equal(createLink(recipeFor("mastodon")), null, "a self-hosted page waits for the server");
  assert.equal(createLink(recipeFor("mastodon"), "https://social.example/"), "https://social.example/settings/applications/new");
});

test("a secret only ever sits in an address where the vendor's API requires it (Telegram)", () => {
  for (const recipe of recipes()) {
    const names = new Set([...recipe.fields.map((field) => field.name), ...recipe.paste.map((paste) => paste.secret)]);
    const check = recipe.check;
    if (!check) continue;
    const inUrl = [...check.url.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]);
    for (const name of inUrl) assert.ok(names.has(name), `${recipe.id}: ${name} is asked for`);
    if (check.auth.kind === "path") assert.equal(recipe.id, "telegram");
    else assert.ok(inUrl.every((name) => !/^[A-Z]/.test(name)), `${recipe.id}: no secret in the address`);
    if (check.url.includes("{{server}}") || recipe.create?.url.includes("{{server}}")) assert.ok(names.has("server"), `${recipe.id}: asks for the server`);
    for (const value of [...Object.values(check.body ?? {}), ...Object.values(check.headers ?? {}), check.auth.user ?? ""])
      for (const [, name] of value.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(names.has(name), `${recipe.id}: ${name}`);
  }
});

test("the connections line names the right type, and every sentence has real French", async () => {
  const en = JSON.parse(await readFile(join(root, "public/locales/en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(root, "public/locales/fr.json"), "utf8"));
  for (const recipe of recipes()) {
    if (recipe.entry) {
      assert.equal(recipe.entry.type, recipe.family === "chat" ? "chat" : recipe.id, recipe.id);
      if (recipe.family === "chat") assert.equal(recipe.entry.service, recipe.id);
    }
    const parts = [recipe.create && "how", recipe.noApp && "noApp", recipe.noCreate && "noCreate", recipe.noCheck && "noCheck",
      ...recipe.fields.map((field) => `field-${field.name}`), ...recipe.paste.map((paste) => `paste-${paste.secret}`)].filter(Boolean);
    for (const part of parts) {
      const key = `channel-setup.r.${recipe.id}.${part}`;
      assert.ok(en[key] && fr[key] && en[key] !== fr[key], key);
    }
  }
});

/* ---------- each system's package manager, with fakes ---------- */

function fakeProbe({ programs = [], files = [] } = {}) {
  return { home: "/Users/owner", which: async (name) => (programs.includes(name) ? `/bin/${name}` : null), exists: async (path) => files.includes(path) };
}

test("Windows uses winget, a Mac Homebrew, Linux Flatpak then Snap (with sudo said)", async () => {
  const telegram = recipeFor("telegram");
  assert.deepEqual(await planInstall(telegram, "win32", fakeProbe({ programs: ["winget"] })),
    { kind: "package", manager: "winget", command: "winget", args: ["install", "--exact", "--id", "Telegram.TelegramDesktop", "--source", "winget"], sudo: false });
  assert.deepEqual(await planInstall(telegram, "darwin", fakeProbe({ programs: ["brew"] })),
    { kind: "package", manager: "brew", command: "brew", args: ["install", "--cask", "telegram"], sudo: false });
  assert.deepEqual(await planInstall(telegram, "linux", fakeProbe({ programs: ["flatpak", "snap"] })),
    { kind: "package", manager: "flatpak", command: "flatpak", args: ["install", "--user", "flathub", "org.telegram.desktop"], sudo: false });
  assert.deepEqual(await planInstall(telegram, "linux", fakeProbe({ programs: ["snap"] })),
    { kind: "package", manager: "snap", command: "sudo", args: ["snap", "install", "telegram-desktop"], sudo: true });
  const bare = await planInstall(telegram, "darwin", fakeProbe());
  assert.equal(bare.kind, "download");
  assert.equal(bare.url, "https://desktop.telegram.org/");
  assert.match(bare.reason, /Homebrew is not on this computer/);
  assert.equal((await planInstall(recipeFor("line"), "win32", fakeProbe({ programs: ["winget"] }))).kind, "download", "no official package: the page");
  assert.equal((await planInstall(recipeFor("email"), "linux", fakeProbe())).kind, "nothing");
  assert.equal((await planInstall(telegram, "freebsd", fakeProbe({ programs: ["brew"] }))).kind, "download");
  assert.deepEqual(installArgs("brew", "slack").args, ["install", "--cask", "slack"]);
});

test("whether the app is already there is asked of the system's own tools", async () => {
  const runs = [];
  const runner = (answers) => ({ run: async (command, args) => { runs.push([command, ...args]); return answers[command] ?? { code: 1, stdout: "" }; } });
  const telegram = recipeFor("telegram");
  assert.equal(await isInstalled(telegram, "darwin", fakeProbe({ files: ["/Users/owner/Applications/Telegram.app"] }), runner({})), true);
  assert.equal(await isInstalled(telegram, "darwin", fakeProbe(), runner({})), false);
  assert.equal(await isInstalled(telegram, "win32", fakeProbe({ programs: ["winget"] }), runner({ winget: { code: 0, stdout: "Telegram.TelegramDesktop 5.0" } })), true);
  assert.equal(await isInstalled(telegram, "win32", fakeProbe({ programs: ["winget"] }), runner({ winget: { code: 0, stdout: "No installed package found" } })), false);
  assert.equal(await isInstalled(telegram, "linux", fakeProbe({ programs: ["flatpak"] }), runner({ flatpak: { code: 0, stdout: "" } })), true);
  assert.equal(await isInstalled(telegram, "win32", fakeProbe(), runner({})), null, "no winget: cannot tell");
  assert.deepEqual(runs.slice(0, 1), [["winget", "list", "--exact", "--id", "Telegram.TelegramDesktop"]]);
});

test("only official https and Telegram links are opened, with each system's own opener", () => {
  assert.deepEqual(openCommand("https://t.me/BotFather?text=%2Fnewbot", "darwin"), { command: "open", args: ["https://t.me/BotFather?text=%2Fnewbot"] });
  assert.deepEqual(openCommand("tg://resolve?domain=BotFather&text=%2Fnewbot", "win32"),
    { command: "rundll32", args: ["url.dll,FileProtocolHandler", "tg://resolve?domain=BotFather&text=%2Fnewbot"] });
  assert.deepEqual(openCommand("https://discord.com/developers/applications", "linux"), { command: "xdg-open", args: ["https://discord.com/developers/applications"] });
  for (const bad of ["http://example.com", "file:///etc/passwd", "javascript:alert(1)", "https://x.test/a b", "https://x.test/\"&calc"])
    assert.throws(() => openCommand(bad, "win32"), /only opens official/);
});

/* ---------- checking what was pasted, with a fake service ---------- */

function fakeService(answer) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url: String(url), init }); return typeof answer === "function" ? answer(String(url), init) : answer; };
  return { fetch, calls };
}

test("Telegram's token is checked with getMe, and a refusal never repeats it", async () => {
  const telegram = recipeFor("telegram");
  const values = readValues(telegram, { TELEGRAM_BOT_TOKEN: ` ${telegramToken} ` });
  const good = fakeService(Response.json({ ok: true, result: { username: "owner_helper_bot" } }));
  assert.deepEqual(await runCheck(telegram, values, good.fetch), { ok: true, name: "owner_helper_bot" });
  assert.equal(good.calls[0].url, `https://api.telegram.org/bot${telegramToken}/getMe`);
  assert.equal(good.calls[0].init.redirect, "error");
  const refused = await runCheck(telegram, values, fakeService(Response.json({ ok: false }, { status: 401 })).fetch);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /did not accept that \(it answered 401\)/);
  const broken = await runCheck(telegram, values, async (url) => { throw new Error(`connect failed for ${url}`); });
  assert.equal(broken.ok, false);
  assert.ok(!broken.reason.includes(telegramToken) && !broken.reason.includes("AAAAAAAA"), broken.reason);
  assert.throws(() => readValues(telegram, { TELEGRAM_BOT_TOKEN: "not a token" }), (error) => error.status === 400 && !/not a token/.test(error.message));
  assert.throws(() => readValues(telegram, {}), /is missing/);
});

test("other checks put the token in a header, never the address, and read the vendor's answer", async () => {
  const discord = fakeService(Response.json({ id: "1", username: "helper" }));
  const token = "discord-token-value-1234567890";
  assert.deepEqual(await runCheck(recipeFor("discord"), { DISCORD_BOT_TOKEN: token }, discord.fetch), { ok: true, name: "helper" });
  assert.equal(discord.calls[0].url, "https://discord.com/api/v10/users/@me");
  assert.equal(discord.calls[0].init.headers.authorization, `Bot ${token}`);
  const viber = fakeService(Response.json({ status: 2, status_message: "invalidAuthToken" }));
  assert.equal((await runCheck(recipeFor("viber"), { VIBER_AUTH_TOKEN: token }, viber.fetch)).ok, false, "status must be 0");
  assert.equal(viber.calls[0].init.headers["X-Viber-Auth-Token"], token);
  const mastodon = recipeFor("mastodon");
  const values = readValues(mastodon, { server: "https://social.example/", MASTODON_ACCESS_TOKEN: token });
  const seen = fakeService(Response.json({ id: "9", acct: "helper" }));
  await runCheck(mastodon, values, seen.fetch);
  assert.equal(seen.calls[0].url, "https://social.example/api/v1/accounts/verify_credentials");
  const pushover = fakeService(Response.json({ status: 1 }));
  const keys = { PUSHOVER_APP_TOKEN: "a".repeat(30), PUSHOVER_USER_KEY: "u".repeat(30) };
  assert.equal((await runCheck(recipeFor("pushover"), keys, pushover.fetch)).ok, true);
  assert.equal(pushover.calls[0].url, "https://api.pushover.net/1/users/validate.json");
  assert.match(pushover.calls[0].init.body, /^token=a+&user=u+$/);
  assert.deepEqual(await runCheck(recipeFor("whatsapp"), {}, pushover.fetch).then((result) => result.ok), null, "no safe check: said, not guessed");
});

test("a server address must be plain https", () => {
  assert.equal(cleanServer("https://chat.example.org/team/"), "https://chat.example.org/team");
  for (const bad of ["http://chat.example.org", "https://user:pw@chat.example.org", "https://chat.example.org/?next=x", "chat.example.org", "javascript:alert(1)"])
    assert.throws(() => cleanServer(bad), (error) => error.status === 400);
  assert.equal(scrub(`failed for https://api.telegram.org/bot${telegramToken}/getMe`, { TELEGRAM_BOT_TOKEN: telegramToken }), "failed for https://api.telegram.org/bot…/getMe");
});

/* ---------- square codes ---------- */

test("the square codes read back as the links they were made from", async () => {
  const links = [recipeFor("telegram").create.url, recipeFor("telegram").stores.ios, recipeFor("discord").stores.android,
    createLink(recipeFor("pushover")), recipeFor("wechat-mp").stores.android];
  const decoder = await jsQr();
  for (const link of links) {
    const code = qrFor(link);
    assert.ok(code, link);
    const modules = code.rows.map((row) => [...row].map((bit) => bit === "1"));
    assert.equal(readCode(modules), link);
    if (decoder) {
      const scale = 4, quiet = 4, width = (code.size + quiet * 2) * scale;
      const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
      modules.forEach((row, y) => row.forEach((dark, x) => {
        if (!dark) return;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          const at = (((y + quiet) * scale + dy) * width + (x + quiet) * scale + dx) * 4;
          pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
        }
      }));
      assert.equal(decoder(pixels, width, width)?.data, link, "jsQR agrees");
    }
  }
  assert.deepEqual(qrFor(recipeFor("telegram").create.url), { size: 29, rows: encodeQr(recipeFor("telegram").create.url).modules.map((row) => row.map((d) => (d ? "1" : "0")).join("")) });
  assert.equal(qrFor(createLink(recipeFor("slack"))), null, "too long for a code");
  const slack = setupPanel({ get: () => undefined }, "local", "slack");
  assert.equal(readCode(slack.codes.create.rows.map((row) => [...row].map((bit) => bit === "1"))), "https://api.slack.com/apps?new_app=1",
    "Slack's code falls back to the plain page");
});

/* ---------- the one-time paste page ---------- */

test("the paste page lives on 127.0.0.1, carries no token in its address, and takes one form from itself", async () => {
  const telegram = recipeFor("telegram");
  const page = await openPastePage(telegram, 10_000);
  assert.match(page.url, /^http:\/\/127\.0\.0\.1:\d+\/paste\/[a-f0-9]{48}$/);
  const html = await (await fetch(page.url)).text();
  assert.match(html, /type="password" name="TELEGRAM_BOT_TOKEN"/);
  const nonce = /name="nonce" value="([a-f0-9]+)"/.exec(html)[1];
  const origin = new URL(page.url).origin;
  const post = (body, headers = {}) => fetch(page.url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });
  assert.equal((await fetch(`${origin}/paste/other`)).status, 404);
  assert.equal((await post(`nonce=${nonce}&TELEGRAM_BOT_TOKEN=x`, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(`nonce=wrong&TELEGRAM_BOT_TOKEN=x`)).status, 403);
  const sent = await post(new URLSearchParams({ nonce, TELEGRAM_BOT_TOKEN: telegramToken }).toString(), { origin });
  assert.equal(sent.status, 200);
  assert.ok(!(await sent.text()).includes(telegramToken));
  assert.deepEqual(await page.values, { TELEGRAM_BOT_TOKEN: telegramToken });
  await assert.rejects(fetch(page.url), "closed after one use");
});

/* ---------- saving: off by default, the owner's, the locker ---------- */

async function freshApp(t, server = false) {
  const folder = await mkdtemp(join(tmpdir(), "branch-connect-"));
  const dataDir = join(folder, "data");
  const { createBranch } = await import("../dist/index.js");
  const { startServer } = await import("../dist/server.js");
  const app = await createBranch({ workspace: join(folder, "workspace"), dataDir });
  const served = server ? await startServer(app, { dataDir, port: 0 }) : null;
  t.after(async () => { await served?.close(); await app.close(); await discardTemp(folder); });
  return { app, server: served };
}

test("saving is off until switched on, then the token goes to the locker and the switch only moves when asked", async (t) => {
  const { app } = await freshApp(t);
  const owner = app.runtime.owner;
  const service = fakeService(Response.json({ ok: true, result: { username: "owner_helper_bot" } }));
  const telegramCalls = [];
  const host = { store: app.store, owner, fetch: service.fetch,
    telegram: { save: async (input) => { telegramCalls.push(input); }, connect: async () => null } };
  assert.equal(setupMode(app.store, owner), "off");
  await assert.rejects(saveSetup(host, "telegram", { values: { TELEGRAM_BOT_TOKEN: telegramToken } }), (error) => error.status === 409);
  assert.equal(service.calls.length, 0, "nothing was asked while off");
  saveSetupMode(app.store, owner, { mode: "when-needed" });
  const answer = await saveSetup(host, "telegram", { values: { TELEGRAM_BOT_TOKEN: telegramToken }, enable: "on" });
  assert.deepEqual(telegramCalls, [{ token: telegramToken, mode: "on" }], "the Telegram card's own save");
  assert.equal(answer.botName, "owner_helper_bot");
  assert.ok(!JSON.stringify(answer).includes(telegramToken), "never sent back");

  const bluesky = await saveSetup(host, "bluesky", { values: { handle: "helper.bsky.social", BLUESKY_APP_PASSWORD: "abcd-efgh-ijkl-mnop" } });
  assert.equal(bluesky.checked, null);
  assert.equal(paritySwitch(app.store, owner, "bluesky"), "off", "not switched on without being asked");
  const kept = await app.store.secrets.resolve(owner, "default", ["BLUESKY_APP_PASSWORD"], { purpose: "channel" });
  assert.equal(kept.BLUESKY_APP_PASSWORD, "abcd-efgh-ijkl-mnop");
  assert.match(bluesky.entry, /"handle":"helper\.bsky\.social"/);
  await saveSetup(host, "bluesky", { values: { handle: "helper.bsky.social", BLUESKY_APP_PASSWORD: "abcd-efgh-ijkl-mnop" }, enable: "when-needed" });
  assert.equal(paritySwitch(app.store, owner, "bluesky"), "when-needed");

  const refusing = { ...host, fetch: fakeService(Response.json({ message: "401: Unauthorized" }, { status: 401 })).fetch };
  await assert.rejects(saveSetup(refusing, "discord", { values: { DISCORD_BOT_TOKEN: "wrong-token-123456" } }),
    (error) => error.status === 422 && !error.message.includes("wrong-token"));
  const names = app.store.secrets.list(owner, "default").map((secret) => secret.name);
  assert.ok(!names.includes("DISCORD_BOT_TOKEN"), "a refused token is not kept");
  assert.equal(setupPanel(app.store, owner, "bluesky").saved.switched, "when-needed");
});

test("the connections line fills in the owner's settings and numbers", () => {
  assert.equal(entryLine(recipeFor("vk"), { groupId: "12345" }), '{"type":"vk","id":"vk","groupId":12345}');
  assert.equal(entryLine(recipeFor("matrix"), { server: "https://matrix.example", userId: "@b:matrix.example" }),
    '{"type":"matrix","id":"matrix","homeserver":"https://matrix.example","userId":"@b:matrix.example"}');
  assert.equal(entryLine(recipeFor("zulip"), {}), '{"type":"chat","service":"zulip","id":"zulip","tokenSecret":"ZULIP_BOT_API_KEY","apiBase":"…"}');
  assert.equal(entryLine(recipeFor("telegram"), {}), null);
});

test("the routes: anyone with the app's key may look, only the owner may save, and a short-lived key is refused", async (t) => {
  const { app, server } = await freshApp(t, true);
  const call = (method, path, body, token = server.token) => fetch(server.url + path, { method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  const list = await call("GET", "/api/channel-setup");
  assert.deepEqual([list.status, list.body.mode, list.body.count], [200, "off", 56]);
  const panel = await call("GET", "/api/channel-setup/telegram");
  assert.equal(panel.body.command.posix, "branch connect telegram");
  assert.equal(panel.body.codes.ios.size > 20, true);
  assert.equal((await call("GET", "/api/channel-setup/nothing-like-it")).status, 404);
  const off = await call("POST", "/api/channel-setup/telegram/check", { values: { TELEGRAM_BOT_TOKEN: telegramToken } });
  assert.equal(off.status, 409, "shipped off");
  const key = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 5 });
  const byKey = await call("POST", "/api/channel-setup", { mode: "on" }, key.token);
  assert.equal(byKey.status, 401);
  assert.match(byKey.body.error, /cannot save a chat app's token/);
  assert.equal((await call("GET", "/api/channel-setup", undefined, key.token)).status, 200, "a key may look");
  assert.equal((await call("POST", "/api/channel-setup", { mode: "sideways" })).status, 400);
  assert.equal((await call("POST", "/api/channel-setup", { mode: "on" })).body.mode, "on");
  const bad = await call("POST", "/api/channel-setup/telegram/check", { values: { TELEGRAM_BOT_TOKEN: "nope" } });
  assert.equal(bad.status, 400, "refused before anything is asked of Telegram");
  assert.ok(!JSON.stringify(bad.body).includes("nope"));
  assert.equal((await call("POST", "/api/channel-setup/telegram/check", { values: {}, extra: 1 })).status, 400);
});

test("the setup table in the docs is the one the recipes write (node scripts/channel-setup-table.mjs)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { renderSetupTable, replaceSetupTable } = await import("../scripts/channel-setup-table.mjs");
  const root = new URL("..", import.meta.url);
  const book = JSON.parse(await readFile(new URL("data/channel-setup.json", root), "utf8"));
  const docs = await readFile(new URL("docs/configuration.md", root), "utf8");
  assert.equal(replaceSetupTable(docs, renderSetupTable(book)), docs, "run node scripts/channel-setup-table.mjs");
  assert.equal(renderSetupTable(book).split("\n").length, 2 + 56);
});

/* ---------- integration review (adversarial pass) ---------- */

test("integration review: a save or switch that fails says why without the token", async (t) => {
  const { app } = await freshApp(t);
  const owner = app.runtime.owner;
  saveSetupMode(app.store, owner, { mode: "on" });
  const leaky = (where) => async () => { throw new Error(`${where} failed for https://api.telegram.org/bot${telegramToken}/getMe and ${telegramToken}`); };
  for (const telegram of [{ save: leaky("save") }, { save: async () => undefined, connect: leaky("connect") }]) {
    const service = fakeService(Response.json({ ok: true, result: { username: "owner_helper_bot" } }));
    const host = { store: app.store, owner, fetch: service.fetch, telegram };
    await assert.rejects(saveSetup(host, "telegram", { values: { TELEGRAM_BOT_TOKEN: telegramToken }, enable: "on" }),
      (error) => typeof error.status === "number" && /failed/.test(error.message) && !error.message.includes(telegramToken)
        && !error.message.includes(telegramToken.split(":")[1]));
  }
});

test("integration review: the Windows install line is written for both Command Prompt and PowerShell", async () => {
  const docs = await readFile(join(root, "docs", "configuration.md"), "utf8");
  const paragraph = docs.slice(docs.indexOf("Nothing is piped from the internet."), docs.indexOf("**Official means only.**"));
  assert.match(paragraph, /Command Prompt: `"Install Branch Agent\.cmd" \/quiet`/);
  // PowerShell only runs a quoted path with the call operator, and never from the current folder without .\
  assert.match(paragraph, /PowerShell: `& '\.\\Install Branch Agent\.cmd' \/quiet`/);
});
